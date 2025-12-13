import { Firestore } from "@google-cloud/firestore";
import { env } from "../env";

export const firestore = new Firestore({
  projectId: env.GCP_PROJECT_ID,
});
