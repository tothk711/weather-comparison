// Entry point: tabs, header, refresh, and the shared "source" setting.

import { getJson, postJson, clearApiCache } from './api.js';
import { initTooltips } from './tooltip.js';
import { esc, el, localTime, APP_TZ } from './util.js';
import { initGraphs, reload as reloadGraphs, currentSource } from './graphs.js';
import { loadFuture } from './future.js';
import { initWeekly, load as loadWeekly, setWeeklySource } from './weekly.js';
import { initLive, loadLive } from './live.js';
import { loadMarket } from './market.js';

const VIEWS = {
  graphs:  { view: 'graphsView',  tab: 'tabGraphs' },
  future:  { view: 'futureView',  tab: 'tabFuture' },
  weekly:  { view: 'weeklyView',  tab: 'tabWeekly' },
  live:    { view: 'liveView',    tab: 'tabLive' },
  market:  { view: 'marketView',  tab: 'tabMarket' },
};

let active = 'graphs';

function showTab(tab) {
  if (!VIEWS[tab]) tab = 'graphs';
  active = tab;
  for (const [key, v] of Object.entries(VIEWS)) {
    const on = key === tab;
    el(v.view).style.display = on ? '' : 'none';
    el(v.tab).classList.toggle('active', on);
    el(v.tab).setAttribute('aria-selected', String(on));
  }
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
  loadTab(tab);
}

function loadTab(tab) {
  const source = currentSource();
  if (tab === 'future') return loadFuture(source);
  if (tab === 'weekly') return loadWeekly();
  if (tab === 'live') return loadLive();
  if (tab === 'market') return loadMarket(source);
  return null;
}

function updateHeaderDate() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA',
    { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: APP_TZ, weekday: 'long' }).format(now);
  el('todayDate').textContent = `${day} ${date} · all times CET/CEST`;
}

function setStatus(updatedAt) {
  el('statusPill').textContent = updatedAt ? `Data updated ${localTime(updatedAt)}` : 'Data updated —';
}

async function refreshAll() {
  const btn = el('refreshBtn');
  const original = btn.textContent;
  btn.textContent = '⏳ Refreshing…';
  btn.disabled = true;
  clearApiCache();
  try {
    await postJson('/api/fetch').catch(err => {
      // 429 just means the data was refreshed a moment ago — reload anyway.
      if (err.status !== 429) throw err;
    });
    await reloadGraphs();
    if (active !== 'graphs') await loadTab(active);
  } catch (err) {
    console.error('Refresh failed:', err);
    el('statusPill').textContent = 'Refresh failed — showing cached data';
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

async function init() {
  initTooltips();
  updateHeaderDate();
  setInterval(updateHeaderDate, 60 * 1000);

  let cfg = null;
  try { cfg = await getJson('/api/config', { ttlMs: 60 * 60 * 1000 }); } catch { /* fall back below */ }

  if (cfg) {
    el('appVersion').textContent = `v${cfg.app.version}`;
    document.title = `${cfg.app.name} ${cfg.app.version}`;
    initWeekly(cfg, 'median');
    initLive(cfg);
  }

  for (const [key, v] of Object.entries(VIEWS)) {
    el(v.tab).addEventListener('click', () => showTab(key));
  }

  // The Graphs source selector is the app-wide default; Weekly follows it.
  document.addEventListener('zw:source', e => setWeeklySource(e.detail));

  el('refreshBtn').addEventListener('click', refreshAll);

  // Keep LIVE fresh while it is the visible tab.
  setInterval(() => { if (active === 'live') loadLive(); }, 5 * 60 * 1000);

  await initGraphs({ onUpdatedAt: setStatus });

  const wanted = location.hash.slice(1);
  showTab(VIEWS[wanted] ? wanted : 'graphs');
}

window.addEventListener('hashchange', () => {
  const wanted = location.hash.slice(1);
  if (VIEWS[wanted] && wanted !== active) showTab(wanted);
});

init().catch(err => {
  console.error('Zephyr Weather failed to start:', err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div class="error" style="margin-bottom:16px;">Could not start the dashboard: ${esc(err.message)}</div>`);
});
