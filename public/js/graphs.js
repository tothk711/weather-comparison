// ---------------------------------------------------------------------------
// Graphs tab — two panels, each of which can show a CHART or the same numbers
// as a VALUES table.
//
// v3.0 change: the standalone "Table" tab is gone. It was the same data as the
// Graphs, one click away, in a view that could silently disagree with them
// because it defaulted to a different source. It is now a toggle on this tab,
// reading exactly the series the chart is drawing.
//
// The eight hand-written dataset literals from v2.0 are one SERIES table now,
// and the left/right `side === 'left' ? … : …` ternaries are a Panel instance.
// ---------------------------------------------------------------------------

import { getJson, isWeatherPayload } from './api.js';
import { tipAttr } from './tooltip.js';
import {
  esc, isNum, fmtTemp, fx, fnum, hh, heatColor, heatColorLight, el,
} from './util.js';

const CZ_CITIES = ['Czechia', 'Prague', 'Brno', 'Plzen', 'Ostrava'];
const CZ_AVERAGE_OF = ['Prague', 'Brno', 'Plzen', 'Ostrava'];
const OTHER_CITIES = ['Budapest', 'Debrecen', 'Berlin', 'Munich'];

// One row per line on the chart AND per column in the Values view, so the two
// can never drift apart.
const SERIES = [
  { key: 'pastDaysAvg',      label: 'Past Avg (3-7d)', short: 'Past Avg', color: 'rgba(255,200,200,0.5)', width: 2, dash: null,   order: 6,   point: 0, legend: 'past-avg' },
  { key: 'twoDaysAgo',       label: '2 Days Ago',      short: '2 Days Ago', color: '#ff9999', width: 2, dash: [2, 4],  order: 5,   point: 0, legend: 'dotted-light-red' },
  { key: 'yesterday',        label: 'Yesterday',       short: 'Yesterday',  color: '#e94560', width: 3, dash: [10, 5], order: 4,   point: 0, legend: 'dashed-red' },
  { key: 'today',            label: 'Today',           short: 'Today',      color: '#4ecca3', width: 5, dash: null,    order: 1,   point: 2, legend: 'solid-green', isToday: true, fill: 'rgba(78,204,163,0.1)' },
  { key: 'todayForecast',    label: 'Today Forecast',  short: 'Today Fc',   color: '#00CED1', width: 3, dash: [8, 4],  order: 1.5, point: 0, legend: 'dashed-cyan', fc: true },
  { key: 'tomorrow',         label: 'Tomorrow',        short: 'Tomorrow',   color: '#90EE90', width: 2, dash: [10, 5], order: 2,   point: 0, legend: 'dashed-light-green', isTomorrow: true, fc: true },
  { key: 'tomorrowForecast', label: 'Tomorrow Fc',     short: 'Tomorrow Fc', color: '#00CED1', width: 2, dash: [2, 4], order: 2.5, point: 0, legend: 'dotted-cyan', fc: true },
  { key: 'dayAfterTomorrow', label: 'Day After',       short: 'Day After',  color: '#90EE90', width: 1, dash: [2, 4],  order: 3,   point: 0, legend: 'dotted-light-green', fc: true },
];

const VALUE_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

const TIPS = {
  source: 'Which model data every line uses. <b>Global median</b> (the default) takes the per-hour median of ECMWF, DWD ICON, NOAA GFS, Météo-France and Open-Meteo — one outlying model cannot move the line. <b>Openmeteo</b> is the single best-match model. The Future and Weekly tabs follow the same setting, so the tabs cannot disagree.',
  mode: 'Show the same series as a chart or as numbers. Identical data either way — the Values view is just the chart read off a grid.',
  dec: 'Decimal places in the Values grid — click to cycle 0 / 1 / 2.',
  czechia: 'Unweighted mean of Prague, Brno, Plzen and Ostrava, hour by hour. Note this is NOT the Market tab\'s demand temperature, which is population-weighted.',
  verify: 'Automatic sanity checks on the downloaded data: plausible range, no impossible hourly jumps, recent days complete, coordinates match the city, and agreement with the independent ERA5 reanalysis archive. Click for the detail.',
  crosscheck: 'Compares the displayed values against independent models and MET Norway. Where the shown value is a clear outlier against a tight consensus, the chart shows the consensus median instead (the raw value stays in the point tooltip). Click for the detail.',
  revision: "How far the current forecast has moved since yesterday's model run. Positive = warmer. Revisions of 1.5 °C or more move load forecasts and day-ahead prices.",
  agreement: 'Mean spread between the independent models. Tight = they see the same weather = higher-confidence forecast. Wide = forecast risk.',
  fcCols: 'The "Fc" columns are what YESTERDAY\'s model run predicted for these hours. The gap between an Fc column and the live column is the forecast revision.',
};

