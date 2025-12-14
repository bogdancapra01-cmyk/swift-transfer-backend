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

// logging
app.use(morgan("tiny"));

/**
 * CORS - PROD (Cloud Run FE)
 */
const allowedOrigins = [
  "https://swift-transfer-fe-829099680012.europe-west1.run.app",
  "https://swift-transfer.app",
];

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false); // IMPORTANT: nu aruncăm Error
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// routes
app.use("/api/transfers", transfersRouter);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "swift-transfer-backend",
    env: env.NODE_ENV ?? "development",
  });
});

// ✅ FIX: Cloud Run PORT
const port = Number(process.env.PORT || env.PORT || 8080);

app.listen(port, () => {
  console.log(`✅ Swift Transfer BE listening on port ${port}`);
});
