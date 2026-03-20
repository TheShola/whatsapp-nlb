// src/routes/chowdeck.js
//
// POST /webhook/chowdeck — Chowdeck fires this as a rider moves through
// each stage of a delivery. We translate each event into a warm WhatsApp
// update sent directly to the customer.
//
// Chowdeck webhook events (in order):
//   order.created               → delivery request received
//   order.assigned              → rider has been assigned
//   order.awaiting_pickup       → rider is at your kitchen, ready to collect
//   order.picked_up             → rider collected the order, now en route
//   order.arrived_at_customer   → rider is outside the customer's address
//   order.complete              → delivered successfully

const express = require("express");
const router  = express.Router();

const { getDeliveryByChowdeckId, deleteDelivery } = require("../services/deliveryStore");
const { sendMessage }      = require("../services/twilioService");
const { insertDeliveryEvent, updateOrderStatus: updateSupabaseStatus } = require("../services/supabaseService");
const { updateOrderStatus: updateAirtableStatus }                      = require("../services/airtableService");

// Status mappings from Chowdeck event → our storage status values
const SUPABASE_STATUS = {
  "order.picked_up": "in_transit", "in_transit":     "in_transit",
  "order.complete":  "delivered",  "success":         "delivered",
  "order.rejected":  "rejected",   "rejected":        "rejected",
};
const AIRTABLE_STATUS = {
  "order.picked_up": "Dispatched", "in_transit":     "Dispatched",
  "order.complete":  "Delivered",  "success":         "Delivered",
  "order.rejected":  "Rejected",   "rejected":        "Rejected",
};

// ── Customer-facing messages for each webhook event ───────────────────────────
//
// Chowdeck webhook event names (from dashboard sidebar):
//   order.created, order.assigned, order.awaiting_pickup,
//   order.picked_up, order.arrived_at_customer, order.complete
//
// Real delivery status values (from GET /delivery/:reference API):
//   received, rejected, awaiting_pickup, in_transit, arrived, success
//
// We handle both naming conventions so the webhook works regardless of
// which format Chowdeck sends in the event payload.

const EVENT_MESSAGES = {
  // ── Rider search started ──────────────────────────────────────────────────
  "order.created":   () =>
    `📦 Your Tin and Tain order has been received! We're finding a rider for you now. Hang tight! 🛵`,
  "received":        () =>
    `📦 Your Tin and Tain order has been received! We're finding a rider for you now. Hang tight! 🛵`,

  // ── Rider assigned ────────────────────────────────────────────────────────
  "order.assigned":  ({ riderName }) =>
    `🙌 A rider${riderName ? ` (*${riderName}*)` : ""} has been assigned to your order and is heading to our kitchen now!`,

  // ── Rider at kitchen ──────────────────────────────────────────────────────
  "order.awaiting_pickup": ({ riderName, riderPhone }) => {
    let msg = `🏃 Your rider${riderName ? ` *${riderName}*` : ""} is at our kitchen picking up your snacks right now!`;
    if (riderPhone) msg += `\n\nRider's number: *${riderPhone}*`;
    return msg;
  },
  "awaiting_pickup": ({ riderName, riderPhone }) => {
    let msg = `🏃 Your rider${riderName ? ` *${riderName}*` : ""} is at our kitchen picking up your snacks right now!`;
    if (riderPhone) msg += `\n\nRider's number: *${riderPhone}*`;
    return msg;
  },

  // ── Rider en route ────────────────────────────────────────────────────────
  "order.picked_up": ({ riderName, riderPhone }) => {
    let msg = `🛵 *Your order is on its way!*\n\nYour rider${riderName ? ` *${riderName}*` : ""} has picked up your Tin and Tain snacks and is heading to you now.`;
    if (riderPhone) msg += `\n\nYou can reach your rider on: *${riderPhone}*`;
    return msg;
  },
  "in_transit":      ({ riderName, riderPhone }) => {
    let msg = `🛵 *Your order is on its way!*\n\nYour rider${riderName ? ` *${riderName}*` : ""} has picked up your Tin and Tain snacks and is heading to you now.`;
    if (riderPhone) msg += `\n\nYou can reach your rider on: *${riderPhone}*`;
    return msg;
  },

  // ── Rider arrived ─────────────────────────────────────────────────────────
  "order.arrived_at_customer": ({ riderName }) =>
    `🔔 *Your rider is here!*\n\n${riderName ? `*${riderName}*` : "Your rider"} is outside your address right now. Please come out to collect your Tin and Tain order! 🥜`,
  "arrived":         ({ riderName }) =>
    `🔔 *Your rider is here!*\n\n${riderName ? `*${riderName}*` : "Your rider"} is outside your address right now. Please come out to collect your Tin and Tain order! 🥜`,

  // ── Delivered ─────────────────────────────────────────────────────────────
  "order.complete":  () =>
    `✅ *Order delivered!*\n\nEnjoy your snacks! 🥜🎉 We'd love to hear what you think — reply *REVIEW* anytime. Thank you for ordering with Tin and Tain! 🙏🏾`,
  "success":         () =>
    `✅ *Order delivered!*\n\nEnjoy your snacks! 🥜🎉 We'd love to hear what you think — reply *REVIEW* anytime. Thank you for ordering with Tin and Tain! 🙏🏾`,

  // ── Rejected (no rider found or other issue) ──────────────────────────────
  "order.rejected":  () =>
    `⚠️ We're so sorry — we had trouble assigning a rider to your order right now.\n\nOur team is on it and will reach out to you within 10 minutes to sort this out. Sincere apologies for the inconvenience! 🙏🏾`,
  "rejected":        () =>
    `⚠️ We're so sorry — we had trouble assigning a rider to your order right now.\n\nOur team is on it and will reach out to you within 10 minutes to sort this out. Sincere apologies for the inconvenience! 🙏🏾`,
};

