import { Storage } from "@google-cloud/storage";
import { env } from "../env";

export const storage = new Storage({
  projectId: env.GCP_PROJECT_ID,
});

export const uploadsBucket = storage.bucket(env.GCS_BUCKET);
