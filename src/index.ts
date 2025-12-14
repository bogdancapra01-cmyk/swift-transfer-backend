import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import "dotenv/config";
import { env } from "./env";
import transfersRouter from "./routes/transfers";

const app = express();

// securitate + parsing
app.use(helmet());
app.use(express.json({ limit: "10mb" }));

/**
 * ✅ CORS - focus pe Cloud Run (PROD)
 * Acceptăm DOAR frontend-ul din Cloud Run + (opțional) domeniul tău.
 * IMPORTANT: nu aruncăm Error în origin callback (altfel preflight poate da 500).
 */
const allowedOrigins = [
  "https://swift-transfer-fe-829099680012.europe-west1.run.app",
  "https://swift-transfer.app",
];

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    // allow server-to-server / curl / postman (no origin)
    if (!origin) return cb(null, true);

    // allow only whitelisted origins
    if (allowedOrigins.includes(origin)) return cb(null, true);

    // do NOT throw errors here -> avoids 500 on preflight
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

// aplică CORS pentru toate request-urile
app.use(cors(corsOptions));

// preflight (OPTIONS) pentru orice rută
app.options("*", cors(corsOptions));

// logging
app.use(morgan("tiny"));

// routes
app.use("/api/transfers", transfersRouter);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "swift-transfer-backend",
    env: env.NODE_ENV ?? "development",
  });
});

// error handler global (ca să nu mai primești HTML 500)
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("❌ Unhandled error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Internal Server Error",
    });
  }
);

const port = Number(env.PORT);

app.listen(port, () => {
  console.log(`✅ Swift Transfer BE listening on port ${port}`);
});
