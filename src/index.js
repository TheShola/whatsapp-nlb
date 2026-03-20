// src/index.js

require("dotenv").config();

const express        = require("express");
const { closeRedis } = require("./services/redisClient");
const whatsappRouter = require("./routes/webhook");
const paystackRouter = require("./routes/paystack");
const chowdeckRouter = require("./routes/chowdeck");

const app  = express();
const PORT = process.env.PORT || 3000;
const ENV  = process.env.NODE_ENV || "development";

// ── Request logger ────────────────────────────────────────────────────────────

app.use((req, _res, next) => {
  console.log(`→ ${req.method} ${req.path}`);
  next();
});

// ── Body parsing + Routes ─────────────────────────────────────────────────────
//
// IMPORTANT: Paystack webhook MUST be mounted with express.raw() BEFORE
// any JSON/urlencoded parsers — signature verification needs the raw bytes.
// It must also be registered BEFORE app.use("/webhook", ...) to avoid
// Express matching it to the general webhook router first.

// Paystack webhook — raw Buffer so we can verify HMAC-SHA512
app.use(
  "/webhook/paystack",
  express.raw({ type: "*/*" }),  // accept any content-type as raw
  paystackRouter
);

// Everything else gets standard parsed body
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use("/webhook", whatsappRouter);
app.use("/webhook", chowdeckRouter);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "Tin and Tain Bot",
    env: ENV,
    timestamp: new Date().toISOString(),
  });
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║       🥜  Tin and Tain Bot  🥜           ║
╠══════════════════════════════════════════╣
║  Port     : ${PORT}                         ║
║  Env      : ${ENV.padEnd(12)}              ║
║  WhatsApp : POST /webhook/whatsapp       ║
║  Paystack : POST /webhook/paystack       ║
║  Chowdeck : POST /webhook/chowdeck       ║
║  Health   : GET  /health                 ║
╚══════════════════════════════════════════╝
  `);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  server.close(async () => {
    await closeRedis();
    console.log("Server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

module.exports = app;