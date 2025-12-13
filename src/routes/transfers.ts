import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { uploadsBucket } from "../gcp/storage";
import { firestore } from "../gcp/firestore";

const router = Router();

const InitSchema = z.object({
  files: z.array(
    z.object({
      name: z.string().min(1),
      type: z.string().optional().default("application/octet-stream"),
      size: z.number().int().nonnegative().optional(),
    })
  ).min(1),
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

export default router;
