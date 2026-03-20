// src/services/supabaseService.js
//
// Saves orders and delivery events to Supabase (PostgreSQL) for analytics.
//
// Two tables — run the SQL in /database/schema.sql to create them:
//
//   orders          — one row per confirmed order
//   delivery_events — one row per Chowdeck status update
//
// Uses the Supabase REST API directly (no SDK) to keep dependencies lean.

const SUPABASE_API_BASE = () => `${process.env.SUPABASE_URL}/rest/v1`;

// ── Helper ────────────────────────────────────────────────────────────────────

async function supabaseRequest(method, table, body = null, query = "") {
  const url = `${SUPABASE_API_BASE()}/${table}${query}`;

  const options = {
    method,
    headers: {
      apikey:          process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:   `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type":  "application/json",
      // Return the created/updated row
      Prefer:          "return=representation",
    },
  };

  if (body) options.body = JSON.stringify(body);

  const res  = await fetch(url, options);

  // 204 No Content is a valid success (e.g. updates with no Prefer header)
  if (res.status === 204) return null;

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `Supabase ${method} ${table} failed [${res.status}]: ${JSON.stringify(data)}`
    );
  }

  return data;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Insert a new row into the `orders` table.
 * Called once from paystack.js after payment is verified.
 *
 * @param {object} order
 * @param {string} order.reference
 * @param {string} order.customerPhone
 * @param {string} order.customerName
 * @param {string} order.deliveryAddress
 * @param {Array}  order.items
 * @param {number} order.subtotal
 * @param {number} order.deliveryFee
 * @param {number} order.totalPaid
 * @param {string} order.chowdeckId
 */
async function insertOrder(order) {
  const phone = (order.customerPhone || "").replace("whatsapp:+", "+");

  const rows = await supabaseRequest("POST", "orders", {
    reference:        order.reference,
    customer_phone:   phone,
    customer_name:    order.customerName    || null,
    delivery_address: order.deliveryAddress || null,
    items:            order.items           || [],   // stored as JSONB
    subtotal:         order.subtotal        || 0,
    delivery_fee:     order.deliveryFee     || 0,
    total_paid:       order.totalPaid       || 0,
    chowdeck_id:      order.chowdeckId      || null,
    status:           "paid",
  });

  const row = Array.isArray(rows) ? rows[0] : rows;
  console.log(`✅ Supabase: order inserted — id:${row?.id} ref:${order.reference}`);
  return row;
}

/**
 * Update the status of an existing order.
 * Called from chowdeck.js on delivery status changes.
 *
 * @param {string} reference  - Paystack order reference
 * @param {string} status     - New status: dispatched | in_transit | delivered | rejected
 */
async function updateOrderStatus(reference, status) {
  await supabaseRequest(
    "PATCH",
    `orders?reference=eq.${encodeURIComponent(reference)}`,
    { status }
  );
  console.log(`✅ Supabase: order ${reference} status → ${status}`);
}

/**
 * Insert a row into the `delivery_events` table.
 * Called from chowdeck.js on every rider status event.
 * This is the source of truth for delivery time analytics.
 *
 * @param {object} event
 * @param {string} event.orderReference  - Paystack order reference
 * @param {string} event.deliveryId      - Chowdeck delivery ID
 * @param {string} event.eventType       - e.g. "order.picked_up" or "in_transit"
 * @param {string} [event.riderName]
 * @param {string} [event.riderPhone]
 */
async function insertDeliveryEvent({ orderReference, deliveryId, eventType, riderName, riderPhone }) {
  const rows = await supabaseRequest("POST", "delivery_events", {
    order_reference: orderReference,
    delivery_id:     deliveryId,
    event_type:      eventType,
    rider_name:      riderName  || null,
    rider_phone:     riderPhone || null,
  });

  const row = Array.isArray(rows) ? rows[0] : rows;
  console.log(`✅ Supabase: delivery event logged — ${eventType} ref:${orderReference}`);
  return row;
}

/**
 * Update the Chowdeck delivery ID on an order once a rider is dispatched.
 */
async function updateChowdeckId(reference, chowdeckId) {
  await supabaseRequest(
    "PATCH",
    `orders?reference=eq.${encodeURIComponent(reference)}`,
    { chowdeck_id: chowdeckId }
  );
}

module.exports = { insertOrder, updateOrderStatus, updateChowdeckId, insertDeliveryEvent };
