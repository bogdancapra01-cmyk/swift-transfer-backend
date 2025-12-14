function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v : undefined;
}

function requiredInDev(name: string): string | undefined {
  const v = optional(name);

  // În dev/local putem fi mai stricti (te ajută să nu uiți variabilele).
  // În production (Cloud Run) NU oprim aplicația la boot.
  if (!v && (process.env.NODE_ENV ?? "development") !== "production") {
    throw new Error(`Missing env var: ${name}`);
  }

  return v;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",

  // În Cloud Run pot lipsi la boot -> le validăm când chiar le folosim în routes
  // (sau le setezi în Cloud Run Variables & Secrets).
  GCP_PROJECT_ID: requiredInDev("GCP_PROJECT_ID"),
  GCS_BUCKET: requiredInDev("GCS_BUCKET"),

  // Port: Cloud Run injectează PORT; fallback 8080
  PORT: process.env.PORT ?? "8080",
};
