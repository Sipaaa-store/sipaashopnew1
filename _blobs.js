"use strict";

function decodeBase64Json(value) {
  if (!value) return {};
  try {
    return JSON.parse(Buffer.from(String(value), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function getContext(event) {
  let context = decodeBase64Json(process.env.NETLIFY_BLOBS_CONTEXT);

  // Classic Netlify Functions (Lambda compatibility mode) expose a small
  // Blobs context on the invocation event. The official client calls this
  // connectLambda(); we do the same here without an external dependency.
  if ((!context.siteID || !context.token) && event?.blobs) {
    const data = decodeBase64Json(event.blobs);
    context = {
      ...context,
      deployID: event.headers?.["x-nf-deploy-id"],
      edgeURL: data.url || data.edgeURL,
      siteID: event.headers?.["x-nf-site-id"],
      token: data.token
    };
  }

  if (!context.siteID || !context.token) {
    const error = new Error("Penyimpanan pesanan Netlify belum tersedia pada fungsi ini.");
    error.code = "BLOBS_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }

  return context;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value)).replace(/%3A/gi, ":");
}

function buildPath(context, storeName, key) {
  const parts = [context.siteID, `site:${storeName}`];
  if (key) parts.push(...String(key).split("/").filter(Boolean));
  return "/" + parts.map(encodeSegment).join("/");
}

async function signedApiRequest(context, method, path, body, headers) {
  const apiBase = context.apiURL || "https://api.netlify.com";
  const apiURL = new URL(`/api/v1/blobs${path}`, apiBase);
  const authHeaders = {
    Authorization: `Bearer ${context.token}`,
    Accept: "application/json;type=signed-url"
  };

  if (["HEAD", "DELETE"].includes(method)) {
    return fetch(apiURL, { method, headers: { ...authHeaders, ...headers } });
  }

  const signed = await fetch(apiURL, { method, headers: authHeaders });
  if (!signed.ok) {
    const detail = await signed.text().catch(() => "");
    throw new Error(`Netlify Blobs gagal membuat signed URL (${signed.status}) ${detail}`.trim());
  }
  const payload = await signed.json();
  if (!payload?.url) throw new Error("Netlify Blobs tidak mengembalikan signed URL.");
  return fetch(payload.url, { method, body, headers });
}

function getStore(event, storeName) {
  const context = getContext(event);

  async function request(method, key = "", body, headers = {}, search = {}) {
    const path = buildPath(context, storeName, key);

    if (context.edgeURL) {
      const url = new URL(path, context.edgeURL);
      for (const [name, value] of Object.entries(search)) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
      }
      return fetch(url, {
        method,
        body,
        headers: {
          Authorization: `Bearer ${context.token}`,
          ...headers
        }
      });
    }

    if (Object.keys(search).length) {
      const apiBase = context.apiURL || "https://api.netlify.com";
      const url = new URL(`/api/v1/blobs${path}`, apiBase);
      for (const [name, value] of Object.entries(search)) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
      }
      return fetch(url, {
        method,
        headers: { Authorization: `Bearer ${context.token}`, ...headers }
      });
    }

    return signedApiRequest(context, method, path, body, headers);
  }

  return {
    async getJSON(key) {
      const response = await request("GET", key, undefined, { Accept: "application/json" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Gagal membaca data pesanan (${response.status}).`);
      const text = await response.text();
      if (!text) return null;
      return JSON.parse(text);
    },

    async setJSON(key, value, options = {}) {
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "max-age=0, stale-while-revalidate=60"
      };
      if (options.onlyIfNew) headers["If-None-Match"] = "*";
      const response = await request("PUT", key, JSON.stringify(value), headers);
      if (response.status === 409 || response.status === 412) return { modified: false };
      if (![200, 201, 204].includes(response.status)) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Gagal menyimpan data pesanan (${response.status}) ${detail}`.trim());
      }
      return { modified: true, etag: response.headers.get("etag") || undefined };
    },

    async delete(key) {
      const response = await request("DELETE", key);
      if (![200, 204, 404].includes(response.status)) {
        throw new Error(`Gagal menghapus data pesanan (${response.status}).`);
      }
    },

    async list(prefix = "") {
      const response = await request("GET", "", undefined, { Accept: "application/json" }, prefix ? { prefix } : {});
      if (!response.ok) throw new Error(`Gagal membaca daftar pesanan (${response.status}).`);
      return response.json();
    }
  };
}

module.exports = { getStore };