// ── Webhook handler ───────────────────────────────────────────────────────────

router.post("/chowdeck", async (req, res) => {
  // Acknowledge immediately
  res.sendStatus(200);

  const event = req.body;

  // Chowdeck may send event name as event.type, event.event, or event.data.status
  const eventType  = event?.type || event?.event || event?.data?.status;
  const deliveryId = event?.data?.id        || event?.data?.reference || event?.delivery_id;
  const orderId    = event?.data?.reference || event?.data?.order_reference;

  // Driver info — Chowdeck uses "driver" in the GET API response
  const driver     = event?.data?.driver    || event?.data?.dispatcher || {};
  const riderName  = driver?.name  || driver?.first_name
    ? `${driver.first_name || ""} ${driver.last_name || ""}`.trim()
    : null;
  const riderPhone = driver?.phone || null;

  console.log(`📦 Chowdeck event: ${eventType} — deliveryId:${deliveryId}`);

  if (!eventType || !deliveryId) {
    console.warn("⚠️  Chowdeck webhook: missing eventType or deliveryId", event);
    return;
  }

  try {
    // Look up the customer for this delivery
    const delivery = await getDeliveryByChowdeckId(deliveryId);

    if (!delivery) {
      console.warn(`⚠️  No delivery mapping found for deliveryId:${deliveryId} — may have expired`);
      return;
    }

    const { customerPhone } = delivery;

    // Get the message builder for this event
    const messageBuilder = EVENT_MESSAGES[eventType];

    if (!messageBuilder) {
      console.log(`ℹ️  No message defined for event: ${eventType} — ignoring`);
      return;
    }

    // Build and send the WhatsApp message
    const message = messageBuilder({ riderName, riderPhone, orderId });
    await sendMessage(customerPhone, message);

    console.log(`✅ Chowdeck update sent to ${customerPhone} — event:${eventType}`);

    // Log delivery event to Supabase for analytics
    await insertDeliveryEvent({
      orderReference: delivery.orderId,
      deliveryId,
      eventType,
      riderName,
      riderPhone,
    }).catch(err => console.error("❌ Supabase delivery event failed:", err.message));

    // Update order status in both stores on key events
    const supabaseStatus = SUPABASE_STATUS[eventType];
    const airtableStatus = AIRTABLE_STATUS[eventType];
    if (supabaseStatus && delivery.orderId) {
      await Promise.allSettled([
        updateSupabaseStatus(delivery.orderId, supabaseStatus),
        airtableStatus ? updateAirtableStatus(delivery.orderId, airtableStatus) : Promise.resolve(),
      ]);
    }

    // Clean up the delivery mapping once the order is complete or rejected
    const TERMINAL_EVENTS = ["order.complete", "success", "order.rejected", "rejected"];
    if (TERMINAL_EVENTS.includes(eventType)) {
      await deleteDelivery(deliveryId);
      console.log(`🗑️  Delivery mapping cleaned up — deliveryId:${deliveryId}`);
    }

  } catch (err) {
    console.error(`❌ Error handling Chowdeck event ${eventType}:`, err);
  }
});

module.exports = router;