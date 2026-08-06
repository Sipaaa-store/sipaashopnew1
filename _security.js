"use strict";
const crypto = require("node:crypto");
const server = require("./_server-secrets");

const buckets = new Map();
function b64url(value){ return Buffer.from(value).toString("base64url"); }
function sign(value){ return crypto.createHmac("sha256",server.sessionSecret).update(value).digest("base64url"); }
function safeEqual(a,b){ const aa=Buffer.from(String(a)); const bb=Buffer.from(String(b)); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function sha256(value){ return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function getHost(event){
  const candidates=[];
  const add=(value)=>{ const raw=String(value||"").split(",")[0].trim(); if(!raw)return; try{const host=raw.includes("://")?new URL(raw).hostname:raw.replace(/:\d+$/,"");if(host)candidates.push(host.toLowerCase())}catch{} };
  add(event.headers?.["x-forwarded-host"]); add(event.headers?.host); add(event.headers?.origin); add(event.headers?.referer);
  return candidates.find(h=>server.allowedHosts.includes(h)) || candidates[0] || "";
}
function allowedHosts(){
  const set=new Set(server.allowedHosts);
  for(const raw of [process.env.URL,process.env.DEPLOY_URL,process.env.DEPLOY_PRIME_URL]){try{if(raw)set.add(new URL(raw).hostname.toLowerCase())}catch{}}
  return set;
}
function hostAllowed(event){ return allowedHosts().has(getHost(event)); }
function requestOriginAllowed(event){
  const host=getHost(event); const origin=event.headers?.origin; const referer=event.headers?.referer;
  for(const raw of [origin,referer]){ if(!raw)continue; try{if(new URL(raw).hostname.toLowerCase()!==host)return false}catch{return false} }
  return true;
}
function json(statusCode,body,extraHeaders={}){ return {statusCode,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store, max-age=0","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Vary":"Origin",...extraHeaders},body:JSON.stringify(body)}; }
function getIp(event){ return String(event.headers?.["x-nf-client-connection-ip"]||event.headers?.["x-forwarded-for"]||"unknown").split(",")[0].trim(); }
async function rateLimit(event,bucket,limit,windowSeconds){
  const key=`${bucket}/${sha256(getIp(event)).slice(0,24)}`; const now=Date.now(); const old=buckets.get(key);
  const next=(!old||old.resetAt<=now)?{count:1,resetAt:now+windowSeconds*1000}:{count:old.count+1,resetAt:old.resetAt}; buckets.set(key,next);
  if(next.count>limit){const e=new Error("Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.");e.status=429;throw e}
  if(buckets.size>2000){for(const [k,v] of buckets){if(v.resetAt<=now)buckets.delete(k)}}
}
function issueToken(payload,ttlSeconds){const data={...payload,exp:Math.floor(Date.now()/1000)+ttlSeconds};const encoded=b64url(JSON.stringify(data));return `${encoded}.${sign(encoded)}`;}
function verifyToken(token,expectedType){if(!token||!String(token).includes("."))return null;const [encoded,signature]=String(token).split(".",2);if(!safeEqual(signature,sign(encoded)))return null;try{const data=JSON.parse(Buffer.from(encoded,"base64url").toString("utf8"));if(data.exp<Math.floor(Date.now()/1000))return null;if(expectedType&&data.type!==expectedType)return null;return data}catch{return null}}
function licenseCookie(event){const token=issueToken({type:"license",host:getHost(event)},21600);return `sipaa_license=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=21600`;}
function requireSite(event){if(!hostAllowed(event)||!requestOriginAllowed(event)){const e=new Error("Domain tidak diizinkan.");e.status=403;throw e}}
function requireLicense(event){requireSite(event)}
function readJson(event){try{return JSON.parse(event.body||"{}")}catch{const e=new Error("Data yang dikirim tidak valid.");e.status=400;throw e}}
function getBearer(event){const auth=event.headers?.authorization||event.headers?.Authorization||"";return auth.startsWith("Bearer ")?auth.slice(7).trim():""}
function requireAdmin(event){requireSite(event);const data=verifyToken(getBearer(event),"admin");if(!data){const e=new Error("Sesi admin habis atau belum login.");e.status=401;throw e}return data}
async function getConfig(){return {apiId:server.apiId,apiKey:server.apiKey,adminPasswordHash:server.adminPasswordHash,version:3.3};}
function verifyPassword(password,stored){const [salt,hash]=String(stored||"").split(":");if(!salt||!hash)return false;const candidate=crypto.scryptSync(String(password),salt,64).toString("hex");return safeEqual(candidate,hash)}
module.exports={json,getHost,hostAllowed,requestOriginAllowed,requireSite,rateLimit,issueToken,verifyToken,licenseCookie,requireLicense,getConfig,verifyPassword,readJson,requireAdmin};
