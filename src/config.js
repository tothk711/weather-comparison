'use strict';
// ---------------------------------------------------------------------------
// Single source of configuration truth.
//
// v2.0 had ~10 module-level literals scattered across a 2,000-line file with no
// validation and two hand-maintained copies of the model list. Everything now
// lives here, is env-overridable, and is validated once at startup so a bad
// deploy fails loudly instead of silently degrading.
// ---------------------------------------------------------------------------

const path = require('path');
const pkg = require('../package.json');

const bool = (v, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
};
const int = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

// All day/hour math happens in this zone: the upstream API is asked for it
// (&timezone=Europe/Prague), so day boundaries must be computed in it too.
const APP_TIMEZONE = 'Europe/Prague';

// The model set used for the Global median. ONE list — the Weekly tab and the
// Graphs used to keep two copies in sync by hand (there was a unit test whose
// only job was to police the duplication).
const MODELS = [
  { id: 'best_match',           label: 'Open-Meteo' },
  { id: 'ecmwf_ifs025',         label: 'ECMWF' },
  { id: 'icon_seamless',        label: 'DWD ICON' },
  { id: 'gfs_seamless',         label: 'NOAA GFS' },
  { id: 'meteofrance_seamless', label: 'Météo-France' },
  // MET Norway's Nordic domain does not cover CZ/HU, so asking Open-Meteo for
  // it only burned rate-limit budget (v1.4.1 incident). Its own API is still
  // used by the cross-check, where it is a genuinely independent provider.
];

const config = {
  app: {
    name: 'Zephyr Weather',
    version: pkg.version,
    port: int(process.env.PORT, 3000),
    publicDir: path.resolve(__dirname, '..', 'public'),
    timezone: APP_TIMEZONE,
    // Railway (and most containers) run UTC. Every schedule is pinned to the
    // app timezone so the 6-hourly refresh does not drift against the data.
    refreshCron: process.env.REFRESH_CRON || '0 */6 * * *',
  },

  db: {
    url: process.env.DATABASE_URL || '',
    enabled: !!process.env.DATABASE_URL,
    // Railway's managed Postgres presents a certificate the public proxy
    // cannot chain, so verification is off by default to keep existing
    // deploys working. Set PGSSL_STRICT=1 once you are on a verifiable cert.
    sslStrict: bool(process.env.PGSSL_STRICT, false),
    connectionTimeoutMs: int(process.env.PG_CONNECT_TIMEOUT_MS, 8000),
    maxClients: int(process.env.PG_POOL_MAX, 5),
  },

  upstream: {
    timeoutMs: int(process.env.UPSTREAM_TIMEOUT_MS, 15000),
    retries: int(process.env.UPSTREAM_RETRIES, 2),
    retryBaseMs: int(process.env.UPSTREAM_RETRY_BASE_MS, 400),
    // Hard ceiling on simultaneous requests to one upstream host. Two separate
    // rate-limit outages (v1.4.0, v1.4.1) came from unbounded fan-out.
    maxConcurrentPerHost: int(process.env.UPSTREAM_MAX_CONCURRENT, 6),
    hosts: {
      forecast:           'https://api.open-meteo.com/v1/forecast',
      previousRuns:       'https://previous-runs-api.open-meteo.com/v1/forecast',
      archive:            'https://archive-api.open-meteo.com/v1/archive',
      historicalForecast: 'https://historical-forecast-api.open-meteo.com/v1/forecast',
      geocoding:          'https://geocoding-api.open-meteo.com/v1/search',
      metno:              'https://api.met.no/weatherapi/locationforecast/2.0/compact',
    },
    // met.no's terms require a real contact address. Without one the
    // cross-check silently loses its only non-Open-Meteo source.
    metnoUserAgent: process.env.METNO_USER_AGENT || '',
  },

  cities: [
    { name: 'Prague',   lat: 50.08, lon: 14.42, country: 'CZ' },
    { name: 'Brno',     lat: 49.19, lon: 16.61, country: 'CZ' },
    { name: 'Plzen',    lat: 49.75, lon: 13.38, country: 'CZ' },
    { name: 'Ostrava',  lat: 49.83, lon: 18.29, country: 'CZ' },
    { name: 'Berlin',   lat: 52.52, lon: 13.40, country: 'DE' },
    { name: 'Munich',   lat: 48.14, lon: 11.58, country: 'DE' },
    { name: 'Budapest', lat: 47.50, lon: 19.04, country: 'HU' },
    { name: 'Debrecen', lat: 47.53, lon: 21.63, country: 'HU' },
  ],

  models: MODELS,
  modelIds: MODELS.map(m => m.id),

  weather: {
    cacheMs: int(process.env.WEATHER_CACHE_MS, 60 * 60 * 1000),
    // Once a day is 2+ days old its cached values never change again, so a
    // post-trade review always sees what the desk saw. Disable with FREEZE_PAST=0.
    freezePast: bool(process.env.FREEZE_PAST, true),
  },

  verify: {
    MIN_TEMP: -45,          // °C, plausible lower bound for these cities
    MAX_TEMP: 48,           // °C, plausible upper bound
    MAX_HOURLY_JUMP: 12,    // °C between two adjacent hours
    MAX_MISSING_RECENT: 4,  // allowed null hours across yesterday + today
    GEO_MAX_KM: 30,         // configured coords must be within this of the city
    ERA5_MAE_LIMIT: 3.0,    // °C average error vs reanalysis before warning
    ERA5_MAX_LIMIT: 6.0,    // °C worst-hour error vs reanalysis before warning
    CACHE_MS: 6 * 3600000,
  },

  crosscheck: {
    // Independent of best_match, fetched in ONE batched models= call.
    MODELS: ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless', 'meteofrance_seamless'],
    DEVIATION_C: 4,             // shown value vs median of the others before flagging
    MIN_SOURCES: 2,             // sources needed before judging an hour
    CONSENSUS_SPREAD_C: 2,      // "the others agree" threshold
    CONSENSUS_MIN_SOURCES: 3,   // how many must agree before substituting
    CACHE_MS: 60 * 60 * 1000,
  },

  future: {
    // Prague and Budapest are the country proxies for the Future tab.
    COUNTRIES: [
      { code: 'CZ', name: 'Czechia', capital: 'Prague',   tz: 'Europe/Prague'   },
      { code: 'HU', name: 'Hungary', capital: 'Budapest', tz: 'Europe/Budapest' },
    ],
    LABELS: ['Today', 'Tomorrow', 'D+2', 'D+3', 'D+4', 'D+5'],
    CACHE_MS: 60 * 60 * 1000,
  },

  live: {
    CACHE_MS: 10 * 60 * 1000,
    CITIES: ['Prague', 'Brno', 'Budapest', 'Debrecen'],
  },

  market: {
    CACHE_MS: 30 * 60 * 1000,
    HDD_BASE: 18,   // °C — below this daily mean, heating demand grows
    CDD_BASE: 21,   // °C — above this daily mean, cooling (AC) demand grows
    // Approximate clear-sky daily shortwave totals (MJ/m²/day) at ~47-50°N by
    // month (Jan..Dec). Used ONLY to normalise the solar index for display.
    SOLAR_MAX_BY_MONTH: [6, 10, 16, 22, 27, 29, 28, 24, 18, 11, 7, 5],
    // Simplified turbine power curve at hub height, km/h.
    WIND: { CUT_IN: 11, RATED: 43, CUT_OUT: 90 },
    COUNTRIES: {
      CZ: {
        name: 'Czechia', tz: 'Europe/Prague',
        cities: [{ name: 'Prague', weight: 1.30 }, { name: 'Brno', weight: 0.40 },
                 { name: 'Plzen', weight: 0.18 }, { name: 'Ostrava', weight: 0.28 }],
      },
      HU: {
        name: 'Hungary', tz: 'Europe/Budapest',
        cities: [{ name: 'Budapest', weight: 1.75 }, { name: 'Debrecen', weight: 0.20 }],
      },
    },
    LABELS: ['Yesterday', 'Today', 'Tomorrow', 'D+2'],
  },

  weekly: {
    ARCHIVE_LAG_DAYS: 3,                // archive may miss the newest days
    FUTURE_WEEKS: 2,                    // week dropdown reaches current + this
    PAST_WEEKS: 78,                     // ~18 months back, across year boundaries
    CACHE_MS_PAST: 6 * 60 * 60 * 1000,  // finished weeks barely change
    CACHE_MS_CURRENT: 15 * 60 * 1000,   // current week fills in as hours pass
  },

  security: {
    // POST /api/fetch triggers 8 cities × 2 upstream calls. Unauthenticated
    // and unthrottled it is an outbound amplifier; now it is coalesced,
    // throttled, and optionally token-gated.
    fetchMinIntervalMs: int(process.env.FETCH_MIN_INTERVAL_MS, 60 * 1000),
    fetchToken: process.env.FETCH_TOKEN || '',
    trustProxy: bool(process.env.TRUST_PROXY, true),
  },

  logLevel: process.env.LOG_LEVEL || 'info',
  logFormat: process.env.LOG_FORMAT || 'pretty',
};

