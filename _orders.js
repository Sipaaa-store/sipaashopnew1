"use strict";

const crypto = require("node:crypto");
const server = require("./_server-secrets");
const { getStore } = require("./_blobs");
const { postFayu } = require("./_fayu");

const ORDER_STORE = "sipaa-orders-v4";
const LOCK_STORE = "sipaa-order-locks-v4";
const CONFIG_STORE = "sipaa-private-config-v4";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function safeOrderId(value) {
  const id = String(value || "").trim();
  if (!/^TT-[A-Za-z0-9-]{8,80}$/.test(id)) return "";
  return id;
}

function orderKey(orderId) {
  return `order-${safeOrderId(orderId)}`;
}

async function getPakasirConfig(event) {
  const project = String(process.env.PAKASIR_PROJECT || server.pakasirProject || "").trim();
  const envKey = String(process.env.PAKASIR_API_KEY || "").trim();
  if (project && envKey) return { project, apiKey: envKey, source: "environment" };

  const store = getStore(event, CONFIG_STORE);
  const saved = await store.getJSON("pakasir-config");
  const apiKey = String(saved?.apiKey || "").trim();
  return {
    project: String(saved?.project || project).trim(),
    apiKey,
    source: apiKey ? "saved" : "missing"
  };
}

async function savePakasirConfig(event, config) {
  const store = getStore(event, CONFIG_STORE);
  const payload = {
    project: String(config.project || server.pakasirProject || "").trim(),
    apiKey: String(config.apiKey || "").trim(),
    updatedAt: new Date().toISOString()
  };
  if (!payload.project || !payload.apiKey) throw new Error("Project dan API Key Pakasir wajib diisi.");
  await store.setJSON("pakasir-config", payload);
  return { project: payload.project, configured: true, updatedAt: payload.updatedAt };
}

async function getOrder(event, orderId) {
  const id = safeOrderId(orderId);
  if (!id) return null;
  return getStore(event, ORDER_STORE).getJSON(orderKey(id));
}

async function saveOrder(event, order) {
  const id = safeOrderId(order?.orderId);
  if (!id) throw new Error("Order ID tidak valid.");
  const next = { ...order, orderId: id, updatedAt: new Date().toISOString() };
  await getStore(event, ORDER_STORE).setJSON(orderKey(id), next);
  return next;
}

async function createOrderRecord(event, order) {
  const id = safeOrderId(order?.orderId);
  if (!id) throw new Error("Order ID tidak valid.");
  const record = {
    ...order,
    orderId: id,
    createdAt: order.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const result = await getStore(event, ORDER_STORE).setJSON(orderKey(id), record, { onlyIfNew: true });
  if (!result.modified) {
    const error = new Error("Order ID sudah digunakan. Silakan ulangi.");
    error.status = 409;
    throw error;
  }
  return record;
}

function verifyClientToken(order, token) {
  if (!order?.clientTokenHash || !token) return false;
  return safeEqual(order.clientTokenHash, sha256(token));
}

async function verifyPakasirTransaction(config, order) {
  if (!config?.project || !config?.apiKey) {
    const error = new Error("API Key Pakasir belum dipasang. Buka /setup-pakasir.html satu kali.");
    error.code = "PAKASIR_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }

  const url = new URL("https://app.pakasir.com/api/transactiondetail");
  url.searchParams.set("project", config.project);
  url.searchParams.set("amount", String(order.amount));
  url.searchParams.set("order_id", order.orderId);
  url.searchParams.set("api_key", config.apiKey);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "SipaaShop-Auto/4.0" },
      signal: AbortSignal.timeout(20000)
    });
  } catch (cause) {
    const error = new Error(`Tidak dapat mengecek pembayaran Pakasir: ${cause.message}`);
    error.code = "PAKASIR_NETWORK";
    error.status = 502;
    throw error;
  }

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(`Pakasir HTTP ${response.status}`);
    error.code = "PAKASIR_HTTP";
    error.status = 502;
    error.upstream = data;
    throw error;
  }

  const tx = data?.transaction || data?.data?.transaction || data?.data || null;
  if (!tx || typeof tx !== "object") return { completed: false, transaction: null, raw: data };

  const valid =
    String(tx.project || "") === String(config.project) &&
    String(tx.order_id || "") === String(order.orderId) &&
    Number(tx.amount) === Number(order.amount);

  if (!valid) {
    const error = new Error("Detail pembayaran Pakasir tidak cocok dengan pesanan.");
    error.code = "PAYMENT_MISMATCH";
    error.status = 409;
    throw error;
  }

  return {
    completed: String(tx.status || "").toLowerCase() === "completed",
    transaction: tx,
    raw: data
  };
}

async function acquireOrderLock(event, orderId) {
  const store = getStore(event, LOCK_STORE);
  const key = `lock-${safeOrderId(orderId)}`;
  const now = Date.now();
  const lock = { orderId, createdAt: now, nonce: crypto.randomBytes(12).toString("hex") };
  const first = await store.setJSON(key, lock, { onlyIfNew: true });
  if (first.modified) return { acquired: true, lock };

  const current = await store.getJSON(key);
  if (current && Number(current.createdAt || 0) < now - 5 * 60 * 1000) {
    await store.setJSON(key, lock);
    return { acquired: true, lock, staleRecovered: true };
  }
  return { acquired: false, lock: current };
}

