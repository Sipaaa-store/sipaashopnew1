"use strict";

const { json, hostAllowed, readJson, rateLimit } = require("./_security");
const { safeOrderId, getOrder, processPaidOrder, publicOrder } = require("./_orders");
const server = require("./_server-secrets");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, message: "Gunakan POST." });

  try {
    if (!hostAllowed(event)) return json(403, { ok: false, message: "Host tidak diizinkan." });
    await rateLimit(event, "pakasir-webhook", 120, 60);
    let payload;
    try {
      payload = readJson(event);
    } catch {
      payload = Object.fromEntries(new URLSearchParams(String(event.body || "")));
    }

    const orderId = safeOrderId(payload.order_id);
    const project = String(payload.project || "");
    const status = String(payload.status || "").toLowerCase();
    const amount = Number(payload.amount);

    if (!orderId || project !== String(server.pakasirProject) || !Number.isFinite(amount)) {
      return json(400, { ok: false, message: "Payload webhook tidak valid." });
    }

    const order = await getOrder(event, orderId);
    if (!order) return json(404, { ok: false, message: "Pesanan tidak ditemukan." });
    if (Number(order.amount) !== amount) return json(409, { ok: false, message: "Nominal pembayaran tidak cocok." });

    if (status !== "completed") {
      return json(200, { ok: true, ignored: true, message: "Status pembayaran belum completed." });
    }

    const processed = await processPaidOrder(event, orderId);
    return json(200, { ok: true, order: publicOrder(processed) });
  } catch (error) {
    console.error("pakasir-webhook", error);
    // Return a non-2xx response for temporary verification failures so the
    // payment service can retry. Idempotency is enforced by the order lock.
    return json(error.status || 500, { ok: false, code: error.code || "WEBHOOK_ERROR", message: error.message });
  }
};
