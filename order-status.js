"use strict";

const { json, requireSite, rateLimit } = require("./_security");
const {
  safeOrderId,
  getOrder,
  verifyClientToken,
  processPaidOrder,
  refreshSupplierStatus,
  publicOrder
} = require("./_orders");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { ok: false, message: "Gunakan GET." });

  try {
    requireSite(event);
    await rateLimit(event, "order-status", 60, 60);
    const orderId = safeOrderId(event.queryStringParameters?.order_id);
    const token = String(event.queryStringParameters?.token || "");
    if (!orderId || !token) return json(400, { ok: false, message: "Order ID atau token tidak lengkap." });

    let order = await getOrder(event, orderId);
    if (!order || !verifyClientToken(order, token)) {
      return json(404, { ok: false, message: "Pesanan tidak ditemukan." });
    }

    if (["awaiting_payment", "payment_completed"].includes(order.status)) {
      try {
        order = await processPaidOrder(event, order.orderId);
      } catch (error) {
        if (error.code !== "PAKASIR_NOT_CONFIGURED" && error.code !== "PAKASIR_NETWORK") throw error;
      }
    }

    order = await refreshSupplierStatus(event, order);
    return json(200, { ok: true, order: publicOrder(order) });
  } catch (error) {
    console.error("order-status", error);
    return json(error.status || 502, { ok: false, code: error.code || "ORDER_STATUS_ERROR", message: error.message });
  }
};