let graphSource = 'median';
const panels = {};

// ---- data ------------------------------------------------------------------

function averageCities(list) {
  const valid = list.filter(isWeatherPayload);
  if (!valid.length) throw new Error('No valid city data for the Czechia average');
  const keys = ['twoDaysAgo', 'yesterday', 'today', 'todayForecast', 'tomorrowForecast',
                'tomorrow', 'dayAfterTomorrow', 'pastDaysAvg'];
  const out = { updatedAt: valid[0].updatedAt, _source: valid[0]._source };
  for (const k of keys) {
    out[k] = { date: (valid[0][k] && valid[0][k].date) || null, temps: Array(24).fill(null) };
  }
  for (let hour = 0; hour < 24; hour++) {
    for (const k of keys) {
      let sum = 0, n = 0;
      for (const city of valid) {
        const v = city[k] && city[k].temps[hour];
        if (isNum(v)) { sum += v; n++; }
      }
      out[k].temps[hour] = n ? sum / n : null;
    }
  }
  return out;
}

async function fetchCity(name, source) {
  const one = c => getJson(`/api/weather/${encodeURIComponent(c)}?source=${encodeURIComponent(source)}`)
    .then(d => { if (!isWeatherPayload(d)) throw new Error(`Bad weather payload for ${c}`); return d; });
  if (name !== 'Czechia') return one(name);
  // One failing city must not sink the whole average.
  const settled = await Promise.allSettled(CZ_AVERAGE_OF.map(one));
  return averageCities(settled.filter(s => s.status === 'fulfilled').map(s => s.value));
}

// ---- Panel -----------------------------------------------------------------

class Panel {
  constructor(side, cities, defaultCity) {
    this.side = side;
    this.cities = cities;
    this.city = defaultCity;
    this.chart = null;
    this.data = null;
    this.hidden = new Set();
    this.corrections = null;
    this.raw = null;
    this.root = el(`panel-${side}`);
  }

  q(sel) { return this.root.querySelector(sel); }

  mount() {
    const sel = this.q('.city-select');
    sel.innerHTML = this.cities.map(c =>
      `<option value="${esc(c)}"${c === this.city ? ' selected' : ''}>${esc(c === 'Czechia' ? 'Czechia (Avg)' : c)}</option>`).join('');
    sel.addEventListener('change', e => { this.city = e.target.value; this.load(); });

    // Hold direct references. Setting `className` on a badge (which is how the
    // state classes get applied) would otherwise wipe the identifying class and
    // every later lookup would silently find nothing.
    this.els = {
      verifyBadge: this.q('.verify-badge'),
      verifyDetails: this.q('.verify-details'),
      ccBadge: this.q('.cc-badge'),
      ccDetails: this.q('.cc-details'),
      revText: this.q('.rev-text'),
      agreeText: this.q('.agree-text'),
    };
    this.els.verifyBadge.addEventListener('click', () => this.els.verifyDetails.classList.toggle('show'));
    this.els.ccBadge.addEventListener('click', () => this.els.ccDetails.classList.toggle('show'));

    this.mountLegend();
  }

