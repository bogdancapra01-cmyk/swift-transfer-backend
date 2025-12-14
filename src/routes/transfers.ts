import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { getUploadsBucket } from "../gcp/storage";
import { firestore } from "../gcp/firestore";
import fetch from "node-fetch";


const router = Router();

/**
 * INIT (create signed upload URLs)
 */
const InitSchema = z.object({
  files: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().optional().default("application/octet-stream"),
        size: z.number().int().nonnegative().optional(),
      })
    )
    .min(1),
});

router.post("/init", async (req, res) => {
  const parsed = InitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const transferId = crypto.randomUUID();
  const createdAt = Date.now();
  const uploadsBucket = getUploadsBucket();

  // upload URLs expiră în 15 minute
  const uploadExpiresAt = Date.now() + 15 * 60 * 1000;

  const uploads = await Promise.all(
    parsed.data.files.map(async (f) => {
      const safeName = f.name.replace(/[^\w.\-()+ ]/g, "_");
      const objectPath = `uploads/${transferId}/${safeName}`;

      const fileRef = uploadsBucket.file(objectPath);

      const [uploadUrl] = await fileRef.getSignedUrl({
        version: "v4",
        action: "write",
        expires: uploadExpiresAt,
        contentType: f.type || "application/octet-stream",
      });

      return {
        name: f.name,
        type: f.type || "application/octet-stream",
        size: f.size ?? null,
        objectPath,
        uploadUrl,
      };
    })
  );

  await firestore.collection("transfers").doc(transferId).set({
    transferId,
    status: "draft",
    createdAt,
    files: uploads.map((u) => ({
      name: u.name,
      type: u.type,
      size: u.size,
      objectPath: u.objectPath,
    })),
  });

  return res.json({
    ok: true,
    transferId,
    uploads,
    expiresAt: uploadExpiresAt,
  });
});

/**
 * COMPLETE (mark transfer ready)
 */
const CompleteSchema = z.object({
  transferId: z.string().min(1),
  files: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        size: z.number().nullable().optional(),
        objectPath: z.string().min(1),
      })
    )
    .min(1),
});

router.post("/complete", async (req, res) => {
  const parsed = CompleteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const { transferId, files } = parsed.data;

  const docRef = firestore.collection("transfers").doc(transferId);
  const snap = await docRef.get();
  if (!snap.exists) {
    return res.status(404).json({ ok: false, error: "Transfer not found" });
  }

  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000; // 24h

  await docRef.set(
    {
      status: "ready",
      completedAt: now,
      expiresAt,
      files,
    },
    { merge: true }
  );

  const frontendBase =
    process.env.FRONTEND_URL ||
    "https://swift-transfer-fe-829099680012.europe-west1.run.app";

  const shareUrl = `${frontendBase.replace(/\/$/, "")}/t/${transferId}`;

  return res.json({
    ok: true,
    transferId,
    shareUrl,
    expiresAt,
  });
});

/**
 * GET transfer metadata (for share page)
 */
router.get("/:transferId", async (req, res) => {
  const transferId = req.params.transferId;

  const docRef = firestore.collection("transfers").doc(transferId);
  const snap = await docRef.get();
  if (!snap.exists) {
    return res.status(404).json({ ok: false, error: "Transfer not found" });
  }

  const data = snap.data() as any;

  if (data?.expiresAt && typeof data.expiresAt === "number") {
    if (Date.now() > data.expiresAt) {
      return res.status(410).json({ ok: false, error: "Transfer expired" });
    }
  }

  return res.json({
    ok: true,
    transferId: data.transferId,
    status: data.status,
    createdAt: data.createdAt,
    completedAt: data.completedAt ?? null,
    expiresAt: data.expiresAt ?? null,
    files: data.files ?? [],
  });
});

/**
 * GET signed download URL for a file (by index)
 */
router.get("/:transferId/files/:index/download", async (req, res) => {
  try {
    const transferId = req.params.transferId;
    const index = Number(req.params.index);

    if (Number.isNaN(index) || index < 0) {
      return res.status(400).json({ ok: false, error: "Invalid file index" });
    }

    const docRef = firestore.collection("transfers").doc(transferId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "Transfer not found" });
    }

    const data = snap.data() as any;

    if (data?.status !== "ready") {
      return res.status(409).json({ ok: false, error: "Transfer not ready" });
    }

    if (
      data?.expiresAt &&
      typeof data.expiresAt === "number" &&
      Date.now() > data.expiresAt
    ) {
      return res.status(410).json({ ok: false, error: "Transfer expired" });
    }

    const files = Array.isArray(data?.files) ? data.files : [];
    const fileMeta = files[index];

    if (!fileMeta?.objectPath) {
      return res.status(404).json({ ok: false, error: "File not found" });
    }

    const uploadsBucket = getUploadsBucket();
    const gcsFile = uploadsBucket.file(fileMeta.objectPath);

    const [url] = await gcsFile.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 10 * 60 * 1000, // 10 min
      responseDisposition: `attachment; filename="${fileMeta.name ?? "download"}"`,
    });

    return res.json({ ok: true, url });
  } catch (e: any) {
    console.error("download-url error:", e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message ?? "Internal error" });
  }
});

/**
 * EMAIL share link via Mailgun
 */
const EmailSchema = z.object({
  to: z.string().email(),
  message: z.string().max(2000).optional(),
});

router.post("/:transferId/email", async (req, res) => {
  try {
    const transferId = req.params.transferId;

    const parsed = EmailSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    const { to, message } = parsed.data;

    const docRef = firestore.collection("transfers").doc(transferId);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "Transfer not found" });
    }

    const data = snap.data() as any;

    if (data?.status !== "ready") {
      return res.status(409).json({ ok: false, error: "Transfer not ready" });
    }

    if (
      data?.expiresAt &&
      typeof data.expiresAt === "number" &&
      Date.now() > data.expiresAt
    ) {
      return res.status(410).json({ ok: false, error: "Transfer expired" });
    }

    const frontendBase =
      process.env.FRONTEND_URL ||
      "https://swift-transfer-fe-829099680012.europe-west1.run.app";
    const shareUrl = `${frontendBase.replace(/\/$/, "")}/t/${transferId}`;

    const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
    const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN;

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      return res.status(500).json({
        ok: false,
        error:
          "Mailgun not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN missing)",
      });
    }

    const from =
      process.env.MAILGUN_FROM || `Swift Transfer <noreply@${MAILGUN_DOMAIN}>`;

    const files = Array.isArray(data?.files) ? data.files : [];
    const filesList = files
      .map(
        (f: any) =>
          `• ${f?.name ?? "file"} (${Math.round((f?.size ?? 0) / 1024)} KB)`
      )
      .join("\n");

    const text =
      `You've received files via Swift Transfer.\n\n` +
      `Download link:\n${shareUrl}\n\n` +
      (filesList ? `Files:\n${filesList}\n\n` : "") +
      (message ? `Message:\n${message}\n\n` : "") +
      `This link may expire.`;

    const auth = Buffer.from(`api:${MAILGUN_API_KEY}`).toString("base64");
    const url = `https://api.eu.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`;

    const form = new URLSearchParams();
    form.set("from", from);
    form.set("to", to);
    form.set("subject", "Swift Transfer - Your files are ready");
    form.set("text", text);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({
        ok: false,
        error: `Mailgun failed (${resp.status}): ${errText}`,
      });
    }

    return res.json({ ok: true, shareUrl });
  } catch (e: any) {
    console.error("email error:", e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message ?? "Internal error" });
  }
});

export default router;
