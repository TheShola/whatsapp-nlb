// src/services/airtableService.js
//
// Saves each confirmed order to an Airtable base.
// One record per order — gives you a clean, human-readable orders dashboard.
//
// Required Airtable table columns (create these in your base):
//   Order ID          Single line text
//   Customer Name     Single line text
//   Phone             Phone number (or Single line text)
//   Delivery Address  Long text
//   Items             Long text
//   Subtotal          Currency (NGN)
//   Delivery Fee      Currency (NGN)
//   Total Paid        Currency (NGN)
//   Chowdeck ID       Single line text
//   Status            Single select: Paid | Dispatched | Delivered | Rejected
//   Order Date        Date (include time)

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

// ── Helper ────────────────────────────────────────────────────────────────────

async function airtableRequest(method, path, body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res  = await fetch(`${AIRTABLE_API_BASE}${path}`, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `Airtable ${method} ${path} failed [${res.status}]: ${data.error?.message || JSON.stringify(data)}`
    );
  }

  return data;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new order record in Airtable.
 * Called once from paystack.js after payment is verified.
 *
 * @param {object} order
 * @param {string} order.reference        - Paystack order reference e.g. TT-ABC-1234
 * @param {string} order.customerName     - Customer full name
 * @param {string} order.customerPhone    - WhatsApp number e.g. whatsapp:+2348012345678
 * @param {string} order.deliveryAddress  - Delivery address in Lagos
 * @param {Array}  order.items            - [{name, qty, unitPrice}]
 * @param {number} order.subtotal         - Items subtotal in Naira
 * @param {number} order.deliveryFee      - Delivery fee in Naira
 * @param {number} order.totalPaid        - Total charged in Naira
 * @param {string} order.chowdeckId       - Chowdeck delivery ID (may be null if dispatch failed)
 * @returns {Promise<{ airtableId: string }>}
 */
async function createOrderRecord(order) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table  = encodeURIComponent(process.env.AIRTABLE_ORDERS_TABLE || "Orders");

  // Format items as a readable string for the long-text field
  const itemsText = (order.items || []).length
    ? order.items.map((i) => `${i.qty || 1}x ${i.name} @ ₦${(i.unitPrice || 0).toLocaleString()}`).join("\n")
    : "—";

  const phone = (order.customerPhone || "").replace("whatsapp:+", "+");

  const data = await airtableRequest("POST", `/${baseId}/${table}`, {
    fields: {
      "Order ID":         order.reference,
      "Customer Name":    order.customerName  || "—",
      "Phone":            phone,
      "Delivery Address": order.deliveryAddress || "—",
      "Items":            itemsText,
      "Subtotal":         order.subtotal    || 0,
      "Delivery Fee":     order.deliveryFee || 0,
      "Total Paid":       order.totalPaid   || 0,
      "Chowdeck ID":      order.chowdeckId  || "—",
      "Status":           "Paid",
      "Order Date":       new Date().toISOString(),
    },
  });

  console.log(`✅ Airtable: order record created — ${data.id} ref:${order.reference}`);
  return { airtableId: data.id };
}

/**
 * Update the Status field on an existing order record.
 * Called from chowdeck.js on terminal delivery events.
 *
 * @param {string} reference  - Paystack order reference
 * @param {string} status     - New status: Dispatched | Delivered | Rejected
 */
async function updateOrderStatus(reference, status) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table  = encodeURIComponent(process.env.AIRTABLE_ORDERS_TABLE || "Orders");

  // Find the record by Order ID field first
  const search = await airtableRequest(
    "GET",
    `/${baseId}/${table}?filterByFormula=${encodeURIComponent(`{Order ID}="${reference}"`)}&maxRecords=1`
  );

  const record = search.records?.[0];
  if (!record) {
    console.warn(`⚠️  Airtable: no record found for ref:${reference} — skipping status update`);
    return;
  }

  await airtableRequest("PATCH", `/${baseId}/${table}/${record.id}`, {
    fields: { "Status": status },
  });

  console.log(`✅ Airtable: order ${reference} status → ${status}`);
}

module.exports = { createOrderRecord, updateOrderStatus };
