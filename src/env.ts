import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  PORT: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),

  GCP_PROJECT_ID: z.string().optional(),
  GCS_BUCKET: z.string().optional(),

  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_DOMAIN: z.string().optional(),
  MAILGUN_FROM: z.string().optional()
});

export const env = EnvSchema.parse(process.env);
