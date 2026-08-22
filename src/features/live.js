'use strict';
// LIVE snapshot: "right now" conditions plus whether each metric is higher or
// lower than the same hour yesterday. parseLive is pure and never invents data.

const { config } = require('../config');
const { createCache } = require('../lib/cache');
const { fetchJson } = require('../lib/openmeteo');
const { describeWeather, weatherIcon, isStormCode } = require('./weather-codes');

const TZ = config.app.timezone;

// Direction of change vs yesterday, with a dead-band so tiny wiggles read flat.
function liveDir(delta, eps) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return 'flat';
  if (delta > eps) return 'up';
  if (delta < -eps) return 'down';
  return 'flat';
}

function parseLive(raw) {
  if (!raw || !raw.current) return null;
  const cur = raw.current;
  const h = raw.hourly || {};
  const times = Array.isArray(h.time) ? h.time : [];
  const idx = {};
  for (let i = 0; i < times.length; i++) idx[times[i]] = i;

  // The "same hour yesterday" key, derived from the current timestamp and
  // anchored at noon UTC so a DST change cannot shift it.
  let yKey = null;
  const curTime = typeof cur.time === 'string' ? cur.time : null;
  if (curTime && curTime.length >= 13) {
    const [y, m, d] = curTime.slice(0, 10).split('-').map(Number);
    const hh = curTime.slice(11, 13);
    const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    anchor.setUTCDate(anchor.getUTCDate() - 1);
    yKey = `${anchor.toISOString().slice(0, 10)}T${hh}:00`;
  }
  const yi = (yKey !== null && idx[yKey] !== undefined) ? idx[yKey] : null;
  const num = v => (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
  const yVal = arr => (yi !== null && Array.isArray(arr)) ? num(arr[yi]) : null;

  const metric = (nowRaw, ydayRaw, eps) => {
    const now = num(nowRaw), yday = num(ydayRaw);
    const delta = (now !== null && yday !== null) ? +(now - yday).toFixed(2) : null;
    return { value: now, yesterday: yday, delta, dir: liveDir(delta, eps) };
  };

  const code = num(cur.weather_code);
  // Compare like with like: the hourly series is pressure_msl, so only compute
  // a yesterday-delta when "now" is also MSL. Falling back to surface_pressure
  // (~30-45 hPa lower at these altitudes) would fake a ▼ of 40 hPa.
  const usingMsl = num(cur.pressure_msl) !== null;
  const pressureNow = usingMsl ? cur.pressure_msl : cur.surface_pressure;
  const pressureYday = usingMsl ? yVal(h.pressure_msl) : null;

  return {
    time: curTime,
    yesterdayTime: yi !== null ? yKey : null,
    temperature: { ...metric(cur.temperature_2m, yVal(h.temperature_2m), 0.1), unit: '°C' },
    wind: { ...metric(cur.wind_speed_10m, yVal(h.wind_speed_10m), 0.5),
            gust: num(cur.wind_gusts_10m), unit: 'km/h' },
    rain: { ...metric(cur.precipitation, yVal(h.precipitation), 0.05),
            weatherCode: code, weather: describeWeather(code), icon: weatherIcon(code),
            storm: isStormCode(code), unit: 'mm' },
    pressure: { ...metric(pressureNow, pressureYday, 0.3), unit: 'hPa' },
  };
}

const cache = createCache({ name: 'live', ttlMs: config.live.CACHE_MS, maxEntries: 16, staleOnError: true });

async function fetchLive(city) {
  return cache.get(city.name, async () => {
    const raw = await fetchJson('forecast', {
      latitude: city.lat, longitude: city.lon,
      current: 'temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,pressure_msl,surface_pressure',
      hourly: 'temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,pressure_msl',
      past_days: 1, forecast_days: 1, timezone: TZ,
    }, { label: `live ${city.name}` });
    const parsed = parseLive(raw);
    if (!parsed) throw new Error('no current data in response');
    return { city: city.name, generatedAt: new Date().toISOString(), timezone: TZ, ...parsed };
  });
}

module.exports = { parseLive, liveDir, fetchLive, clear: () => cache.clear() };
