import type { Request, Response, NextFunction } from "express";
import admin from "firebase-admin";

function initFirebaseAdmin() {
  // IMPORTANT:
  // Pe Cloud Run (cu service account), admin.initializeApp() merge fără chei,
  // folosind implicit credentials ale runtime-ului GCP.
  if (!admin.apps.length) {
    admin.initializeApp();
  }
}

export type AuthedRequest = Request & { user?: { uid: string; email?: string | null } };

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    initFirebaseAdmin();

    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({ ok: false, error: "Missing Authorization: Bearer <token>" });
    }

    const token = match[1];
    const decoded = await admin.auth().verifyIdToken(token);

    req.user = {
      uid: decoded.uid,
      email: (decoded.email as string | undefined) ?? null,
    };

    return next();
  } catch (e: any) {
    return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }
}
