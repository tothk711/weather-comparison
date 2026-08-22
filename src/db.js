'use strict';
// Postgres is a CACHE, not the source of truth. Every access is guarded and
// backed by memory, so the app serves data with the database completely gone.

const { Pool } = require('pg');
const { config } = require('./config');
const logger = require('./logger');

let pool = null;
let ready = false;
let lastError = null;

if (config.db.enabled) {
  pool = new Pool({
    connectionString: config.db.url,
    ssl: { rejectUnauthorized: config.db.sslStrict },
    connectionTimeoutMillis: config.db.connectionTimeoutMs,
    max: config.db.maxClients,
  });
  // An idle-client error (a DB restart, a Railway redeploy) must never take
  // the process down with it.
  pool.on('error', err => {
    lastError = err.message;
    ready = false;
    logger.error('postgres pool error — falling back to memory cache', { err: err.message });
  });
}

async function init() {
  if (!config.db.enabled) {
    logger.warn('DATABASE_URL not set — in-memory cache only, nothing survives a restart');
    return false;
  }
  try {
    // updated_at is TIMESTAMPTZ, not TIMESTAMP.
    //
    // v2.0 used `TIMESTAMP` (without time zone) and wrote it with NOW().
    // node-postgres parses that type using the NODE process's local zone, so if
    // the Postgres session zone and the container's TZ ever differ — a UTC
    // Railway container with TZ=Europe/Prague is the obvious case — every row
    // reads 1-2 h off. The cache then looks permanently stale and EVERY request
    // triggers a fresh upstream fetch: precisely the rate-limit collapse the
    // v1.4.1 changelog documents. TIMESTAMPTZ is unambiguous.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS weather_cache (
        id SERIAL PRIMARY KEY,
        city_name VARCHAR(50) NOT NULL UNIQUE,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Migrate an existing v2.0 table in place. Existing rows were written with
    // NOW() under the server's session zone, so that is the zone to interpret
    // them in; being an hour off for one refresh cycle is harmless, and every
    // row is overwritten within 6 hours anyway.
    const { rows } = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'weather_cache' AND column_name = 'updated_at'
    `);
    if (rows.length && rows[0].data_type === 'timestamp without time zone') {
      logger.warn('migrating weather_cache.updated_at TIMESTAMP -> TIMESTAMPTZ');
      await pool.query(`
        ALTER TABLE weather_cache
        ALTER COLUMN updated_at TYPE TIMESTAMPTZ
        USING updated_at AT TIME ZONE current_setting('TimeZone')
      `);
      await pool.query(`ALTER TABLE weather_cache ALTER COLUMN updated_at SET DEFAULT NOW()`);
      logger.info('weather_cache.updated_at migrated to TIMESTAMPTZ');
    }
    ready = true;
    lastError = null;
    logger.info('database ready');
    return true;
  } catch (err) {
    lastError = err.message;
    ready = false;
    logger.error('database unavailable — continuing on the memory cache', { err: err.message });
    return false;
  }
}

async function query(text, params) {
  if (!pool) throw new Error('database not configured');
  return pool.query(text, params);
}

function isReady() { return ready; }
function status() {
  return { configured: config.db.enabled, ready, lastError, sslStrict: config.db.sslStrict };
}
async function close() { if (pool) await pool.end().catch(() => {}); }

module.exports = { init, query, isReady, status, close };
