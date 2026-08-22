'use strict';
// The single read path every route uses. `source` is 'median' (default) or
// 'openmeteo'; nothing else in the app decides where weather comes from.

const store = require('./store');
const { getMedianWeather } = require('./median');

const DEFAULT_SOURCE = 'median';

function normaliseSource(value) {
  const s = String(value || '').toLowerCase();
  return s === 'openmeteo' || s === 'best_match' ? 'openmeteo' : DEFAULT_SOURCE;
}

// Returns { data, updatedAt, source }.
async function getSeries(city, source) {
  const src = normaliseSource(source);
  const entry = src === 'median' ? await getMedianWeather(city) : await store.getWeather(city);
  return { ...entry, source: src };
}

module.exports = { getSeries, normaliseSource, DEFAULT_SOURCE };