// Startup validation: shout about anything that will quietly degrade the app.
function validate() {
  const warnings = [];
  const errors = [];

  if (!config.db.enabled) {
    warnings.push('DATABASE_URL is not set — running on the in-memory cache only (nothing survives a restart).');
  }
  if (!config.upstream.metnoUserAgent) {
    warnings.push('METNO_USER_AGENT is not set — MET Norway is skipped, so the cross-check runs on Open-Meteo models only. met.no requires a real contact address; set e.g. "ZephyrWeather/3.0 you@example.com".');
  }
  if (!Number.isInteger(config.app.port) || config.app.port < 1 || config.app.port > 65535) {
    errors.push(`PORT must be a valid port number, got "${process.env.PORT}".`);
  }
  if (config.upstream.timeoutMs < 1000) {
    errors.push('UPSTREAM_TIMEOUT_MS below 1000 ms will fail every request.');
  }
  const names = config.cities.map(c => c.name);
  if (new Set(names).size !== names.length) errors.push('Duplicate city names in config.cities.');
  for (const [code, c] of Object.entries(config.market.COUNTRIES)) {
    for (const cc of c.cities) {
      if (!names.includes(cc.name)) errors.push(`market.COUNTRIES.${code} references unknown city "${cc.name}".`);
    }
  }
  for (const c of config.future.COUNTRIES) {
    if (!names.includes(c.capital)) errors.push(`future.COUNTRIES ${c.code} references unknown capital "${c.capital}".`);
  }
  return { warnings, errors };
}

module.exports = { config, validate, APP_TIMEZONE };