  mountLegend() {
    const wrap = this.q('.legend-custom');
    wrap.innerHTML = SERIES.map((s, i) =>
      `<div class="legend-item" role="button" tabindex="0" aria-pressed="true" data-ds="${i}"${tipAttr('Click to show or hide this line on the chart.', s.label)}>` +
      `<div class="legend-line ${s.legend}"></div><span>${esc(s.short)}</span></div>`).join('');
    wrap.querySelectorAll('.legend-item').forEach((item, i) => {
      const toggle = () => this.toggleSeries(i, item);
      item.addEventListener('click', toggle);
      item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  }

  toggleSeries(index, item) {
    if (!this.chart) return;
    const willHide = this.chart.isDatasetVisible(index);
    this.chart.setDatasetVisibility(index, !willHide);
    if (willHide) this.hidden.add(index); else this.hidden.delete(index);
    item.classList.toggle('legend-hidden', willHide);
    item.setAttribute('aria-pressed', String(!willHide));
    this.chart.update();
  }

  applyLegendState() {
    const items = this.root.querySelectorAll('.legend-item');
    items.forEach((item, i) => {
      const isHidden = this.hidden.has(i);
      item.classList.toggle('legend-hidden', isHidden);
      item.setAttribute('aria-pressed', String(!isHidden));
    });
    if (!this.chart || !this.hidden.size) return;
    this.chart.data.datasets.forEach((ds, i) => this.chart.setDatasetVisibility(i, !this.hidden.has(i)));
    this.chart.update();
  }

  async load() {
    try {
      this.data = await fetchCity(this.city, graphSource);
      this.render();
      onUpdated(this.data.updatedAt);
      this.loadVerify();
      this.loadCrossCheck();
      this.loadRevisions();
    } catch (err) {
      console.error(`Could not load ${this.city}:`, err);
      this.q('.chart-wrapper').innerHTML = `<div class="error">Could not load data for ${esc(this.city)}.</div>`;
    }
  }

  render() {
    if (viewMode === 'chart') this.renderChart(); else this.renderValues();
  }

  // ---- chart ---------------------------------------------------------------

  renderChart() {
    const data = this.data;
    if (!data) return;
    const canvas = this.q('canvas');
    if (!canvas) return;

    if (this.chart) { this.chart.destroy(); this.chart = null; }

    const hours = Array.from({ length: 24 }, (_, i) => hh(i));
    const displayName = this.city === 'Czechia' ? 'Czechia (Average)' : this.city;

    const datasets = SERIES.map(s => {
      const day = data[s.key];
      const dated = day && day.date && day.date !== 'avg' ? ` (${day.date})` : '';
      return {
        label: s.label + dated,
        data: (day && day.temps) ? day.temps : Array(24).fill(null),
        borderColor: s.color,
        backgroundColor: s.fill || 'transparent',
        borderWidth: s.width,
        borderDash: s.dash || undefined,
        tension: 0.3,
        pointRadius: s.point,
        pointHoverRadius: s.point ? s.point + 4 : 4,
        order: s.order,
        _isToday: !!s.isToday,
        _isTomorrow: !!s.isTomorrow,
      };
    });

    const all = SERIES.flatMap(s => (data[s.key] && data[s.key].temps) || []).filter(isNum);
    const annotations = {};
    if (all.length) {
      const min = Math.min(...all), max = Math.max(...all);
      if (min < 2 && max > -2 && min < 0) {
        annotations.coldZone = {
          type: 'box', yMin: min - 2, yMax: 0,
          backgroundColor: 'rgba(100, 149, 237, 0.1)', borderWidth: 0,
        };
      }
    }

    const self = this;
    this.chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: hours, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        // Hover feedback halved against v2.0's Chart.js defaults (400 ms
        // animate / 300 ms tooltip) so the readout tracks the cursor.
        animation: { duration: 200 },
        hover: { animationDuration: 120 },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            animation: { duration: 120 },
            backgroundColor: 'rgba(24,31,60,0.97)',
            titleColor: '#4ecca3',
            bodyColor: '#e8eefb',
            borderColor: 'rgba(126,154,214,0.35)',
            borderWidth: 1,
            cornerRadius: 11,
            padding: 14,
            caretSize: 7,
            boxPadding: 5,
            usePointStyle: true,
            titleFont: { size: 15, weight: 'bold' },
            bodyFont: { size: 14 },
            bodySpacing: 7,
            callbacks: {
              // Colour each swatch with the LINE colour. Most datasets have a
              // transparent fill, so Chart.js' default swatch was a white blob
              // for seven of the eight series.
              labelColor(ctx) {
                const c = ctx.dataset.borderColor || ctx.dataset.pointBackgroundColor || '#8fa3b8';
                return { borderColor: c, backgroundColor: c, borderWidth: 2, borderRadius: 3 };
              },
              labelTextColor() { return '#e8eefb'; },
              label(ctx) {
                if (ctx.parsed.y === null) return null;
                let txt = ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}°C`;
                const which = ctx.dataset._isToday ? 'today' : (ctx.dataset._isTomorrow ? 'tomorrow' : null);
                const corr = which && self.corrections ? self.corrections[which] : null;
                if (corr && corr[ctx.dataIndex] !== undefined) {
                  const raw = corr[ctx.dataIndex];
                  txt += raw === null || raw === undefined
                    ? '  (consensus fill)'
                    : `  (consensus — model showed ${raw.toFixed(1)}°)`;
                }
                return txt;
              },
            },
          },
          title: {
            display: true,
            text: `Temperature in ${displayName}`,
            color: '#e8eefb',
            font: { size: 15, weight: 'bold' },
            padding: { bottom: 14 },
          },
          annotation: { annotations },
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' },
               ticks: { color: '#8fa3b8', maxTicksLimit: 8, font: { size: 11 } } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' },
               ticks: { color: '#8fa3b8', font: { size: 11 }, callback: v => `${v}°C` } },
        },
      },
    });

    this.applyLegendState();
    if (this.lastCrossCheck) this.applyCrossCheck(this.lastCrossCheck);
  }

  // ---- values (the old Table tab) ------------------------------------------

  renderValues() {
    const data = this.data;
    if (!data) return;
    const displayName = this.city === 'Czechia' ? 'Czechia (Average)' : this.city;

    const vals = [];
    VALUE_HOURS.forEach(h => SERIES.forEach(s => {
      const v = data[s.key] && data[s.key].temps ? data[s.key].temps[h] : null;
      if (isNum(v)) vals.push(v);
    }));
    const vMin = vals.length ? Math.min(...vals) : 0;
    const vMax = vals.length ? Math.max(...vals) : 0;

    let html = `<table class="grid"><caption>${esc(displayName)} — every 2 hours (°C, CET/CEST)</caption>`
      + '<thead><tr><th class="time-col">Time</th>';
    for (const s of SERIES) {
      const day = data[s.key];
      const d = day && day.date && day.date !== 'avg' ? `<span class="sub">${esc(day.date)}</span>` : '';
      const tip = s.fc && s.key.endsWith('Forecast') ? tipAttr(TIPS.fcCols, s.label) : '';
      html += `<th${tip}${tip ? ' class="has-tip"' : ''}>${esc(s.short)}${d}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const h of VALUE_HOURS) {
      html += `<tr><td class="time-col">${hh(h)}</td>`;
      for (const s of SERIES) {
        const v = data[s.key] && data[s.key].temps ? data[s.key].temps[h] : null;
        if (!isNum(v)) { html += '<td class="na">—</td>'; continue; }
        html += s.fc
          ? `<td style="background:${heatColorLight(v, vMin, vMax)};color:#0d1520;font-style:italic;font-weight:600;">${fmtTemp(v, decimals)}</td>`
          : `<td style="background:${heatColor(v, vMin, vMax)};color:#f5f7f9;font-weight:600;">${fmtTemp(v, decimals)}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>'
      + '<div class="legend-note">Dark cell + white text = actual · light cell + dark italic = forecast. '
      + `<span class="has-tip"${tipAttr(TIPS.fcCols, 'Forecast columns')}>What are the “Fc” columns?</span></div>`;

    this.q('.values-wrap').innerHTML = html;
  }

  // ---- badges --------------------------------------------------------------

  setBadge(which, state, text, detailsHtml, tipText) {
    const badge = which === 'verify' ? this.els.verifyBadge : this.els.ccBadge;
    const details = which === 'verify' ? this.els.verifyDetails : this.els.ccDetails;
    if (!badge) return;
    // classList, never className — see the note in mount().
    badge.classList.remove('is-checking', 'is-ok', 'is-warning', 'is-error');
    badge.classList.add('badge', `is-${state}`);
    badge.textContent = text;
    badge.setAttribute('data-tip', tipText || '');
    badge.setAttribute('data-tip-title', which === 'verify' ? 'Data checks' : 'Cross-check');
    if (details) {
      details.innerHTML = detailsHtml || '';
      details.classList.remove('show');
    }
  }

  async loadVerify() {
    this.setBadge('verify', 'checking', '⏳ Checking data…', '', TIPS.verify);
    try {
      const cities = this.city === 'Czechia' ? CZ_AVERAGE_OF : [this.city];
      const results = await Promise.all(cities.map(c =>
        getJson(`/api/verify/${encodeURIComponent(c)}?source=${encodeURIComponent(graphSource)}`).catch(() => null)));
      const valid = results.filter(r => r && Array.isArray(r.checks));
      if (!valid.length) {
        this.setBadge('verify', 'error', 'Check unavailable', '', 'Could not verify the data right now.');
        return;
      }
      const anyWarn = valid.some(r => r.status === 'warning');
      let html = '';
      for (const r of valid) {
        if (valid.length > 1) html += `<div style="color:#e8eefb;font-weight:700;margin-top:7px;">${esc(r.city)}</div>`;
        for (const c of (r.checks || [])) {
          const cls = c.skipped ? 'vd-skip' : (c.pass ? 'vd-pass' : 'vd-fail');
          const icon = c.skipped ? '–' : (c.pass ? '✓' : '⚠');
          html += `<div class="${cls}">${icon} ${esc(c.name)}: ${esc(c.detail)}</div>`;
        }
      }
      this.setBadge('verify', anyWarn ? 'warning' : 'ok',
        anyWarn ? '⚠ Checks flagged issues' : '✓ Data checked', html, TIPS.verify);
    } catch {
      this.setBadge('verify', 'error', 'Check unavailable', '', 'Could not verify the data right now.');
    }
  }

  removeOverlays() {
    if (!this.chart) return;
    const before = this.chart.data.datasets.length;
    this.chart.data.datasets = this.chart.data.datasets.filter(d => !d._flag);
    let restored = false;
    if (this.raw) {
      for (const which of ['today', 'tomorrow']) {
        const ds = this.lineFor(which);
        if (ds && this.raw[which]) { ds.data = this.raw[which]; restored = true; }
      }
    }
    this.raw = null;
    this.corrections = null;
    if (this.chart.data.datasets.length !== before || restored) this.chart.update();
  }

  lineFor(which) {
    if (!this.chart) return null;
    return this.chart.data.datasets.find(d => which === 'today' ? d._isToday : d._isTomorrow);
  }

  applyCrossCheck(data) {
    if (!this.chart) return;
    this.chart.data.datasets = this.chart.data.datasets.filter(d => !d._flag);
    for (const which of ['today', 'tomorrow']) {
      const ds = this.lineFor(which);
      if (ds && this.raw && this.raw[which]) ds.data = this.raw[which];
    }
    this.raw = {};
    this.corrections = {};

    for (const [which, a] of [['today', data], ['tomorrow', data.tomorrow || {}]]) {
      const ds = this.lineFor(which);
      const corrected = a.correctedHours || [];
      const flagged = a.suspectHours || [];
      const tag = which === 'tomorrow' ? ' (tomorrow)' : '';

      if (ds && corrected.length) {
        this.raw[which] = ds.data;
        const patched = ds.data.slice();
        const corrections = {};
        for (const h of corrected) {
          const row = a.hours[h];
          if (row && row.display !== null && row.display !== undefined) {
            corrections[h] = row.primary;
            patched[h] = row.display;
          }
        }
        ds.data = patched;
        this.corrections[which] = corrections;

        const pts = Array(24).fill(null);
        for (const h of corrected) { const r = a.hours[h]; if (r) pts[h] = r.display; }
        this.chart.data.datasets.push({
          _flag: true, label: `🛠 Consensus value${tag}`, data: pts, showLine: false,
          pointStyle: 'rectRot', pointRadius: which === 'today' ? 7 : 6, pointHoverRadius: 10,
          pointBackgroundColor: '#00CED1', pointBorderColor: '#141a30', pointBorderWidth: 1, order: 0,
        });
      }
      if (flagged.length) {
        const pts = Array(24).fill(null);
        for (const h of flagged) {
          const r = a.hours[h];
          pts[h] = (r && isNum(r.primary)) ? r.primary : null;
        }
        this.chart.data.datasets.push({
          _flag: true, label: `⚠ Low confidence${tag}`, data: pts, showLine: false,
          pointStyle: 'triangle', pointRadius: which === 'today' ? 8 : 6, pointHoverRadius: 11,
          pointBackgroundColor: '#e9b44c', pointBorderColor: '#141a30', pointBorderWidth: 1, order: 0,
        });
      }
    }
    this.chart.update();
  }

  async loadCrossCheck() {
    const agree = this.els.agreeText;
    if (this.city === 'Czechia') {
      this.setBadge('cc', 'error', '🔀 Cross-check: single cities', '',
        'The cross-check runs on individual cities, not on the Czechia average. Pick a city to see it.');
      if (agree) agree.innerHTML = '';
      this.lastCrossCheck = null;
      this.removeOverlays();
      return;
    }
    this.setBadge('cc', 'checking', '⏳ Cross-checking…', '', TIPS.crosscheck);
    try {
      const data = await getJson(`/api/crosscheck/${encodeURIComponent(this.city)}?source=${encodeURIComponent(graphSource)}`);
      if (!data || !Array.isArray(data.hours) || !data.sourceCount) {
        this.setBadge('cc', 'error', 'Cross-check unavailable', '', 'No independent source responded.');
        this.lastCrossCheck = null;
        this.removeOverlays();
        return;
      }
      this.lastCrossCheck = data;
      this.applyCrossCheck(data);

      const tom = data.tomorrow || {};
      const arr = v => (Array.isArray(v) ? v : []);
      const corrected = arr(data.correctedHours), flagged = arr(data.suspectHours);
      const tomCorrected = arr(tom.correctedHours), tomFlagged = arr(tom.suspectHours);
      const srcList = (data.sources || []).map(esc).join(', ');

      if (agree) {
        const bits = [];
        if (isNum(data.meanSpread)) bits.push(`today ±${data.meanSpread.toFixed(1)}°`);
        if (isNum(tom.meanSpread)) bits.push(`tomorrow ±${tom.meanSpread.toFixed(1)}°`);
        agree.innerHTML = bits.length
          ? ` · <span class="has-tip"${tipAttr(TIPS.agreement, 'Model agreement')}>🎯 model agreement: ${bits.join(', ')}</span>`
          : '';
      }

      if (!flagged.length && !corrected.length && !tomFlagged.length && !tomCorrected.length) {
        const html = `<div class="vd-pass">✓ Today's values agree with ${fnum(data.sourceCount)} independent source(s) within ${fnum(data.deviationLimit)}°C.</div>`
          + `<div class="vd-skip" style="margin-top:6px;">Sources: ${srcList}.</div>`;
        this.setBadge('cc', 'ok', '✓ Sources agree', html, TIPS.crosscheck);
        return;
      }

      let html = '';
      const section = (label, a, corrH, flagH) => {
        if (!corrH.length && !flagH.length) return;
        if (!Array.isArray(a.hours)) return;
        html += `<div style="color:#e8eefb;font-weight:700;margin-top:7px;">${label}</div>`;
        for (const h of corrH) {
          const row = (a.hours || [])[h];
          if (!row) continue;
          const others = (row.others || []).map(o => `${esc(o.label)} ${fx(o.temp)}°`).join(', ');
          html += `<div class="vd-pass">🛠 ${hh(h)} — model showed <b>${fx(row.primary)}°</b>; `
            + `${(row.others || []).length} other sources sit within ${fx(row.spread)}°C of each other, so the chart shows their median <b>${fx(row.display)}°</b> (${others})</div>`;
        }
        for (const h of flagH) {
          const row = (a.hours || [])[h];
          if (!row) continue;
          const others = (row.others || []).map(o => `${esc(o.label)} ${fx(o.temp)}°`).join(', ');
          html += `<div class="vd-fail">⚠ ${hh(h)} — shown <b>${fx(row.primary)}°</b> vs the others' median ${fx(row.median)}°, `
            + `but those sources disagree among themselves too (spread ${fx(row.spread)}°C) — flagged, not replaced (${others})</div>`;
        }
      };
      section('Today', data, corrected, flagged);
      section('Tomorrow', tom, tomCorrected, tomFlagged);
      html += `<div class="vd-skip" style="margin-top:7px;">Replaced when the model is &gt;${fnum(data.deviationLimit)}°C from the median of ≥${fnum(data.consensusMinSources)} sources that agree within ${fnum(data.consensusSpreadLimit)}°C; flagged only when the sources disagree too. Raw values stay in the point tooltip. Sources: ${srcList}.</div>`;

      const parts = [];
      if (corrected.length) parts.push(`🛠 ${corrected.length} hr → consensus`);
      if (flagged.length) parts.push(`⚠ ${flagged.length} hr flagged`);
      if (tomCorrected.length || tomFlagged.length) {
        const tp = [];
        if (tomCorrected.length) tp.push(`🛠${tomCorrected.length}`);
        if (tomFlagged.length) tp.push(`⚠${tomFlagged.length}`);
        parts.push(`tom ${tp.join(' ')}`);
      }
      this.setBadge('cc', 'warning', parts.join(' · '), html, TIPS.crosscheck);
    } catch (e) {
      console.error('Cross-check failed:', e);
      this.setBadge('cc', 'error', 'Cross-check unavailable', '', 'Could not cross-check right now.');
      this.lastCrossCheck = null;
      this.removeOverlays();
    }
  }

  async loadRevisions() {
    const node = this.els.revText;
    if (!node) return;
    node.innerHTML = '';
    const proxy = this.city === 'Czechia' ? 'Prague' : this.city;
    try {
      const r = await getJson(`/api/revisions/${encodeURIComponent(proxy)}?source=${encodeURIComponent(graphSource)}`);
      const fm = d => (isNum(d) ? `${d > 0 ? '+' : ''}${d.toFixed(1)}°` : '—');
      const parts = [];
      if (r.tomorrow) {
        const hot = Math.abs(r.tomorrow.avg) >= 1.5 ? ' rev-hot' : '';
        parts.push(`<span class="${hot}">tomorrow <b>${fm(r.tomorrow.avg)}</b></span>`
          + ` (peak ${fm(isNum(r.tomorrow.peakAvg) ? r.tomorrow.peakAvg : r.tomorrow.avg)}, max ${fm(r.tomorrow.max)} @${hh(r.tomorrow.maxHour)})`);
      }
      if (r.today) parts.push(`today ${fm(r.today.avg)}`);
      if (!parts.length) return;
      node.innerHTML = `<span class="has-tip"${tipAttr(TIPS.revision, 'Forecast revision')}>🔁 vs yesterday's run: ${parts.join(' · ')}</span>`
        + (this.city === 'Czechia' ? ' <span style="color:#6b7c93">(Prague proxy)</span>' : '');
    } catch {
      node.innerHTML = '';
    }
  }
}

// ---- module state / wiring -------------------------------------------------

let viewMode = 'chart';
let decimals = 0;
let onUpdated = () => {};

export function initGraphs({ onUpdatedAt }) {
  onUpdated = onUpdatedAt || (() => {});

  panels.left = new Panel('left', CZ_CITIES, 'Czechia');
  panels.right = new Panel('right', OTHER_CITIES, 'Budapest');
  panels.left.mount();
  panels.right.mount();

  const srcSel = el('graphSource');
  srcSel.setAttribute('data-tip', TIPS.source);
  srcSel.setAttribute('data-tip-title', 'Data source');
  srcSel.addEventListener('change', e => {
    graphSource = e.target.value;
    document.dispatchEvent(new CustomEvent('zw:source', { detail: graphSource }));
    reload();
  });

  const seg = el('viewToggle');
  seg.setAttribute('data-tip', TIPS.mode);
  seg.setAttribute('data-tip-title', 'Chart or values');
  seg.addEventListener('click', e => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    setViewMode(btn.dataset.mode);
  });

  const dec = el('decBtn');
  dec.setAttribute('data-tip', TIPS.dec);
  dec.setAttribute('data-tip-title', 'Decimals');
  dec.addEventListener('click', () => {
    decimals = (decimals + 1) % 3;
    dec.textContent = `Dec ${decimals}`;
    for (const p of Object.values(panels)) if (viewMode === 'values') p.renderValues();
  });

  setViewMode('chart');
  return reload();
}

function setViewMode(mode) {
  viewMode = mode === 'values' ? 'values' : 'chart';
  el('viewToggle').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', b.dataset.mode === viewMode));
  el('decBtn').style.display = viewMode === 'values' ? '' : 'none';
  for (const p of Object.values(panels)) {
    p.root.querySelector('.chart-wrapper').style.display = viewMode === 'chart' ? '' : 'none';
    p.root.querySelector('.legend-custom').style.display = viewMode === 'chart' ? '' : 'none';
    p.root.querySelector('.values-wrap').style.display = viewMode === 'values' ? '' : 'none';
    if (p.data) p.render();
  }
}

export function currentSource() { return graphSource; }

export function reload() {
  return Promise.all(Object.values(panels).map(p => p.load()));
}
