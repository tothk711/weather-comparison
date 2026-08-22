'use strict';
// Data verification: "is what we downloaded actually correct?"
// Cheap sanity checks on the values themselves, plus an independent cross-check
// of the oldest historical days against Open-Meteo's ERA5 reanalysis archive.
// runDataChecks is pure so all five check families are unit-testable.

const { config } = require('../config');
const logger = require('../logger');
const { createCache } = require('../lib/cache');
const { fetchJson } = require('../lib/openmeteo');
const { haversineKm } = require('../lib/stats');
const { getDateString } = require('../lib/dates');
const { DAY_KEYS } = require('../weather/parse');
const { getSeries } = require('../weather');

const V = config.verify;

function runDataChecks(city, data, geo, era5) {
  const checks = [];

  // 1) The coordinates really belong to the city we think they do.
  if (geo && typeof geo.lat === 'number') {
    const dist = haversineKm(city.lat, city.lon, geo.lat, geo.lon);
    checks.push({
      name: 'Coordinates match city',
      pass: dist <= V.GEO_MAX_KM,
      detail: `Configured point is ${dist.toFixed(1)} km from geocoded "${city.name}" (limit ${V.GEO_MAX_KM} km).`,
    });
  } else {
    checks.push({ name: 'Coordinates match city', pass: true, skipped: true,
      detail: 'Geocoder unavailable — coordinate check skipped.' });
  }

  // 2) Every temperature is physically plausible.
  let outOfRange = 0, total = 0, gMin = Infinity, gMax = -Infinity;
  for (const k of DAY_KEYS) {
    if (!data[k] || !Array.isArray(data[k].temps)) continue;
    for (const t of data[k].temps) {
      if (t === null || t === undefined) continue;
      total++;
      if (t < gMin) gMin = t;
      if (t > gMax) gMax = t;
      if (t < V.MIN_TEMP || t > V.MAX_TEMP) outOfRange++;
    }
  }
  checks.push({
    name: 'Temperatures in plausible range',
    pass: outOfRange === 0 && total > 0,
    detail: total === 0 ? 'No temperature values found.'
      : `${total} values from ${gMin.toFixed(1)}°C to ${gMax.toFixed(1)}°C; ${outOfRange} out of range.`,
  });

  // 3) The days that matter most are reasonably complete.
  let missingRecent = 0;
  for (const k of ['yesterday', 'today']) {
    if (!data[k] || !Array.isArray(data[k].temps)) { missingRecent += 24; continue; }
    missingRecent += data[k].temps.filter(t => t === null || t === undefined).length;
  }
  checks.push({
    name: 'Recent days complete',
    pass: missingRecent <= V.MAX_MISSING_RECENT,
    detail: `${missingRecent} missing hour(s) across yesterday + today (limit ${V.MAX_MISSING_RECENT}).`,
  });

  // 4) No impossible hour-to-hour jumps (a sign of corruption).
  let worstJump = 0, worstWhen = '';
  for (const k of DAY_KEYS) {
    if (!data[k] || !Array.isArray(data[k].temps)) continue;
    const t = data[k].temps;
    for (let h = 1; h < t.length; h++) {
      if (t[h] == null || t[h - 1] == null) continue;
      const jump = Math.abs(t[h] - t[h - 1]);
      if (jump > worstJump) { worstJump = jump; worstWhen = `${data[k].date} ${h - 1}:00→${h}:00`; }
    }
  }
  checks.push({
    name: 'No impossible hourly jumps',
    pass: worstJump <= V.MAX_HOURLY_JUMP,
    detail: worstWhen
      ? `Largest change ${worstJump.toFixed(1)}°C (${worstWhen}); limit ${V.MAX_HOURLY_JUMP}°C.`
      : 'Not enough data to evaluate.',
  });

  // 5) Historical days agree with the independent ERA5 reanalysis archive.
  if (era5 && Object.keys(era5).length) {
    let sumAbs = 0, n = 0, maxErr = 0, maxWhen = '';
    for (const k of ['sevenDaysAgo', 'sixDaysAgo', 'fiveDaysAgo']) {
      if (!data[k] || !Array.isArray(data[k].temps)) continue;
      for (let h = 0; h < data[k].temps.length; h++) {
        const ours = data[k].temps[h];
        const ref = era5[`${data[k].date}T${String(h).padStart(2, '0')}`];
        if (ours == null || ref == null) continue;
        const err = Math.abs(ours - ref);
        sumAbs += err; n++;
        if (err > maxErr) { maxErr = err; maxWhen = `${data[k].date} ${h}:00`; }
      }
    }
    if (n > 0) {
      const mae = sumAbs / n;
      checks.push({
        name: 'Matches ERA5 reference archive',
        pass: mae <= V.ERA5_MAE_LIMIT && maxErr <= V.ERA5_MAX_LIMIT,
        detail: `${n} hours compared: avg diff ${mae.toFixed(2)}°C, worst ${maxErr.toFixed(1)}°C at ${maxWhen} (limits ${V.ERA5_MAE_LIMIT}/${V.ERA5_MAX_LIMIT}°C).`,
      });
    } else {
      checks.push({ name: 'Matches ERA5 reference archive', pass: true, skipped: true,
        detail: 'No overlapping hours available to compare yet.' });
    }
  } else {
    checks.push({ name: 'Matches ERA5 reference archive', pass: true, skipped: true,
      detail: 'Reference archive unavailable — cross-check skipped.' });
  }

  const hardFail = checks.some(c => c.pass === false && !c.skipped);
  return { city: city.name, status: hardFail ? 'warning' : 'ok', checkedAt: new Date().toISOString(), checks };
}

const cache = createCache({ name: 'verify', ttlMs: V.CACHE_MS, maxEntries: 32, staleOnError: true });

async function fetchGeo(city) {
  try {
    const j = await fetchJson('geocoding',
      { name: city.name, count: 1, language: 'en', format: 'json' },
      { label: `geocode ${city.name}`, retries: 0 });
    if (j && Array.isArray(j.results) && j.results.length) {
      return { lat: j.results[0].latitude, lon: j.results[0].longitude, name: j.results[0].name };
    }
  } catch (e) {
    logger.debug('geocode failed', { city: city.name, err: e.message });
  }
  return null;
}

async function fetchEra5(city) {
  try {
    const j = await fetchJson('archive', {
      latitude: city.lat, longitude: city.lon,
      start_date: getDateString(-7), end_date: getDateString(-5),
      hourly: 'temperature_2m', timezone: config.app.timezone,
    }, { label: `era5 ${city.name}`, retries: 1 });
    if (!j.hourly || !Array.isArray(j.hourly.time)) return null;
    const map = {};
    for (let i = 0; i < j.hourly.time.length; i++) {
      map[j.hourly.time[i].slice(0, 13)] = j.hourly.temperature_2m[i]; // "2026-06-08T00"
    }
    return map;
  } catch (e) {
    logger.debug('era5 fetch failed', { city: city.name, err: e.message });
    return null;
  }
}

async function verifyCity(city, source) {
  return cache.get(`${city.name}|${source || 'median'}`, async () => {
    let weather = null;
    try { weather = await getSeries(city, source); } catch { /* handled below */ }
    if (!weather) {
      return { city: city.name, status: 'warning', checkedAt: new Date().toISOString(),
        checks: [{ name: 'Data available', pass: false, detail: 'No weather data to verify.' }] };
    }
    const [geo, era5] = await Promise.all([fetchGeo(city), fetchEra5(city)]);
    return runDataChecks(city, weather.data, geo, era5);
  });
}

module.exports = { runDataChecks, verifyCity, clear: () => cache.clear() };
