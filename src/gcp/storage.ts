import { Storage } from "@google-cloud/storage";
import { env } from "../env";

let storage: Storage | null = null;

/**
 * Lazy init pentru Storage
 * - NU crapă aplicația la boot
 * - Aruncă eroare clară DOAR când e folosit fără env-uri
 */
function getStorage(): Storage {
  if (storage) return storage;

  if (!env.GCP_PROJECT_ID) {
    throw new Error("GCP_PROJECT_ID is not set");
  }

  storage = new Storage({
    projectId: env.GCP_PROJECT_ID,
  });

  return storage;
}

export function getUploadsBucket() {
  if (!env.GCS_BUCKET) {
    throw new Error("GCS_BUCKET is not set");
  }

  return getStorage().bucket(env.GCS_BUCKET);
}
