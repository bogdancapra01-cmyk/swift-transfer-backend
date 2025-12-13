import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./env";

const app = express();

// securitate + parsing
app.use(helmet());
app.use(express.json({ limit: "10mb" }));

// CORS (în dev e OK wide-open; în prod îl restrângem la domeniul tău)
app.use(
  cors({
    origin: true,
    credentials: true
  })
);

// logging
app.use(morgan("tiny"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "swift-transfer-backend",
    env: env.NODE_ENV ?? "development"
  });
});

const port = Number(env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`✅ Swift Transfer BE listening on port ${port}`);
});
