'use strict';
// ---------------------------------------------------------------------------
// The one Open-Meteo / MET Norway client.
//
// v2.0 built URLs as inline template strings in ten places and reimplemented
// "fetch, check .ok, check payload.error, catch" in every subsystem. There was
// no retry, no backoff and no concurrency ceiling — despite TWO changelog
// entries about being rate-limited off the API.
//
// This module owns: URL building, the 15 s timeout, retry with exponential
// backoff on the errors that are worth retrying, a per-host concurrency gate,
// and turning Open-Meteo's "HTTP 200 with {error:true}" into a real throw.
// ---------------------------------------------------------------------------

const { config } = require('../config');
const logger = require('../logger');

const up = config.upstream;

// ---- per-host concurrency gate ---------------------------------------------
// A cold start can otherwise fire 8 cities × several endpoints at once.
const gates = new Map();
function gateFor(host) {
  if (!gates.has(host)) gates.set(host, { active: 0, queue: [] });
  return gates.get(host);
}
async function withGate(host, fn) {
  const g = gateFor(host);
  if (g.active >= up.maxConcurrentPerHost) {
    await new Promise(resolve => g.queue.push(resolve));
  }
  g.active++;
  try {
    return await fn();
  } finally {
    g.active--;
    const next = g.queue.shift();
    if (next) next();
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 429 and 5xx are worth retrying; 400/404 are our own bug and never are.
function retryable(status) {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

function buildUrl(base, params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : v)}`)
    .join('&');
  return qs ? `${base}?${qs}` : base;
}

const metrics = { requests: 0, retries: 0, failures: 0, byHost: {} };

// Fetch JSON from an upstream host with timeout + retry + backoff.
//   hostKey : key into config.upstream.hosts
//   params  : query params object (arrays are comma-joined)
//   opts    : { headers, retries, label }
async function fetchJson(hostKey, params = {}, opts = {}) {
  const base = up.hosts[hostKey];
  if (!base) throw new Error(`Unknown upstream host "${hostKey}"`);
  const url = buildUrl(base, params);
  const maxRetries = opts.retries ?? up.retries;
  const label = opts.label || hostKey;

  return withGate(hostKey, async () => {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = up.retryBaseMs * 2 ** (attempt - 1);
        metrics.retries++;
        logger.debug('upstream retry', { host: hostKey, label, attempt, waitMs: wait });
        await sleep(wait);
      }
      try {
        metrics.requests++;
        metrics.byHost[hostKey] = (metrics.byHost[hostKey] || 0) + 1;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(up.timeoutMs),
          headers: opts.headers || undefined,
        });
        if (!res.ok) {
          const err = new Error(`${label}: HTTP ${res.status}`);
          err.status = res.status;
          if (retryable(res.status) && attempt < maxRetries) { lastErr = err; continue; }
          throw err;
        }
        const json = await res.json();
        // Open-Meteo reports problems as { error: true, reason } with a 200.
        if (json && json.error) throw new Error(`${label}: ${json.reason || 'API error'}`);
        return json;
      } catch (err) {
        lastErr = err;
        const isAbort = err.name === 'TimeoutError' || err.name === 'AbortError';
        const isNetwork = err instanceof TypeError || isAbort;
        if ((isNetwork || retryable(err.status)) && attempt < maxRetries) continue;
        metrics.failures++;
        throw lastErr;
      }
    }
    metrics.failures++;
    throw lastErr;
  });
}

// Pull each model's series out of a multi-model response. With several models
// requested Open-Meteo suffixes every variable (temperature_2m_<model>); with a
// single one the name stays plain. A model with no coverage for a location
// simply has no array — it is skipped, never fatal.
function extractModelSeries(raw, field, ids) {
  const h = (raw && raw.hourly) || {};
  if (!Array.isArray(h.time)) return [];
  const out = [];
  for (const id of ids) {
    const arr = Array.isArray(h[`${field}_${id}`]) ? h[`${field}_${id}`]
              : (ids.length === 1 && Array.isArray(h[field]) ? h[field] : null);
    if (arr) out.push({ model: id, time: h.time, values: arr });
  }
  if (!out.length && Array.isArray(h[field])) {
    out.push({ model: ids[0] || 'best_match', time: h.time, values: h[field] });
  }
  return out;
}

// Same idea for daily variables, which are suffixed identically.
function extractDailySeries(raw, field, ids) {
  const d = (raw && raw.daily) || {};
  if (!Array.isArray(d.time)) return [];
  const out = [];
  for (const id of ids) {
    const arr = Array.isArray(d[`${field}_${id}`]) ? d[`${field}_${id}`]
              : (ids.length === 1 && Array.isArray(d[field]) ? d[field] : null);
    if (arr) out.push({ model: id, time: d.time, values: arr });
  }
  if (!out.length && Array.isArray(d[field])) {
    out.push({ model: ids[0] || 'best_match', time: d.time, values: d[field] });
  }
  return out;
}

const MODEL_LABELS = {
  best_match: 'Open-Meteo', ecmwf_ifs025: 'ECMWF', ecmwf_ifs04: 'ECMWF',
  icon_seamless: 'DWD ICON', gfs_seamless: 'NOAA GFS',
  meteofrance_seamless: 'Météo-France', ukmo_seamless: 'UK Met Office',
};
function modelLabel(id) { return MODEL_LABELS[id] || id; }

function upstreamMetrics() { return { ...metrics, byHost: { ...metrics.byHost } }; }

module.exports = { fetchJson, buildUrl, extractModelSeries, extractDailySeries, modelLabel, upstreamMetrics };
