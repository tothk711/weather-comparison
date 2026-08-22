// Fetch layer with a real TTL.
//
// v2.0's cityDataCache had no expiry at all — it was cleared only by the manual
// refresh button, so a dashboard left open all day happily served the morning's
// numbers while the header still read "Last updated". Entries now expire, and
// error payloads are never cached as if they were data.

const TTL_MS = 5 * 60 * 1000;
const store = new Map();

export async function getJson(url, { ttlMs = TTL_MS, force = false } = {}) {
  const hit = store.get(url);
  if (!force && hit && (Date.now() - hit.ts) < ttlMs) return hit.value;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (body && body.error) throw new Error(body.error);
  store.set(url, { value: body, ts: Date.now() });
  return body;
}

export function clearApiCache() { store.clear(); }

export async function postJson(url) {
  const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

// Is this a usable weather payload rather than an error object?
export const isWeatherPayload = d => !!(d && d.today && Array.isArray(d.today.temps));
