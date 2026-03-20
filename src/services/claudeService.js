// src/services/claudeService.js

const Anthropic = require("@anthropic-ai/sdk");
const { SYSTEM_PROMPT } = require("../config/bot");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Send the full conversation history to Claude and get a reply.
 * Returns { text, triggerDeliveryFee, triggerPaymentLink }
 */
async function getReply(messages) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  });

  const raw = response.content.map((b) => b.text || "").join("");

  // Detect system trigger tags
  const triggerDeliveryFee  = raw.includes("[CHECK_DELIVERY_FEE]");
  const triggerPaymentLink  = raw.includes("[SEND_PAYMENT_LINK]");

  // Strip tags before sending to customer
  const text = raw
    .replace("[CHECK_DELIVERY_FEE]", "")
    .replace("[SEND_PAYMENT_LINK]", "")
    .trim();

  // If Claude only returned a tag and nothing else, use a fallback
  // so Twilio never receives an empty body
  const safeText = text || "Give me one sec... 🙏🏾";

  return { text: safeText, triggerDeliveryFee, triggerPaymentLink };
}

module.exports = { getReply };