function findSupplierOrderId(result) {
  const values = [
    result?.order_id,
    result?.order,
    result?.id,
    result?.data?.order_id,
    result?.data?.order,
    result?.data?.id,
    result?.result?.order_id,
    result?.result?.id
  ];
  const found = values.find((value) => value !== undefined && value !== null && String(value).trim());
  return found ? String(found).trim() : "";
}

function explicitSupplierFailure(result) {
  if (!result || typeof result !== "object") return false;
  if (result.ok === false || result.success === false || result.status === false) return true;
  const status = String(result.status || result.data?.status || "").toLowerCase();
  return ["error", "failed", "canceled", "cancelled", "gagal"].includes(status);
}

function supplierMessage(result) {
  return String(result?.message || result?.msg || result?.error || result?.data?.message || "").slice(0, 500);
}

function normalizeSupplierStatus(result) {
  const raw = String(
    result?.status ?? result?.data?.status ?? result?.result?.status ?? result?.order_status ?? ""
  ).toLowerCase();

  if (["success", "completed", "complete", "selesai"].includes(raw)) return "completed";
  if (["partial"].includes(raw)) return "partial";
  if (["error", "failed", "cancel", "canceled", "cancelled", "gagal"].includes(raw)) return "failed";
  if (["pending", "processing", "in progress", "process", "diproses"].includes(raw)) return "processing";
  return "submitted";
}

async function processPaidOrder(event, orderId) {
  let order = await getOrder(event, orderId);
  if (!order) {
    const error = new Error("Pesanan tidak ditemukan.");
    error.status = 404;
    throw error;
  }

  if (["submitted", "processing", "completed", "partial", "failed", "uncertain", "supplier_failed"].includes(order.status)) {
    return order;
  }

  const config = await getPakasirConfig(event);
  const payment = await verifyPakasirTransaction(config, order);
  if (!payment.completed) return order;

  order = await saveOrder(event, {
    ...order,
    status: "payment_completed",
    paidAt: payment.transaction?.completed_at || new Date().toISOString(),
    paymentMethod: payment.transaction?.payment_method || "qris"
  });

  const lock = await acquireOrderLock(event, order.orderId);
  if (!lock.acquired) {
    return (await getOrder(event, order.orderId)) || order;
  }

  order = await saveOrder(event, { ...order, status: "processing", processingStartedAt: new Date().toISOString() });

  try {
    const result = await postFayu("order", {
      service: order.serviceId,
      target: order.target,
      quantity: order.quantity
    });

    if (explicitSupplierFailure(result)) {
      return saveOrder(event, {
        ...order,
        status: "supplier_failed",
        supplierMessage: supplierMessage(result) || "Fayupedia menolak pesanan.",
        supplierResult: result
      });
    }

    const supplierOrderId = findSupplierOrderId(result);
    return saveOrder(event, {
      ...order,
      status: normalizeSupplierStatus(result),
      supplierOrderId,
      supplierMessage: supplierMessage(result),
      supplierResult: result,
      submittedAt: new Date().toISOString()
    });
  } catch (cause) {
    // A timeout can happen after the supplier has already accepted the order.
    // Mark it uncertain instead of retrying automatically and risking a double order.
    return saveOrder(event, {
      ...order,
      status: "uncertain",
      supplierMessage: `Perlu pengecekan manual: ${cause.message}`.slice(0, 500),
      supplierErrorCode: cause.code || "FAYU_UNKNOWN"
    });
  }
}

async function refreshSupplierStatus(event, order) {
  if (!order?.supplierOrderId) return order;
  if (!["submitted", "processing"].includes(order.status)) return order;
  const last = Date.parse(order.lastSupplierCheckAt || 0) || 0;
  if (Date.now() - last < 30000) return order;

  try {
    const result = await postFayu("status", { order_id: order.supplierOrderId });
    return saveOrder(event, {
      ...order,
      status: normalizeSupplierStatus(result),
      supplierStatusResult: result,
      lastSupplierCheckAt: new Date().toISOString()
    });
  } catch {
    return saveOrder(event, { ...order, lastSupplierCheckAt: new Date().toISOString() });
  }
}

function publicOrder(order) {
  if (!order) return null;
  return {
    orderId: order.orderId,
    serviceName: order.serviceName,
    quantity: order.quantity,
    amount: order.amount,
    status: order.status,
    supplierOrderId: order.supplierOrderId || "",
    message: order.supplierMessage || "",
    createdAt: order.createdAt,
    paidAt: order.paidAt || "",
    updatedAt: order.updatedAt
  };
}

module.exports = {
  sha256,
  safeOrderId,
  getPakasirConfig,
  savePakasirConfig,
  getOrder,
  saveOrder,
  createOrderRecord,
  verifyClientToken,
  verifyPakasirTransaction,
  processPaidOrder,
  refreshSupplierStatus,
  publicOrder
};
