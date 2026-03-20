// src/services/deliveryStore.js
//
// Stores the mapping between a Chowdeck delivery ID and the customer's
// WhatsApp phone number. This lets the Chowdeck webhook handler look up
// who to message when a rider status event arrives.
//
// Keys in Redis:
//   delivery:<deliveryId>  →  { customerPhone, orderId, deliveryId }
//
// TTL: 48 hours — enough time for any delivery to complete.

const { getRedisClient } = require("./redisClient");

const DELIVERY_TTL_SECONDS = 48 * 60 * 60; // 48 hours
const KEY = (deliveryId) => `delivery:${deliveryId}`;

/**
 * Save a delivery → customer phone mapping after a rider is dispatched.
 */
async function saveDelivery({ deliveryId, customerPhone, orderId }) {
  const redis = getRedisClient();
  await redis.set(
    KEY(deliveryId),
    JSON.stringify({ deliveryId, customerPhone, orderId }),
    "EX",
    DELIVERY_TTL_SECONDS
  );
  console.log(`📦 Delivery mapping saved — deliveryId:${deliveryId} → ${customerPhone}`);
}

/**
 * Look up the customer phone number for a given Chowdeck delivery ID.
 * Returns null if not found or expired.
 */
async function getDeliveryByChowdeckId(deliveryId) {
  const redis  = getRedisClient();
  const raw    = await redis.get(KEY(deliveryId));
  return raw ? JSON.parse(raw) : null;
}

/**
 * Delete a delivery mapping once the order is complete.
 */
async function deleteDelivery(deliveryId) {
  const redis = getRedisClient();
  await redis.del(KEY(deliveryId));
}

module.exports = { saveDelivery, getDeliveryByChowdeckId, deleteDelivery };
