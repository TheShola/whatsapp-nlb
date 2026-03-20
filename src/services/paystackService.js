// src/services/paystackService.js

const PAYSTACK_API_BASE = "https://api.paystack.co";

// ── Helper ────────────────────────────────────────────────────────────────────

async function paystackRequest(method, path, body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${PAYSTACK_API_BASE}${path}`, options);
  const data = await res.json();

  if (!res.ok || !data.status) {
    throw new Error(
      `Paystack ${method} ${path} failed: ${data.message || res.status}`
    );
  }

  return data.data;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise a transaction and return a hosted payment URL.
 *
 * @param {object} params
 * @param {string} params.email        - Customer email (required by Paystack)
 * @param {number} params.amountKobo   - Amount in kobo (Naira × 100)
 * @param {string} params.reference    - Unique order reference e.g. TT-ABC-1234
 * @param {object} params.metadata     - Extra data stored against the transaction
 * @returns {Promise<{ link: string, reference: string }>}
 */
async function createPaymentLink({ email, amountKobo, reference, metadata }) {
  console.log(
    `💳 Paystack: initialising ₦${(amountKobo / 100).toLocaleString()} — ref:${reference}`
  );

  const data = await paystackRequest("POST", "/transaction/initialize", {
    email,
    amount: amountKobo,
    reference,
    metadata,
    currency: "NGN",
    // Customer lands back on a confirmation page after payment
    callback_url: process.env.PAYSTACK_CALLBACK_URL || undefined,
  });

  console.log(`✅ Paystack: link created — ${data.authorization_url}`);

  return {
    link: data.authorization_url,
    reference: data.reference,
  };
}

/**
 * Verify a transaction by reference.
 * Call this inside the webhook handler to confirm payment before dispatching.
 *
 * @param {string} reference
 * @returns {Promise<{ paid: boolean, amountKobo: number, metadata: object }>}
 */
async function verifyTransaction(reference) {
  const data = await paystackRequest(
    "GET",
    `/transaction/verify/${encodeURIComponent(reference)}`
  );

  return {
    paid: data.status === "success",
    amountKobo: data.amount,
    metadata: data.metadata || {},
    customerEmail: data.customer?.email,
  };
}

/**
 * Verify that an incoming webhook request genuinely came from Paystack.
 * Paystack signs the raw request body with HMAC-SHA512 using your secret key.
 *
 * @param {Buffer} rawBody   - The raw request body (must NOT be parsed yet)
 * @param {string} signature - Value of the x-paystack-signature header
 * @returns {boolean}
 */
function validateWebhookSignature(rawBody, signature) {
  const crypto = require("crypto");
  const expected = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

module.exports = { createPaymentLink, verifyTransaction, validateWebhookSignature };