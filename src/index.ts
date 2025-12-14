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

const allowedOrigins = [
  // DEV
  "http://localhost:5173",
  "http://127.0.0.1:5173",

  // PROD
  "https://swift-transfer-fe-829099680012.europe-west1.run.app",
  "https://swift-transfer.app",
];

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    // allow server-to-server / curl / postman (no origin)
    if (!origin) return cb(null, true);

    // allow only whitelisted origins
    if (allowedOrigins.includes(origin)) return cb(null, true);

    // IMPORTANT: don't throw error -> avoids 500 on preflight
    return cb(null, false);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // preflight

// logging
app.use(morgan("tiny"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "swift-transfer-backend",
    env: env.NODE_ENV ?? "development",
  });
});

app.use("/api/transfers", transfersRouter);

// OPTIONAL: dacă vrei să vezi clar când CORS blochează (în loc de 500)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({
      error: "CORS blocked",
      origin,
    });
  }
  next();
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
