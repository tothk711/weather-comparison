'use strict';
// ---------------------------------------------------------------------------
// One cache abstraction for every subsystem.
//
// v2.0 had EIGHT hand-rolled caches with three different entry shapes. Only one
// coalesced concurrent requests, only four fell back to stale data on an
// upstream error, one grew without bound, and none of them could tell you
// whether they were working. All three of those gaps show up in the audit as
// live rate-limit risks.
//
// Extras this adds beyond a plain TTL map:
//   - request coalescing (N concurrent callers -> ONE upstream request)
//   - stale-on-error (an upstream blip serves the last good value, loudly)
//   - a `validate` hook, so an entry can expire for a reason other than age.
//     The weather payloads need this: they carry baked-in day labels, so a
//     payload written at 23:40 is WRONG at 00:10 even though it is 30 min old.
//   - bounded size with least-recently-used eviction
//   - hit/miss/stale counters for /api/health
// ---------------------------------------------------------------------------

const logger = require('../logger');

class TtlCache {
  constructor({ name, ttlMs, staleOnError = true, maxEntries = 200, validate = null }) {
    this.name = name;
    this.ttlMs = ttlMs;
    this.staleOnError = staleOnError;
    this.maxEntries = maxEntries;
    this.validate = validate;
    this.map = new Map();          // insertion order == LRU order
    this.inFlight = new Map();
    this.stats = { hits: 0, misses: 0, stale: 0, errors: 0, evictions: 0 };
  }

  _usable(entry) {
    if (!entry) return false;
    if (typeof this.validate === 'function') {
      try { if (!this.validate(entry.value)) return false; } catch { return false; }
    }
    return true;
  }

  _fresh(entry, ttlMs) {
    return this._usable(entry) && (Date.now() - entry.ts) < (ttlMs ?? this.ttlMs);
  }

  // Read-only peek; never triggers a fetch. Returns { value, ts, fresh }.
  peek(key) {
    const e = this.map.get(key);
    if (!e) return null;
    return { value: e.value, ts: e.ts, fresh: this._fresh(e) };
  }

  set(key, value) {
    this.map.delete(key);                 // re-insert to refresh LRU position
    this.map.set(key, { value, ts: Date.now() });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.stats.evictions++;
    }
    return value;
  }

  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  size() { return this.map.size; }

  // The main entry point. `producer` is only ever called once per key at a time.
  async get(key, producer, opts = {}) {
    const entry = this.map.get(key);
    if (this._fresh(entry, opts.ttlMs)) {
      this.stats.hits++;
      this.map.delete(key); this.map.set(key, entry); // touch for LRU
      return entry.value;
    }
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    this.stats.misses++;
    const p = (async () => {
      try {
        return this.set(key, await producer());
      } catch (err) {
        this.stats.errors++;
        // Only fall back to a stale entry that is still *valid* — serving a
        // yesterday-labelled weather payload would be worse than an error.
        if (this.staleOnError && this._usable(entry)) {
          this.stats.stale++;
          logger.warn(`${this.name}: upstream failed, serving stale`, {
            key, ageMs: Date.now() - entry.ts, err: err.message,
          });
          return entry.value;
        }
        throw err;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, p);
    return p;
  }

  snapshot() {
    return { name: this.name, entries: this.map.size, ttlMs: this.ttlMs, ...this.stats };
  }
}

// Every cache registers itself so /api/health can report all of them at once.
const registry = [];
function createCache(opts) {
  const c = new TtlCache(opts);
  registry.push(c);
  return c;
}
function allCacheStats() { return registry.map(c => c.snapshot()); }
function clearCaches(names) {
  for (const c of registry) if (!names || names.includes(c.name)) c.clear();
}

module.exports = { TtlCache, createCache, allCacheStats, clearCaches };
