#!/usr/bin/env node
const baseUrl = process.env.VILI_URL || process.argv[2] || "http://10.77.0.4:8824";

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return body;
}

const health = await get("/health");
const providers = await get("/eve/deck/providers");
const smoke = await get("/smoke");

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  health: {
    service: health.service,
    providerId: health.providerId,
    backend: health.state?.backend,
  },
  providers,
  smoke: {
    ok: smoke.ok,
    backend: smoke.backendStatus,
  },
}, null, 2));
