import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { uploadsBucket } from "../gcp/storage";
import { firestore } from "../gcp/firestore";

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

  // pentru început: expiră upload-urile în 15 minute
  const expiresAt = Date.now() + 15 * 60 * 1000;

  const uploads = await Promise.all(
    parsed.data.files.map(async (f) => {
      // curățăm numele (simplu)
      const safeName = f.name.replace(/[^\w.\-()+ ]/g, "_");
      const objectPath = `uploads/${transferId}/${safeName}`;

      const fileRef = uploadsBucket.file(objectPath);

      const [uploadUrl] = await fileRef.getSignedUrl({
        version: "v4",
        action: "write",
        expires: expiresAt,
        // IMPORTANT: păstrăm contentType pentru semnare
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

  // salvăm transferul ca draft în Firestore
  await firestore.collection("transfers").doc(transferId).set({
    transferId,
    status: "draft",
    createdAt,
    // nu setăm expiresAt final aici (draft), doar metadata
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
    expiresAt,
  });
});

/**
 * COMPLETE (mark transfer ready after uploads finished)
 * FE trimite: { transferId, files: [{ name, type, size, objectPath }] }
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

  // aici definim expirarea "share" (ex: 24h)
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;

  await docRef.set(
    {
      status: "ready",
      completedAt: now,
      expiresAt,
      files,
    },
    { merge: true }
  );

  // Share URL: dacă ai FRONTEND_URL setat în Cloud Run -> îl folosește
  // altfel pune fallback (poți schimba cu domeniul tău ulterior)
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

  // opțional: dacă expiră, returnăm 410 Gone
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

export default router;
