// src/services/chowdeckService.js
//
// Chowdeck delivery API — fee quote and rider dispatch.
//
// Flow:
//   1. POST /delivery/fee  → returns fee amount + fee_id
//   2. POST /delivery      → pass fee_id to dispatch a rider

const CHOWDECK_API_BASE = "https://api.chowdeck.com";

// ── Geocoding ─────────────────────────────────────────────────────────────────

/**
 * Convert a text address to lat/lng using Nominatim (free, no API key).
 * Appends ", Lagos, Nigeria" to improve accuracy for local addresses.
 */
async function geocodeAddress(address) {
  // Append Lagos context if not already present
  const baseAddress = address.toLowerCase().includes("lagos")
    ? address
    : `${address}, Lagos, Nigeria`;

  // Build a list of progressively simpler queries to try
  // This handles cases where the specific estate/building isn't in Nominatim
  const queries = [baseAddress];

  // If address has commas, try stripping the first part (estate/building name)
  const parts = baseAddress.split(",").map(p => p.trim());
  if (parts.length >= 3) {
    queries.push(parts.slice(1).join(", "));   // drop first part
  }
  if (parts.length >= 4) {
    queries.push(parts.slice(2).join(", "));   // drop first two parts
  }
  // Always try just the area + Lagos as last resort
  queries.push(`${parts[parts.length - 3] || parts[0]}, Lagos, Nigeria`);

  for (const query of queries) {
    console.log(`📍 Geocoding attempt: "${query}"`);

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=ng`;

    const res  = await fetch(url, {
      headers: {
        "User-Agent": "TinAndTainBot/1.0 (orders@tinandtain.com)",
      },
    });

    const data = await res.json();

    if (data?.[0]) {
      console.log(`✅ Geocoded "${address}" → ${data[0].lat}, ${data[0].lon} (via "${query}")`);
      return {
        latitude:  String(data[0].lat),
        longitude: String(data[0].lon),
      };
    }
  }

  throw new Error(
    `Geocoding failed for "${address}" — could not find location. ` +
    `Please ask the customer to provide a more specific address (e.g. street name and area).`
  );
}

// ── Internal helper ───────────────────────────────────────────────────────────

async function chowdeckRequest(method, path, body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${process.env.CHOWDECK_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };

  if (body) options.body = JSON.stringify(body);

  const res  = await fetch(`${CHOWDECK_API_BASE}${path}`, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `Chowdeck ${method} ${path} failed [${res.status}]: ${data.message || JSON.stringify(data)}`
    );
  }

  return data;
}

function merchantPath(suffix = "") {
  const ref = process.env.CHOWDECK_MERCHANT_REF;
  if (!ref) throw new Error("CHOWDECK_MERCHANT_REF is not set in environment");
  return `/merchant/${ref}${suffix}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get a delivery fee quote.
 * Returns the fee amount AND the fee_id — both needed for createDelivery.
 *
 * @param {string} deliveryAddress  - Customer's text address in Lagos
 * @param {number} orderAmountNaira - Items subtotal (optional)
 * @returns {Promise<{ fee: number, feeId: number, currency: string }>}
 */
async function getDeliveryFee(deliveryAddress, orderAmountNaira = 0) {
  console.log(`🚚 Chowdeck: getting delivery fee for "${deliveryAddress}"`);

  // Geocode both addresses to lat/lng
  const [sourceCoords, destCoords] = await Promise.all([
    geocodeAddress(process.env.PICKUP_ADDRESS),
    geocodeAddress(deliveryAddress),
  ]);

  const data = await chowdeckRequest(
    "POST",
    merchantPath("/delivery/fee"),
    {
      source_address:         sourceCoords,       // { latitude, longitude }
      destination_address:    destCoords,          // { latitude, longitude }
      estimated_order_amount: orderAmountNaira,
    }
  );

  const responseData = data?.data ?? data;

  // Real response: { id, total_amount, delivery_amount, service_amount, safety_fee }
  const fee   = responseData?.delivery_amount ?? responseData?.fee ?? responseData?.total_amount;
  const feeId = responseData?.id;

  if (fee == null) {
    throw new Error(`Chowdeck fee response missing fee field: ${JSON.stringify(data)}`);
  }

  console.log(`✅ Chowdeck: delivery fee = ₦${Number(fee / 100).toLocaleString()} feeId:${feeId}`);
  return { fee: Number(fee / 100), feeId, currency: "NGN" };
}

/**
 * Create a delivery order — dispatches a Chowdeck rider.
 * Must be called with the feeId returned from getDeliveryFee.
 *
 * @param {object} params
 * @param {string} params.orderId
 * @param {string} params.customerName
 * @param {string} params.customerPhone   - e.g. +2348012345678
 * @param {string} params.customerEmail   - optional
 * @param {string} params.deliveryAddress - text address (for the note)
 * @param {number} params.feeId           - from getDeliveryFee()
 * @param {number} params.subtotal
 * @param {Array}  params.items
 */
async function createDelivery({
  orderId,
  customerName,
  customerPhone,
  customerEmail = "",
  deliveryAddress,
  feeId,
  subtotal = 0,
  items = [],
}) {
  console.log(`🛵 Chowdeck: dispatching rider for order ${orderId}`);

  const itemsSummary = items.length
    ? items.map((i) => `${i.qty}x ${i.name}`).join(", ")
    : "Tin and Tain snacks";

  // Strip whatsapp: prefix and country code formatting if present
  const cleanPhone = customerPhone
    .replace("whatsapp:+", "")
    .replace("+", "");

  const data = await chowdeckRequest(
    "POST",
    merchantPath("/delivery"),
    {
      source_contact: {
        name:         "Tin and Tain",
        phone:        (process.env.PICKUP_PHONE || "").replace("+", ""),
        email:        process.env.PICKUP_EMAIL || "",
        country_code: "NG",
      },
      destination_contact: {
        name:         customerName,
        phone:        cleanPhone,
        email:        customerEmail,
        country_code: "NG",
      },
      customer_delivery_note: `Order ${orderId}: ${itemsSummary}`,
      customer_vendor_note:   `Tin and Tain order ref: ${orderId}`,
      fee_id:                 feeId,
      item_type:              "food",
      user_action:            "sending",
      reference:              orderId,
      estimated_order_amount: subtotal,
    }
  );

  const deliveryId = data?.data?.id       ?? data?.id;
  const trackingId = data?.data?.tracking_id ?? data?.tracking_id ?? deliveryId;
  const status     = data?.data?.status   ?? data?.status ?? "created";

  console.log(`✅ Chowdeck: rider dispatched — deliveryId:${deliveryId} status:${status}`);

  return { deliveryId, trackingId, status };
}

/**
 * Fetch the current status of a delivery by reference.
 */
async function getDelivery(reference) {
  const res  = await fetch(`${CHOWDECK_API_BASE}/delivery/${reference}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.CHOWDECK_API_KEY}`,
      Accept: "application/json",
    },
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `Chowdeck GET /delivery/${reference} failed [${res.status}]: ${data.message || JSON.stringify(data)}`
    );
  }

  const d = data.data;

  return {
    id:                        d.id,
    reference:                 d.reference,
    status:                    d.status,
    summary:                   d.summary,
    deliveryPrice:             d.delivery_price,
    totalPrice:                d.total_price,
    currency:                  d.currency,
    driver:                    d.driver             || null,
    customer:                  d.customer           || null,
    items:                     d.items              || [],
    timeline:                  d.timeline           || [],
    customerAddress:           d.customer_address   || null,
    vendorAddress:             d.vendor_address     || null,
    vendorInformation:         d.vendor_information || null,
    createdAt:                 d.created_at,
    updatedAt:                 d.updated_at,
    timePaymentConfirmed:      d.time_payment_confirmed       || null,
    timeCustomerReceivedOrder: d.time_customer_received_order || null,
    actualDeliveryTime:        d.actual_delivery_time         || null,
  };
}

module.exports = { getDeliveryFee, createDelivery, getDelivery };