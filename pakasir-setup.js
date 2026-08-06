"use strict";

const server = require("./_server-secrets");
const { json, requireSite, rateLimit, readJson, verifyPassword, getHost } = require("./_security");
const { getPakasirConfig, savePakasirConfig } = require("./_orders");

exports.handler = async (event) => {
  try {
    requireSite(event);

    if (event.httpMethod === "GET") {
      const config = await getPakasirConfig(event);
      const host = getHost(event) || "sipaashop.my.id";
      return json(200, {
        ok: true,
        configured: Boolean(config.apiKey),
        project: config.project || server.pakasirProject,
        webhookUrl: `https://${host}/.netlify/functions/pakasir-webhook`
      });
    }

    if (event.httpMethod !== "POST") return json(405, { ok: false, message: "Gunakan GET atau POST." });
    await rateLimit(event, "pakasir-setup", 8, 300);
    const input = readJson(event);
    if (!verifyPassword(input.password, server.adminPasswordHash)) {
      return json(401, { ok: false, message: "Password admin salah." });
    }

    const apiKey = String(input.apiKey || "").trim();
    if (apiKey.length < 8 || apiKey.length > 300) {
      return json(400, { ok: false, message: "API Key Pakasir tidak valid." });
    }

    const saved = await savePakasirConfig(event, { project: server.pakasirProject, apiKey });
    const host = getHost(event) || "sipaashop.my.id";
    return json(200, {
      ok: true,
      ...saved,
      webhookUrl: `https://${host}/.netlify/functions/pakasir-webhook`
    });
  } catch (error) {
    console.error("pakasir-setup", error);
    return json(error.status || 500, { ok: false, code: error.code || "SETUP_ERROR", message: error.message });
  }
};
