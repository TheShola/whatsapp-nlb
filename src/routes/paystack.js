// src/routes/paystack.js
//
// POST /webhook/paystack — Paystack calls this after every payment event.
//
// IMPORTANT: This route must receive the RAW request body (not JSON-parsed)
// so the HMAC signature can be verified against the original bytes.
// See index.js where this route is mounted with express.raw().

const express  = require("express");
const router   = express.Router();

const { verifyTransaction, validateWebhookSignature } = require("../services/paystackService");
const { getOrderState, clearSession }                 = require("../services/sessionStore");
const { sendMessage }                                 = require("../services/twilioService");
const { createDelivery }                              = require("../services/chowdeckService");
const { saveDelivery }                                = require("../services/deliveryStore");
const { createOrderRecord, updateOrderStatus: updateAirtableStatus } = require("../services/airtableService");
const { insertOrder, updateOrderStatus: updateSupabaseStatus, updateChowdeckId } = require("../services/supabaseService");

// ── Webhook handler ───────────────────────────────────────────────────────────

router.post("/paystack", async (req, res) => {
  // 1. Verify the request came from Paystack
  // In development, signature validation can fail due to tunnel URL mismatches
  // so we only enforce it in production
  const signature = req.headers["x-paystack-signature"];

  if (process.env.NODE_ENV === "production") {
    if (!signature || !validateWebhookSignature(req.body, signature)) {
      console.warn("⚠️  Paystack webhook: invalid signature — rejected");
      return res.sendStatus(401);
    }
  } else {
    console.log(`🔔 Paystack webhook received (signature check skipped in dev)`);
  }

  // 2. Parse the raw body now that we've verified it
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.sendStatus(400);
  }

  // Acknowledge immediately — Paystack expects 200 within 5 seconds
  res.sendStatus(200);

  console.log(`📦 Paystack event: ${event.event}`);
  console.log(`📦 Paystack data:`, JSON.stringify(event.data, null, 2));

  // 3. Only act on successful charges
  if (event.event !== "charge.success") {
    console.log(`⏭️  Skipping event: ${event.event}`);
    return;
  }

  const { reference, metadata } = event.data;

  try {
    await handlePaymentSuccess(reference, metadata, event.data);
  } catch (err) {
    console.error(`❌ Error processing payment ref:${reference}:`, err);
  }
});

// ── Payment success handler ───────────────────────────────────────────────────

async function handlePaymentSuccess(reference, metadata, eventData = {}) {
  console.log(`💰 Payment success — ref:${reference}`);
  console.log(`💰 Metadata:`, JSON.stringify(metadata));

  // 1. Verify with Paystack directly (don't trust the webhook body alone)
  console.log(`🔍 Verifying transaction with Paystack...`);
  const { paid, amountKobo } = await verifyTransaction(reference);
  console.log(`🔍 Verification result — paid:${paid} amount:${amountKobo}`);

  if (!paid) {
    console.warn(`⚠️  Transaction ref:${reference} not confirmed by Paystack verify — ignoring`);
    return;
  }

  const customerPhone = metadata?.customer_phone;
  console.log(`📱 Customer phone from metadata: ${customerPhone}`);
  if (!customerPhone) {
    console.warn(`⚠️  No customer_phone in metadata for ref:${reference}`);
    return;
  }

  // Derive customer email from event data or construct a placeholder
  const email = eventData?.customer?.email
    || `${customerPhone.replace("whatsapp:+", "")}@orders.tinandtain.com`;
  console.log(`📧 Customer email: ${email}`);

  // 2. Load their order state from Redis
  const orderState = await getOrderState(customerPhone);

  if (!orderState) {
    console.warn(`⚠️  No session found for ${customerPhone} — may have expired`);
    // Still notify the customer — their session might have just expired
    await sendMessage(
      customerPhone,
      `🎉 Payment confirmed! (₦${(amountKobo / 100).toLocaleString()})\n\n` +
      `We're preparing your Tin and Tain order and will dispatch a rider shortly. ` +
      `Please reach us at hello@tinandtain.com if you have any questions!`
    );
    return;
  }

  // 3. Notify the customer immediately
  await sendMessage(
    customerPhone,
    `✅ *Payment confirmed!* ₦${(amountKobo / 100).toLocaleString()} received.\n\n` +
    `We're packing your order now and dispatching a rider to you sharp sharp! 🛵\n\n` +
    `You'll get another message when your rider is on the way. Thank you! 🙏🏾`
  );

  // 4. Save order to Airtable + Supabase (run in parallel, don't block dispatch)
  const orderPayload = {
    reference:        reference,
    customerPhone,
    customerName:     orderState.customerName    || "—",
    deliveryAddress:  orderState.deliveryAddress || "—",
    items:            orderState.items           || [],
    subtotal:         orderState.subtotal        || 0,
    deliveryFee:      orderState.deliveryFee     || 0,
    totalPaid:        amountKobo / 100,
    chowdeckId:       null, // updated below after dispatch
  };

  const [airtableResult, supabaseResult] = await Promise.allSettled([
    createOrderRecord(orderPayload),
    insertOrder(orderPayload),
  ]);

  if (airtableResult.status === "rejected") {
    console.error(`❌ Airtable save failed for ref:${reference}:`, airtableResult.reason?.message);
  }
  if (supabaseResult.status === "rejected") {
    console.error(`❌ Supabase save failed for ref:${reference}:`, supabaseResult.reason?.message);
  }

  // 4. Dispatch a Chowdeck rider
  try {
    const delivery = await createDelivery({
      orderId:         reference,
      customerName:    orderState.customerName || "Customer",
      customerPhone:   customerPhone,
      customerEmail:   email,
      deliveryAddress: orderState.deliveryAddress,
      feeId:           orderState.feeId,
      subtotal:        orderState.subtotal  || 0,
      items:           orderState.items || [],
    });

    console.log(
      `🛵 Chowdeck rider dispatched — ref:${reference} deliveryId:${delivery.deliveryId}`
    );

    // Save delivery → phone mapping so Chowdeck webhook can find this customer
    await saveDelivery({
      deliveryId:    delivery.deliveryId,
      customerPhone,
      orderId:       reference,
    });

    // Update both stores with the Chowdeck delivery ID and dispatched status
    await Promise.allSettled([
      updateAirtableStatus(reference, "Dispatched"),
      updateSupabaseStatus(reference, "dispatched"),
      updateChowdeckId(reference, delivery.deliveryId),
    ]);
  } catch (err) {
    // Rider dispatch failure must NOT block the payment confirmation message
    console.error(`❌ Chowdeck dispatch failed for ref:${reference}:`, err.message);

    await sendMessage(
      customerPhone,
      `⚠️ We're arranging your delivery manually right now — ` +
      `you'll hear from us within 10 minutes. So sorry for the delay!`
    );
  }

  // 5. Clear the session — order is complete
  await clearSession(customerPhone);
}

module.exports = router;