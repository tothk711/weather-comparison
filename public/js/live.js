// LIVE tab — "right now" for four cities, each metric with its direction versus
// the same hour yesterday.

import { getJson } from './api.js';
import { tipAttr } from './tooltip.js';
import { esc, isNum, fx, fint, el, localTime } from './util.js';

let CITIES = ['Prague', 'Brno', 'Budapest', 'Debrecen'];

const CATS = [
  { key: 'temperature', label: '🌡️ Temperature', title: 'Temperature',
    tip: 'Grid load driver: heat raises cooling and AC demand while derating lines, transformers and panels; cold raises heating demand. Big moves shift both demand and price.',
    fmt: v => `${fx(v)}°C` },
  { key: 'wind', label: '💨 Wind', title: 'Wind',
    tip: 'Wind-power driver: more wind means more generation, until turbines cut out around 90 km/h and output falls to zero. Strong gusts also raise line-fault and trip risk.',
    fmt: v => `${fint(v)} km/h` },
  { key: 'rain', label: '🌧️ Rain / Storms', title: 'Rain and storms',
    tip: 'Rain and cloud cut solar output; thunderstorms bring lightning faults, trips and sudden supply/demand swings. Heavy rain feeds hydro inflow.',
    fmt: v => `${fx(v)} mm` },
  { key: 'pressure', label: '🎚️ Pressure', title: 'Pressure',
    tip: 'Weather-regime proxy: high means calm, clear and stable (low wind, high solar); low or falling means windy, cloudy and unsettled (high wind, low solar). The trend hints at what is coming.',
    fmt: v => `${fint(v)} hPa` },
];

function change(m) {
  if (!m || !isNum(m.delta)) return '<span class="live-change live-flat">– no comparison</span>';
  const arrow = m.dir === 'up' ? '▲' : (m.dir === 'down' ? '▼' : '▬');
  const cls = m.dir === 'up' ? 'live-up' : (m.dir === 'down' ? 'live-down' : 'live-flat');
  return `<span class="live-change ${cls}">${arrow} ${m.delta > 0 ? '+' : ''}${esc(m.delta)}</span>`;
}

function cell(cat, m) {
  if (!m || !isNum(m.value)) return '<span class="live-value">—</span>';
  let html = `<span class="live-value">${esc(cat.fmt(m.value))}</span>${change(m)}`;
  if (cat.key === 'wind' && isNum(m.gust)) html += `<span class="live-sub">gust ${Math.round(m.gust)}</span>`;
  if (cat.key === 'rain') {
    html += `<span class="live-sub ${m.storm ? 'live-storm' : ''}">${esc(m.icon || '')} ${esc(m.weather || '')}</span>`;
  }
  return html;
}

export function initLive(cfg) {
  if (cfg && Array.isArray(cfg.live) && cfg.live.length) CITIES = cfg.live;
}

export async function loadLive() {
  const container = el('liveContainer');
  if (!container.innerHTML.trim()) container.innerHTML = '<div class="loading">Loading live conditions…</div>';
  try {
    const results = await Promise.all(CITIES.map(c =>
      getJson(`/api/live/${encodeURIComponent(c)}`, { ttlMs: 60000 })
        .then(data => ({ city: c, data }))
        .catch(() => ({ city: c, data: null }))));

    const head = CATS.map(c =>
      `<th class="has-tip"${tipAttr(c.tip, c.title)}>${c.label}</th>`).join('');

    let rows = '', latest = null;
    for (const { city, data } of results) {
      rows += `<tr><th class="row-label">${esc(city)}</th>`;
      if (!data) { rows += '<td colspan="4" style="color:#8fa3b8;">— unavailable</td></tr>'; continue; }
      if (data.generatedAt) latest = data.generatedAt;
      for (const cat of CATS) rows += `<td>${cell(cat, data[cat.key])}</td>`;
      rows += '</tr>';
    }

    container.innerHTML = `<table class="box">
        <thead><tr><th class="row-label">City</th>${head}</tr></thead>
        <tbody>${rows}</tbody></table>`;
    el('liveUpdated').textContent = latest
      ? `Updated ${localTime(latest)} — refreshes every 5 minutes while this tab is open.` : '';
  } catch (e) {
    console.error('Live load failed:', e);
    container.innerHTML = '<div class="error">Could not load live conditions.</div>';
  }
}
