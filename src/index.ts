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

// IMPORTANT: refolosim aceleași opțiuni și la preflight
const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    // allow server-to-server / curl / postman (no origin)
    if (!origin) return cb(null, true);

    if (allowedOrigins.includes(origin)) return cb(null, true);

    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));

// Preflight (OPTIONS) trebuie să folosească aceleași corsOptions
app.options("*", cors(corsOptions));

// logging
app.use(morgan("tiny"));

app.use("/api/transfers", transfersRouter);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "swift-transfer-backend",
    env: env.NODE_ENV ?? "development",
  });
});

const port = Number(env.PORT);

app.listen(port, () => {
  console.log(`✅ Swift Transfer BE listening on port ${port}`);
});
