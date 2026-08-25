'use strict';
// ---------------------------------------------------------------------------
// Observed temperatures — airport METAR reports via aviationweather.gov.
//
// Everything else in this app is model output; this is the one thermometer.
// It exists because model re-analysis of the recent past can sit degrees away
// from what was actually measured, and only an observation can settle which
// column to trust ("why does the app disagree with Windy?").
//
// ONE upstream request fetches ALL stations (ids=LKPR,LKTB,…), so eight
// cities cost one call per cache period. METARs arrive roughly half-hourly;
// each report is assigned to its nearest whole hour on the absolute timeline
// (DST-safe) and the closest report per hour wins. `temp` is °C straight from
// the station — never interpolated, never invented; a missing report is a
// blank hour, exactly like the rest of the app treats missing data.
// ---------------------------------------------------------------------------

const { config } = require('../config');
const { createCache } = require('../lib/cache');
const { fetchJson } = require('../lib/openmeteo');

const TZ = config.app.timezone;

// Epoch ms -> 'YYYY-MM-DDTHH:00' in `tz`. Formatting happens after any
// rounding, so a DST change can never shift a bucket.
function hourKeyInTz(ms, tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = t => (parts.find(p => p.type === t) || {}).value;
  let hh = get('hour');
  if (hh === '24') hh = '00'; // some ICU builds report midnight as 24
  return `${get('year')}-${get('month')}-${get('day')}T${hh}:00`;
}

// A report's timestamp in epoch ms: obsTime (unix seconds) when present,
// else reportTime. Live responses use ISO with a zone
// ('2026-08-25T12:00:00.000Z'); some archives use 'YYYY-MM-DD HH:MM:SS'
// which is UTC without saying so — never let Date.parse read that as local.
function reportMs(rep) {
  if (rep && Number.isFinite(rep.obsTime)) return rep.obsTime * 1000;
  if (rep && typeof rep.reportTime === 'string') {
    const s = rep.reportTime.trim();
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
    const t = Date.parse(hasZone ? s : s.replace(' ', 'T') + 'Z');
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// Pure: raw METAR array -> { ICAO: { 'YYYY-MM-DDTHH:00': tempC } }.
function bucketReports(reports, tz = TZ) {
  const best = {}; // icao -> hourKey -> { dist, temp }
  for (const rep of Array.isArray(reports) ? reports : []) {
    const icao = rep && rep.icaoId;
    const temp = rep ? rep.temp : null;
    const ms = reportMs(rep);
    if (!icao || typeof temp !== 'number' || Number.isNaN(temp) || ms === null) continue;
    const nearestHourMs = Math.round(ms / 3600000) * 3600000;
    const key = hourKeyInTz(nearestHourMs, tz);
    const dist = Math.abs(ms - nearestHourMs);
    const perStation = best[icao] || (best[icao] = {});
    if (!perStation[key] || dist < perStation[key].dist) perStation[key] = { dist, temp };
  }
  const out = {};
  for (const [icao, byKey] of Object.entries(best)) {
    out[icao] = {};
    for (const [key, v] of Object.entries(byKey)) out[icao][key] = v.temp;
  }
  return out;
}

const cache = createCache({
  name: 'observed',
  ttlMs: config.observed.CACHE_MS,
  maxEntries: 2,
  staleOnError: true,
});

async function fetchAllStations() {
  const ids = config.cities.map(c => c.icao).filter(Boolean);
  const raw = await fetchJson('metar', {
    ids: ids.join(','),
    format: 'json',
    hours: config.observed.HOURS,
  }, { label: 'metar' });
  return { byStation: bucketReports(raw), fetchedAt: new Date().toISOString() };
}

async function getObserved(city) {
  if (!city.icao) {
    return { city: city.name, station: null, hours: {}, note: 'No station configured' };
  }
  const all = await cache.get('all', fetchAllStations);
  return {
    city: city.name,
    station: { icao: city.icao },
    hours: (all && all.byStation && all.byStation[city.icao]) || {},
    generatedAt: (all && all.fetchedAt) || new Date().toISOString(),
  };
}

module.exports = { getObserved, bucketReports, reportMs, hourKeyInTz };
