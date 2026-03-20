// src/services/redisClient.js
//
// Single shared Redis connection for the whole app.
// Uses ioredis — handles reconnection automatically.

const Redis = require("ioredis");

let client = null;

function getRedisClient() {
  if (client) return client;

  const url = process.env.REDIS_URL || "redis://localhost:6379";

  client = new Redis(url, {
    // Retry with backoff — keeps the app alive if Redis restarts
    retryStrategy(times) {
      if (times > 10) {
        console.error("Redis: too many retries, giving up");
        return null; // stop retrying
      }
      return Math.min(times * 200, 3000); // wait up to 3s between retries
    },
    // Don't crash the process on connection errors
    lazyConnect: false,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 3,
  });

  client.on("connect", () =>
    console.log(`✅ Redis connected: ${url.replace(/\/\/.*@/, "//")}`)
  );
  client.on("error", (err) =>
    console.error("Redis error:", err.message)
  );
  client.on("reconnecting", () =>
    console.warn("Redis reconnecting...")
  );

  return client;
}

async function closeRedis() {
  if (client) {
    await client.quit();
    client = null;
    console.log("Redis connection closed.");
  }
}

module.exports = { getRedisClient, closeRedis };
