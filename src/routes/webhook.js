// src/routes/webhook.js
//
// POST /webhook/whatsapp — receives every incoming WhatsApp message from Twilio

const express = require("express");
const router  = express.Router();

const { validateTwilioSignature }                           = require("../services/twilioService");
const { getOrCreateSession, addMessage, updateOrderState, clearSession } = require("../services/sessionStore");
const { getReply }          = require("../services/claudeService");
const { sendMessage }       = require("../services/twilioService");
const { getDeliveryFee }    = require("../services/chowdeckService");
const { createPaymentLink } = require("../services/paystackService");

// Validate Twilio signatures in production only
if (process.env.NODE_ENV === "production") {
  router.use(validateTwilioSignature);
}

// ── Main webhook handler ──────────────────────────────────────────────────────

router.post("/whatsapp", async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const fromNumber  = req.body.From;  // e.g. "whatsapp:+2348012345678"

  // Respond 200 immediately — Twilio requires a fast acknowledgement
  res.sendStatus(200);

  if (!incomingMsg || !fromNumber) return;

  console.log(`📩 [${fromNumber}] "${incomingMsg}"`);

  try {
    // Clear session if customer is starting a fresh conversation
    const RESTART_TRIGGERS = ["hi", "hello", "hey", "start", "restart", "new order", "order again", "hiya", "yo"];
    const isRestart = RESTART_TRIGGERS.some(t =>
      incomingMsg.toLowerCase().trim() === t ||
      incomingMsg.toLowerCase().trim().startsWith(t + " ")
    );

    if (isRestart) {
      await clearSession(fromNumber);
      console.log(`🔄 [${fromNumber}] Fresh session started`);
    }

    const session = await getOrCreateSession(fromNumber);

    // 1. Add customer message to history
    await addMessage(fromNumber, "user", incomingMsg);

    // Reload session so we have the updated messages array
    const updatedSession = await getOrCreateSession(fromNumber);

    // 2. Get Tara's reply from Claude
    const { text, triggerDeliveryFee, triggerPaymentLink } =
      await getReply(updatedSession.messages);

    // 3. Send reply to customer and persist it
    await sendMessage(fromNumber, text);
    await addMessage(fromNumber, "assistant", text);

    // 4. [CHECK_DELIVERY_FEE] — fetch Chowdeck fee, then re-prompt Claude
    if (triggerDeliveryFee) {
      await handleDeliveryFeeCheck(fromNumber, updatedSession, incomingMsg);
    }

    // 5. [SEND_PAYMENT_LINK] — generate Paystack link and send it
    if (triggerPaymentLink) {
      await handlePaymentLink(fromNumber);
    }

  } catch (err) {
    console.error(`❌ Error handling message from ${fromNumber}:`, err);
    await sendMessage(
      fromNumber,
      "So sorry, I ran into a small issue on my end. Please try again in a moment! 🙏🏾"
    );
  }
});

// ── Helper: fetch delivery fee, then re-prompt Claude with the result ─────────

async function handleDeliveryFeeCheck(fromNumber, session, lastMessage) {
  const address = session.orderState.deliveryAddress || lastMessage;
  await updateOrderState(fromNumber, { deliveryAddress: address });

  console.log(`🚚 [${fromNumber}] Fetching Chowdeck fee for: "${address}"`);

  // Pass subtotal so Chowdeck can calculate fee accurately
  const subtotal = session.orderState.subtotal || 0;

  let fee, feeId;
  try {
    ({ fee, feeId } = await getDeliveryFee(address, subtotal));
  } catch (err) {
    // Geocoding failed — ask customer for a clearer address
    if (err.message.includes("Geocoding failed")) {
      console.warn(`⚠️  Geocoding failed for "${address}" — asking customer to clarify`);
      // Clear the bad address so it's not retried on next message
      await updateOrderState(fromNumber, { deliveryAddress: null });
      const clarifyMsg =
        `Sorry, I couldn't find that address on the map 🗺️\n\n` +
        `Could you share a bit more detail? For example:\n` +
        `"14 Admiralty Way, Lekki Phase 1, Lagos"\n\n` +
        `A street name and area works best!`;
      await sendMessage(fromNumber, clarifyMsg);
      await addMessage(fromNumber, "assistant", clarifyMsg);
      return;
    }
    throw err; // re-throw unexpected errors
  }

  await updateOrderState(fromNumber, { deliveryFee: fee, feeId });
  console.log(`💰 [${fromNumber}] Delivery fee: ₦${fee.toLocaleString()} feeId:${feeId}`);

  // Inject fee into conversation so Claude presents the full order summary
  const systemNote =
    `[SYSTEM] Chowdeck delivery fee for "${address}" is ₦${fee.toLocaleString()}. ` +
    `Present the complete order summary: each item with quantity and unit price, ` +
    `items subtotal, delivery fee, and grand total. Then ask the customer to confirm.`;

  await addMessage(fromNumber, "user", systemNote);
  console.log(`📝 [${fromNumber}] System note injected, calling Claude for summary...`);

  // Reload session to get updated messages array
  const updated = await require("../services/sessionStore").getOrCreateSession(fromNumber);
  console.log(`📨 [${fromNumber}] Message history length: ${updated.messages.length}`);
  const summaryReply = await getReply(updated.messages);
  console.log(`🤖 [${fromNumber}] Summary reply: "${summaryReply.text.slice(0, 80)}..."`);

  await sendMessage(fromNumber, summaryReply.text);
  console.log(`✅ [${fromNumber}] Summary sent to customer`);
  await addMessage(fromNumber, "assistant", summaryReply.text);

  if (summaryReply.triggerPaymentLink) {
    await handlePaymentLink(fromNumber);
  }
}

// ── Helper: generate and send Paystack payment link ───────────────────────────

async function handlePaymentLink(fromNumber) {
  const { getOrderState } = require("../services/sessionStore");
  const orderState = await getOrderState(fromNumber);

  const { deliveryFee = 0, subtotal, total } = orderState;
  const amountNaira = total || (subtotal || 0) + deliveryFee || 5000;
  const amountKobo  = amountNaira * 100;
  const reference   = makeOrderRef();

  const phone = fromNumber.replace("whatsapp:+", "");
  const email = `${phone}@orders.tinandtain.com`;

  console.log(`💳 [${fromNumber}] Generating Paystack link — ₦${amountNaira.toLocaleString()} ref:${reference}`);

  const { link } = await createPaymentLink({
    email,
    amountKobo,
    reference,
    metadata: {
      customer_phone: fromNumber,
      order_ref: reference,
      delivery_address: orderState.deliveryAddress,
    },
  });

  await updateOrderState(fromNumber, { paystackRef: reference, paystackLink: link });

  const payMsg =
    `Here's your secure payment link 👇\n\n` +
    `💳 ${link}\n\n` +
    `Once payment is confirmed, I'll dispatch your Tin and Tain rider immediately. 🛵`;

  await sendMessage(fromNumber, payMsg);
  console.log(`✅ [${fromNumber}] Payment link sent — ref:${reference}`);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function makeOrderRef() {
  const ts     = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TT-${ts}-${random}`;
}

module.exports = router;