// src/services/sessionStore.js
//
// Persists conversation history and order state in Redis.
// Each session is stored as a single JSON blob under key: session:<phoneNumber>
// TTL is refreshed on every message — sessions expire after 2 hours of inactivity.

const { getRedisClient } = require("./redisClient");

const SESSION_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const KEY = (phone) => `session:${phone}`;

// ── Internal helpers ──────────────────────────────────────────────────────────

function emptySession(phoneNumber) {
  return {
    phoneNumber,
    messages: [],        // Claude conversation history [{role, content}]
    orderState: {
      items: [],         // [{name, qty, unitPrice}]
      customerName: null,
      deliveryAddress: null,
      deliveryFee: null,
      feeId: null,       // Chowdeck fee_id — required for createDelivery
      subtotal: null,
      total: null,
      paystackRef: null,
      paystackLink: null,
    },
  };
}

async function readSession(phoneNumber) {
  const redis = getRedisClient();
  const raw = await redis.get(KEY(phoneNumber));
  return raw ? JSON.parse(raw) : null;
}

async function writeSession(session) {
  const redis = getRedisClient();
  await redis.set(
    KEY(session.phoneNumber),
    JSON.stringify(session),
    "EX",
    SESSION_TTL_SECONDS
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getOrCreateSession(phoneNumber) {
  const existing = await readSession(phoneNumber);
  if (existing) return existing;

  const fresh = emptySession(phoneNumber);
  await writeSession(fresh);
  return fresh;
}

async function clearSession(phoneNumber) {
  const redis = getRedisClient();
  await redis.del(KEY(phoneNumber));
  console.log(`🗑️  Session cleared for ${phoneNumber}`);
}

async function addMessage(phoneNumber, role, content) {
  const session = await getOrCreateSession(phoneNumber);
  session.messages.push({ role, content });
  await writeSession(session);
}

async function updateOrderState(phoneNumber, updates) {
  const session = await getOrCreateSession(phoneNumber);
  session.orderState = { ...session.orderState, ...updates };
  await writeSession(session);
}

// Convenience: returns only orderState without loading full session
async function getOrderState(phoneNumber) {
  const session = await readSession(phoneNumber);
  return session?.orderState ?? null;
}

module.exports = {
  getOrCreateSession,
  clearSession,
  addMessage,
  updateOrderState,
  getOrderState,
};