import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { getUploadsBucket } from "../gcp/storage";
import { firestore } from "../gcp/firestore";
import fetch from "node-fetch";
import archiver from "archiver";
import { requireAuth, AuthedRequest } from "../middleware/auth";




const router = Router();
const SHARE_TTL_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

router.post("/init", requireAuth, async (req: AuthedRequest, res) => {
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

router.post("/complete", requireAuth, async (req: AuthedRequest, res) => {
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
  const expiresAt = now + SHARE_TTL_DAYS * MS_PER_DAY; // 14 days

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
router.get("/:transferId", requireAuth, async (req: AuthedRequest, res) => {
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

/**
 * DOWNLOAD ALL as ZIP
 * GET /api/transfers/:transferId/download.zip
 */
router.get("/:transferId/download.zip", async (req, res) => {
  try {
    const transferId = req.params.transferId;

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
    if (!files.length) {
      return res.status(404).json({ ok: false, error: "No files found" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="swift-transfer-${transferId}.zip"`
    );

    router.get("/my", requireAuth, async (req: AuthedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userId = req.user.uid;

    const snapshot = await firestore
      .collection("transfers")
      .where("userId", "==", userId)
      .get();

    const transfers = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a: any, b: any) => {
        const aMs =
          a.createdAt?.toMillis?.() ??
          (typeof a.createdAt === "number" ? a.createdAt : 0);
        const bMs =
          b.createdAt?.toMillis?.() ??
          (typeof b.createdAt === "number" ? b.createdAt : 0);
        return bMs - aMs; // newest first
      });

    res.json({ transfers });
  } catch (error) {
    console.error("Failed to fetch my uploads:", error);
    res.status(500).json({ error: "Failed to fetch uploads" });
  }
});




    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      console.error("zip error:", err);
      if (!res.headersSent) res.status(500);
      res.end();
    });

    archive.pipe(res);

    const uploadsBucket = getUploadsBucket();

    // ca să evităm nume duplicate în ZIP
    const usedNames = new Set<string>();

    for (let i = 0; i < files.length; i++) {
      const meta = files[i];
      const objectPath = meta?.objectPath;
      const originalName = String(meta?.name ?? `file-${i + 1}`);

      if (!objectPath) continue;

      // sanitize + uniqueness
      const safeBase = originalName.replace(/[^\w.\-()+ ]/g, "_") || `file-${i + 1}`;
      let finalName = safeBase;
      let counter = 2;
      while (usedNames.has(finalName)) {
        const dot = safeBase.lastIndexOf(".");
        if (dot > 0) {
          finalName = `${safeBase.slice(0, dot)} (${counter})${safeBase.slice(dot)}`;
        } else {
          finalName = `${safeBase} (${counter})`;
        }
        counter++;
      }
      usedNames.add(finalName);

      const gcsFile = uploadsBucket.file(objectPath);
      archive.append(gcsFile.createReadStream(), { name: finalName });
    }

    // finalize streaming ZIP
    void archive.finalize();
  } catch (e: any) {
    console.error("download-zip error:", e);
    return res.status(500).json({ ok: false, error: e?.message ?? "Internal error" });
  }
});


export default router;
