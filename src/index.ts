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
  "https://<URL-FRONTEND-CLOUD-RUN>",
  "https://swift-transfer.app",
];

// CORS (în dev e OK wide-open; în prod îl restrângem la domeniul tău)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // Postman/curl
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use("/api/transfers", transfersRouter);


// logging
app.use(morgan("tiny"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "swift-transfer-backend",
    env: env.NODE_ENV ?? "development"
  });
});

const port = Number(env.PORT);

app.listen(port, () => {
  console.log(`✅ Swift Transfer BE listening on port ${port}`);
});
