// src/services/twilioService.js

const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Send a WhatsApp message via Twilio.
 * @param {string} to   - Customer's number e.g. "whatsapp:+2348012345678"
 * @param {string} body - Message text
 */
async function sendMessage(to, body) {
  return client.messages.create({
    body,
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
  });
}

/**
 * Validate that an incoming request is genuinely from Twilio.
 * Use this middleware in production.
 */
function validateTwilioSignature(req, res, next) {
  const signature = req.headers["x-twilio-signature"];
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!isValid) {
    console.warn("⚠️  Invalid Twilio signature — rejecting request");
    return res.status(403).send("Forbidden");
  }

  next();
}

module.exports = { sendMessage, validateTwilioSignature };
