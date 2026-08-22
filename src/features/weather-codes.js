'use strict';
// WMO weather codes -> short human descriptions, plus the classifiers shared by
// the Future tab and the Market brief.

const WMO_DESC = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Thunderstorm + hail',
};

// A compact icon for each code family — used by the redesigned Market tab and
// the Future tab so a day's weather reads at a glance instead of as prose.
function weatherIcon(code) {
  if (code === null || code === undefined) return '';
  if (code === 0) return '☀️';
  if (code === 1 || code === 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌧️';
  if (code === 85 || code === 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '';
}

function describeWeather(code) {
  if (code === null || code === undefined) return null;
  return WMO_DESC[code] || `Code ${code}`;
}
const isStormCode = code => code === 95 || code === 96 || code === 99;
const isSnowCode = code => (code >= 71 && code <= 77) || code === 85 || code === 86;
const isFogCode = code => code === 45 || code === 48;

function classifyPressure(hPa) {
  if (hPa === null || hPa === undefined) return null;
  if (hPa < 1005) return 'Low';
  if (hPa > 1020) return 'High';
  return 'Normal';
}
function classifyWind(gustKmh) {
  if (gustKmh === null || gustKmh === undefined) return null;
  if (gustKmh >= 50) return 'Strong';
  if (gustKmh >= 20) return 'Normal';
  return 'Light';
}
function classifyClouds(pct) {
  if (pct === null || pct === undefined) return null;
  if (pct < 10) return 'None';
  if (pct < 35) return 'Low';
  if (pct < 65) return 'Medium';
  if (pct < 85) return 'High';
  return 'Very high';
}

module.exports = {
  WMO_DESC, describeWeather, weatherIcon,
  isStormCode, isSnowCode, isFogCode,
  classifyPressure, classifyWind, classifyClouds,
};
