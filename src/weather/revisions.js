'use strict';
// Forecast revisions: "what changed since yesterday's model run?"
//
// The revision IS the signal — a big warm-up or cool-down between runs moves
// load forecasts and day-ahead prices. Pure, no extra API calls: the
// previous-run series is already in the weather payload.

function reviseDay(currTemps, prevTemps) {
  if (!Array.isArray(currTemps) || !Array.isArray(prevTemps)) return null;
  let sum = 0, n = 0, maxAbs = 0, maxHour = null, maxDelta = null;
  let peakSum = 0, peakN = 0; // 08:00-20:00 — the hours that drive load/price
  for (let h = 0; h < 24; h++) {
    const c = currTemps[h], p = prevTemps[h];
    if (typeof c !== 'number' || typeof p !== 'number' || Number.isNaN(c) || Number.isNaN(p)) continue;
    const d = c - p;
    sum += d; n++;
    if (h >= 8 && h <= 20) { peakSum += d; peakN++; }
    if (Math.abs(d) > maxAbs) { maxAbs = Math.abs(d); maxHour = h; maxDelta = +d.toFixed(2); }
  }
  if (n < 6) return null; // not enough overlap to say anything
  return {
    avg: +(sum / n).toFixed(2),
    peakAvg: peakN ? +(peakSum / peakN).toFixed(2) : null,
    max: maxDelta, maxHour, hours: n,
  };
}

function computeRevisions(data) {
  if (!data) return null;
  return {
    today: reviseDay(data.today && data.today.temps, data.todayForecast && data.todayForecast.temps),
    tomorrow: reviseDay(data.tomorrow && data.tomorrow.temps, data.tomorrowForecast && data.tomorrowForecast.temps),
  };
}

module.exports = { reviseDay, computeRevisions };
