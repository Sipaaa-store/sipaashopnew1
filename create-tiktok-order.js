"use strict";

const crypto = require("node:crypto");
const { json, requireSite, rateLimit, readJson, getHost } = require("./_security");
const { postFayu, findArray, normalizeService, withRetail, isTikTok, friendlyError } = require("./_fayu");
const { sha256, getPakasirConfig, createOrderRecord, publicOrder } = require("./_orders");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, message: "Gunakan POST." });

  try {
    requireSite(event);
    await rateLimit(event, "create-tiktok-order", 10, 60);
    const input = readJson(event);

    const serviceId = String(input.service || input.serviceId || "").trim();
    const target = String(input.target || "").trim();
    const quantity = Math.trunc(Number(input.quantity || 0));

    if (!serviceId) return json(400, { ok: false, message: "Pilih layanan TikTok." });
    if (!target || target.length > 500) return json(400, { ok: false, message: "Target tidak valid." });
    if (!Number.isFinite(quantity) || quantity < 1) return json(400, { ok: false, message: "Jumlah tidak valid." });

    const pakasir = await getPakasirConfig(event);
    if (!pakasir.apiKey) {
      return json(503, {
        ok: false,
        code: "PAKASIR_NOT_CONFIGURED",
        message: "Otomatisasi Pakasir belum diaktifkan. Buka /setup-pakasir.html satu kali."
      });
    }

    const raw = await postFayu("services");
    const service = findArray(raw)
      .map(normalizeService)
      .filter((item) => item.id && isTikTok(item))
      .map(withRetail)
      .find((item) => String(item.id) === serviceId);

    if (!service) return json(404, { ok: false, message: "Layanan TikTok tidak ditemukan atau sedang tidak aktif." });
    if (quantity < Number(service.min) || quantity > Number(service.max)) {
      return json(400, {
        ok: false,
        message: `Jumlah harus antara ${Number(service.min).toLocaleString("id-ID")} dan ${Number(service.max).toLocaleString("id-ID")}.`
      });
    }

    const divisor = Number(service.rateDivisor || 1000);
    const amount = Math.max(1, Math.ceil((Number(service.retailRate) * quantity) / divisor));
    const orderId = `TT-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const clientToken = crypto.randomBytes(24).toString("base64url");

    const record = await createOrderRecord(event, {
      orderId,
      project: pakasir.project,
      serviceId: String(service.id),
      serviceName: String(service.name),
      target,
      quantity,
      amount,
      status: "awaiting_payment",
      clientTokenHash: sha256(clientToken),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });

    const host = getHost(event) || "sipaashop.my.id";
    const redirect = `https://${host}/?payment_order=${encodeURIComponent(orderId)}`;
    const paymentURL = new URL(`https://app.pakasir.com/pay/${encodeURIComponent(pakasir.project)}/${amount}`);
    paymentURL.searchParams.set("order_id", orderId);
    paymentURL.searchParams.set("qris_only", "1");
    paymentURL.searchParams.set("redirect", redirect);

    return json(200, {
      ok: true,
      order: publicOrder(record),
      token: clientToken,
      paymentUrl: paymentURL.toString()
    });
  } catch (error) {
    console.error("create-tiktok-order", error);
    const known = error.code === "PAKASIR_NOT_CONFIGURED"
      ? { ok: false, code: error.code, message: error.message }
      : friendlyError(error);
    return json(error.status || 502, known);
  }
};
