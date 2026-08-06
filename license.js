"use strict";
const { json, hostAllowed, requestOriginAllowed, licenseCookie } = require("./_security");
exports.handler = async (event) => {
  try {
    if (!hostAllowed(event) || !requestOriginAllowed(event)) {
      return json(403, { ok: false, message: "Domain tidak diizinkan." });
    }
    return json(200, { ok: true, domain: true }, { "Set-Cookie": licenseCookie(event) });
  } catch (e) {
    return json(e.status || 500, { ok: false, message: e.message || "Lisensi gagal." });
  }
};
