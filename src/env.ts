function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",

  GCP_PROJECT_ID: required("GCP_PROJECT_ID"),
  GCS_BUCKET: required("GCS_BUCKET"),
  PORT: process.env.PORT ?? "8080",

};
