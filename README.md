# 🌡️ Zephyr Weather

A temperature and power-fundamentals dashboard for Central Europe, built to support
energy / power-trading decisions. It pulls hourly temperatures and short-range forecasts
from [Open-Meteo](https://open-meteo.com/) and [MET Norway](https://api.met.no/), caches
them, and renders charts, hour-by-hour grids, a 6-day country outlook and a market brief.

> **Renamed in v3.0.** This project was "Temperature Zephyr" / "Weather Comparison 2.0"
> through v2.0.0. Same app, same data, new name.

Two principles the code holds to:

- **It never invents data.** Anything Open-Meteo does not return stays blank.
- **Everything is one source.** Graphs, Values, Future and Weekly all read the same
  global-median series by default, so two tabs can never disagree about the same hour.

---

## The five tabs

| Tab | What it is |
|-----|-----------|
| 📊 **Graphs** | Two charts side by side — Czech cities (incl. a Czechia average) on the left, Budapest / Debrecen / Berlin / Munich on the right. Eight series per city. Flip the **Chart ⇄ Values** toggle to read the same numbers as a heat-coloured grid. |
| 🗓️ **Future** | 6-day country outlook, Czechia above Hungary: temperature at 8/12/16/20/00, pressure, wind, sky, cloud cover, solar (FVE) potential and automatic notes. |
| 📅 **Weekly** | One ISO week, hour by hour: 24 rows × 7 days. Solid cells already happened, light italic cells are model forecasts. Reaches ~18 months back and 2 weeks forward, **across year boundaries**. |
| ⚡ **LIVE** | Right-now conditions for four cities with a ▲/▼ against the same hour yesterday. Auto-refreshes every 5 minutes. |
| 📈 **Market** | Per-country power fundamentals: a residual-load verdict, solar and wind generation indices, typed risk chips and forecast stability. |

### Cross-cutting features

- **Global median by default.** Every hour is the median across ECMWF, DWD ICON, NOAA GFS,
  Météo-France and Open-Meteo best_match. One outlying model cannot move a line. Switch to
  single-model `Openmeteo` from the Source selector; the setting follows you across tabs.
- **Consensus correction.** The displayed values are compared against independent models
  plus MET Norway. Where the shown value is a clear outlier against a *tight* consensus, the
  chart shows the consensus median instead (cyan ◆) and keeps the raw value in the point
  tooltip. Where the other sources disagree among themselves, the hour is flagged (amber ▲)
  and never substituted.
- **Frozen history.** Once a day is 2+ days old its cached values never change again, so a
  post-trade review sees what the desk actually saw. Open-Meteo keeps re-analysing past
  days; without this an already-happened line drifts between refreshes.
- **Forecast revisions.** The strip under each chart shows how far the forecast has moved
  since yesterday's model run. A revision of 1.5 °C or more moves load forecasts and
  day-ahead prices.
- **Data verification.** Five automated check families per city, including a comparison
  against Open-Meteo's ERA5 reanalysis archive.
- **Rich hovers everywhere.** Every metric, row label, badge and risk chip explains itself
  on hover — larger type than the browser's native tooltip and appearing in 120 ms rather
  than roughly half a second.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js ≥ 20 (tested on 20 and 22) |
| Server | Express 4, modular `src/` tree |
| Database | PostgreSQL via `pg` — a **cache**, not the source of truth |
| Scheduling | `node-cron` 4, pinned to `Europe/Prague` |
| Front-end | Static ES modules + [Chart.js](https://www.chartjs.org/) 4.5.1 and `chartjs-plugin-annotation` 3.1.0, **vendored in `public/vendor/`** (no CDN, so a network that blocks jsDelivr does not blank the dashboard) |
| Data | Open-Meteo forecast / previous-runs / historical-forecast / archive (ERA5) / geocoding, plus MET Norway |
| Tests | `node --test` — 128 unit + route tests, offline against a mocked API |
| Lint | ESLint 9 flat config |

---

## Architecture

v3.0 replaced a single 2,000-line `server.js` and a single 2,500-line `index.html` with a
module tree. Nothing about the behaviour changed in that move; the old public helpers are
still re-exported from `server.js`.

```
server.js                    # entry: validate config, init DB, schedule, listen
src/
  config.js                  # ALL configuration + startup validation
  logger.js                  # structured logging
  db.js                      # Postgres pool, schema, TIMESTAMPTZ migration
  app.js                     # express wiring, security headers, error handler
  routes.js                  # every HTTP route
  refresh.js                 # the one "refresh everything" path (coalesced)
  lib/
    dates.js                 # timezone-explicit date + ISO-week maths
    stats.js                 # median, mean, haversine
    cache.js                 # ONE TTL cache: coalescing, stale-on-error, validate hook
    openmeteo.js             # ONE upstream client: timeout, retry, per-host concurrency
  weather/
    parse.js                 # payload -> per-day series, freeze, day-label guard
    store.js                 # memory + Postgres, coalesced fetch
    median.js                # global-median series (the default source)
    revisions.js             # forecast-vs-previous-run signal
    index.js                 # getSeries(city, source) — the single read path
  features/
    verify.js  crosscheck.js  future.js  live.js  market.js  weekly.js
    weather-codes.js
public/
  index.html  styles.css  favicon.svg
  js/         main tooltip api util graphs future weekly live market
  vendor/     chart.umd.min.js  chartjs-plugin-annotation.min.js
tests/        8 files, 128 tests, plus mock-fetch.js (offline API)
```

### Why the cache layer looks the way it does

Two production incidents (v1.4.0 and v1.4.1) were rate-limit collapses caused by unbounded
fan-out to Open-Meteo. Three properties exist specifically to prevent a third:

1. **Coalescing** — N concurrent callers for one city produce ONE upstream request.
2. **Per-host concurrency ceiling** — at most `UPSTREAM_MAX_CONCURRENT` (default 6)
   simultaneous requests to any one upstream host, with everything else queued.
3. **Stale-on-error** — an upstream blip serves the last good value (loudly, and counted in
   `/api/health`) instead of hammering the API on every page load.

And one property exists to prevent a subtler bug: the cache's **`validate` hook**. Weather
payloads carry baked-in day labels, so a payload written at 23:40 is *wrong* at 00:10 even
though it is only 30 minutes old. Freshness is age **and** correct day labels.

---

## Cities

| City | Country | Role |
|------|---------|------|
| Prague | CZ | Graphs, LIVE, Weekly, CZ country proxy, market weight 1.30 |
| Brno | CZ | Graphs, LIVE, Weekly, market weight 0.40 |
| Plzen | CZ | Graphs, Weekly, market weight 0.18 |
| Ostrava | CZ | Graphs, Weekly, market weight 0.28 |
| Budapest | HU | Graphs, LIVE, Weekly, HU country proxy, market weight 1.75 |
| Debrecen | HU | Graphs, LIVE, Weekly, market weight 0.20 |
| Berlin | DE | Graphs, Weekly |
| Munich | DE | Graphs, Weekly |

The **Czechia** entry on the Graphs tab is an *unweighted* hourly mean of Prague, Brno,
Plzen and Ostrava. The Market tab's demand temperature is *population-weighted* — the two
are deliberately different quantities and the hover on each says so.

---

## Market brief — how to read it

Four tiles answer the question before you read anything:

- **Residual load** — demand minus what sun and wind cover, day over day. Renewables push it
  down (*softer*), temperature-driven demand pushes it up (*tighter*). The score combines the
  change in solar index, wind index and degree days; ±10 calls a direction, ±35 calls it
  strong. Driver chips underneath show which component did the pushing.
- **Top risk** — the highest-severity hazard in the window (storms, turbine cut-out gusts,
  heat, frost, snow, morning fog, heavy rain).
- **Solar** — daily radiation total normalised 0–100 % against a clear-sky maximum for the
  month, with the day-over-day change in percentage points.
- **Wind** — hourly wind at ~120 m hub height pushed through a simplified turbine power
  curve (cut-in 11, rated 43, cut-out 90 km/h) and averaged, 0–100 %.

Beneath them, a **forecast stability** strip (how far the forecast moved since yesterday's
run, and how tightly the independent models agree) and a four-day table.

**Fundamentals only.** This is not a price forecast and not trading advice.

---

## API

| Route | Purpose |
|-------|---------|
| `GET /api/config` | Everything the client needs to boot: cities, models, week list, defaults |
| `GET /api/health` | Liveness plus DB, cache, upstream and refresh counters |
| `GET /api/status` | Per-city cache timestamps (works with Postgres down) |
| `GET /api/cities` | City list |
| `GET /api/weather/:city?source=median\|openmeteo` | Per-day hourly series |
| `GET /api/revisions/:city?source=` | Forecast change since yesterday's run |
| `GET /api/verify/:city` | The five data-check families |
| `GET /api/crosscheck/:city` | Today + tomorrow vs independent models and MET Norway |
| `GET /api/future` | Both countries' 6-day outlook in one response |
| `GET /api/future/:country` | One country (CZ or HU) |
| `GET /api/live/:city` | Right-now snapshot + direction vs yesterday |
| `GET /api/market` | Both countries' brief incl. forecast stability |
| `GET /api/market/:country` | One country's brief |
| `GET /api/weekly/:city?year=&week=&source=` | 24×7 grid for one ISO week |
| `POST /api/fetch` | Force a refresh (coalesced, throttled, optionally token-gated) |

Retained for backwards compatibility: `GET /api/preparation/:city` (→ Future) and
`GET /api/history/:city?week=` (→ Weekly, current ISO year only).


---

## Getting started

### Prerequisites

Node.js ≥ 20. PostgreSQL is optional — without it the app runs on the in-memory cache and
simply loses its data on restart.

### Install and run

```bash
npm install
cp .env.example .env        # then edit it
npm start                   # -> http://localhost:3000
```

### Other scripts

```bash
npm test        # 128 unit + route tests, fully offline
npm run lint    # ESLint
npm run mock    # boot against a mocked Open-Meteo — no network needed
npm run dev     # node --watch
```

### Deployment (Railway)

`DATABASE_URL` and `PORT` are injected automatically. Set `METNO_USER_AGENT` yourself, and
consider `LOG_FORMAT=json`. Certificate verification for Postgres is off by default because
Railway's public proxy presents a certificate that cannot be chained — set `PGSSL_STRICT=1`
once you are on a verifiable certificate.

The scheduled refresh is pinned to `Europe/Prague` regardless of the container's clock, and
`updated_at` is `TIMESTAMPTZ`, so a UTC container and a Prague-local database can no longer
disagree about whether the cache is stale.

---

## Configuration reference

Every knob lives in `src/config.js` and is env-overridable. See `.env.example` for the
annotated list. The ones that matter most:

| Variable | Default | Notes |
|----------|---------|-------|
| `DATABASE_URL` | — | Postgres cache. Absent = memory only. |
| `PGSSL_STRICT` | `0` | Verify the Postgres certificate. |
| `METNO_USER_AGENT` | — | **Required** for MET Norway. Without it that source is skipped entirely rather than risking a ban. |
| `FREEZE_PAST` | `1` | Write-once history for days 2+ days old. |
| `WEATHER_CACHE_MS` | `3600000` | Also expires at midnight regardless. |
| `UPSTREAM_MAX_CONCURRENT` | `6` | Per-host request ceiling. Do not raise casually. |
| `REFRESH_CRON` | `0 */6 * * *` | Evaluated in `Europe/Prague`. |
| `FETCH_MIN_INTERVAL_MS` | `60000` | Throttle on `POST /api/fetch`. |
| `FETCH_TOKEN` | — | Set to require `x-fetch-token` on `POST /api/fetch`. |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `pretty` | `json` for production. |

---

## Data stability (provisional history)

Open-Meteo's forecast endpoint returns continuously re-analysed *model* data for past days,
not final observations, and the app overwrites its cache every 6 hours. Without intervention
an already-happened day's line shifts by a few degrees between refreshes.

`FREEZE_PAST` (on by default) fixes this: once a day is 2+ days old, its cached values are
written once and never change. Yesterday and today keep updating, because re-analysis there
is genuinely useful. Cached gaps are still filled from fresh data, and days are matched by
DATE rather than by key — the day keys shift every midnight, the dates do not.

---

## Changelog

### v3.0.0 — August 2026 — Zephyr Weather

The name changed, the structure changed, and every P0 defect from the August 2026 audit is
fixed. **No data semantics changed**: the same models, the same freeze rules, the same
consensus thresholds. All 22 v2.0 unit tests still pass unmodified.

**Renamed**

- "Temperature Zephyr" / "Weather Comparison 2.0" → **Zephyr Weather**, everywhere:
  page title, header, package name, docs. New SVG favicon — a temperature bar — with the
  name beside it in the browser tab.

**Tabs**

- **Table is gone as a tab.** It is now a **Chart ⇄ Values** toggle on the Graphs tab,
  reading exactly the series the chart draws. It used to be a separate tab that defaulted to
  a *different* source, so it could disagree with the graph beside it.
- **CZ future and HU future merged into one Future tab**, Czechia above Hungary, from a
  single request. The two old tabs were both labelled "future" with only a flag to tell them
  apart.
- **History renamed to Weekly** — it has always shown forecasts as well as actuals, so
  "History" was the wrong word.

**One source of truth**

- The Future tab's temperatures now come from the **same global-median model set** the
  Graphs use, instead of best_match alone. That was the cause of "Graphs and Future
  sometimes show different values". There is a route-level regression test that fails if the
  two ever disagree about the same hour again.
- The Source selector on Graphs is the app-wide default and Weekly follows it.

**Correctness (the P0 list)**

- `weather_cache.updated_at` is now `TIMESTAMPTZ`, with an in-place migration for existing
  tables. As `TIMESTAMP` it was parsed in the Node process's local zone, so a UTC container
  with a Prague-local database read every row 1–2 h off, the cache always looked stale, and
  **every request triggered a fresh upstream fetch** — exactly the rate-limit collapse the
  v1.4.1 changelog describes.
- **Memory/DB cache divergence fixed.** Writes tracked their own failure and reads now take
  whichever copy is newer. Previously a swallowed DB write error meant the stale DB row was
  returned forever while memory's fresh copy was never consulted — an unbounded refetch loop
  with no metric and no alert.
- **Day-label staleness fixed.** A payload written at 23:40 was served as authoritative
  until 00:40, with "Today" meaning yesterday — and the cross-check compared that stale array
  against freshly fetched data for the real today. Freshness is now age *and* correct day
  labels, for the weather store, the median cache and the cross-check verdict.
- **Request coalescing** on the primary weather path. The dashboard requests four Czech
  cities at once; a cold start plus the boot fetch plus the cron run could all overlap.
- **`POST /api/fetch` hardened** — one run at a time, a minimum interval between runs, and an
  optional token. It was unauthenticated and unguarded, so repeated clicks stacked
  overlapping runs; two concurrent runs for one city could also race the freeze invariant
  and **lose frozen past values**.
- **`/api/status` no longer 500s without Postgres** — it was the one route missed by the
  v1.2.0 hardening pass.
- **Error handling**: every async handler is wrapped, there is a real error middleware, a
  JSON 404 for unknown API paths, and `unhandledRejection` / `uncaughtException` handlers.
  Express 4 does not catch rejected async handlers, so a throw used to leave the request
  hanging until the client timed out.
- **Weekly reaches across year boundaries.** Weeks are addressed by `(year, week)`; the year
  used to come from "now", so in January the tab offered three weeks total and the previous
  December was unreachable.
- `express.static` uses an absolute path (a blank page if started from another directory),
  the cron schedule is pinned to `Europe/Prague`, and Postgres SSL verification is
  env-configurable instead of hardcoded off.

**Market tab, rebuilt**

- Four headline tiles — residual load verdict, top risk, solar %, wind % — then a forecast
  stability strip, then a compact four-day table.
- Risks are **typed objects** (id, icon, severity, value, explanation) rendered as colour-coded
  chips with hovers, not pre-formatted emoji sentences.
- Residual load is a signed score with its **drivers attached**, not one of five canned
  sentences.
- The whole tab is **one request** instead of five.

**Hovers**

- Native `title` tooltips replaced everywhere by a styled tooltip: larger type (0.86 rem vs
  system default), a title line, an arrow, viewport clamping, keyboard support.
- Appears in **120 ms** instead of the browser's native ~500 ms; CSS hover transitions halved
  (0.20 s → 0.10 s); Chart.js tooltip and hover animations halved (300/400 ms → 120/200 ms).
- The Chart.js tooltip gained colour-matched swatches, bigger fonts and more padding.

**Structure and tooling**

- `server.js` split into `src/` (18 modules); `public/index.html` split into markup,
  a stylesheet and 9 ES modules. No build step.
- Eight hand-rolled caches replaced by one abstraction; ten inline URL templates replaced by
  one upstream client with retry, backoff and a per-host concurrency ceiling; three copies of
  "median of an array" and two model lists collapsed to one each.
- Chart.js **vendored locally** — the CDN tags had no integrity attribute and no fallback, so
  a network that blocks jsDelivr rendered the dashboard blank.
- `/api/health` with cache-hit, upstream and refresh counters; structured logging replaces 57
  raw `console.*` calls.
- Security headers including a strict CSP (possible now that nothing loads cross-origin),
  `express.json` limited to 16 kB, `x-powered-by` off.
- **128 tests** (was 22), covering `analyzeCrossCheck`, `freezePastDays`, `computeRevisions`,
  the market builders, the timezone and ISO-week maths, the cache semantics, and every route
  against the mocked API — `tests/mock-fetch.js` had existed since v1.3.0 and was never wired
  to anything.
- ESLint 9, `.env.example`, `.nvmrc`, `.editorconfig`, and a GitHub Actions workflow.
- Dependencies updated; `npm audit` reports **0 vulnerabilities** (was 3).
- Front-end HTML escaping: an audit of this release's own first draft found that the new
  tooltip rendered its body with `innerHTML` while the Market tab built tips from API
  strings. Tooltips now render as text, `tipAttr` escapes `>` as well as `<`, and numeric
  formatting can no longer throw on a non-numeric payload. Regression tests included.

### v2.0.0 — July 2026 — Weather Comparison 2.0
Rebased on the GitHub main line (v1.4.1) and ported the parallel-branch features:

- **Forecast‑revision tracking.** `parseWeatherPayload` now also stores what yesterday's run
  predicted for **tomorrow** (`tomorrowForecast`) — for best_match *and* the Global‑median
  source. New chart line `Tomorrow Fc (prev run)`, new Table columns, a revision strip under
  each chart (amber when the average revision is ≥ 1.5 °C — a market‑moving move), a
  `🔮 Fc stability` row in the Market tab, and `GET /api/revisions/:city[?source=median]`
  (avg / peak‑hours / max revision for today + tomorrow).
- **Cross‑check + consensus correction extended to tomorrow.** The Tomorrow line is now
  validated exactly like Today (outliers vs a tight consensus replaced, cyan ◆; genuine
  disagreements flagged, amber ▲), plus a **model‑agreement** metric (mean spread between
  ECMWF / ICON / GFS / Météo‑France / MET Norway) for both days. In the v1.4.1 spirit, the
  four model fetches were **batched into one request** (cross‑check is now 2 upstream calls
  per city instead of 5).
- **Frozen history (write‑once past).** Once a day is 2+ days old its cached values never
  change (matching by date, gap‑filling holes, recomputing the past average) — historic
  lines can no longer drift between refreshes. Applies to both the best_match cache and the
  Global‑median cache. Yesterday/today still update. Disable with `FREEZE_PAST=0`.
- **History (and Table) forecast cells are readable now.** The faded 35 %‑opacity forecast
  rendering was hard to read; forecast values now use the **same hue as a light cell with
  dark italic text** — full readability, and the light/dark flip separates model data from
  actuals at a glance. The Market tab's Yesterday column lost its 55 % fade too (tinted
  "actual" column instead).
- **Branding:** app renamed to **Weather Comparison 2.0** (header + browser tab).
- **Tests:** 22 offline unit tests; booted end‑to‑end against the mocked API (all routes).


### v1.4.1 — July 2026 — rate-limit fix (the "everything broke" release)
v1.4.0's Global‑median fetched **one model per call** — up to 12 requests per city — and
promptly tripped Open‑Meteo's rate limits on `api.open-meteo.com`. Since Market, LIVE,
the future tabs and History weeks ≥ current−1 all share that host, they all failed at
once (archive‑served weeks kept working, which is how the culprit was found), and
"Refresh All Data" hung on stalled connections. Fixes:

- **Batched model requests.** Median weather is now **2 calls** per city (forecast +
  previous‑runs, all models in one `models=a,b,c` request, suffixed variables parsed);
  History median is **1 call**. `metno_seamless` was dropped from the model lists — it has
  no coverage for any of our cities, so it only burned quota (the real MET Norway API is
  still used by the cross‑check).
- **15‑second timeout on every upstream request** (`tFetch`) — nothing can hang a route,
  or "Refresh All Data", for minutes any more. The refresh also fetches all cities in
  parallel instead of sequentially with delays.
- **Stale‑over‑error everywhere.** Preparation, History, LIVE and Market now serve the
  last good result when a fresh fetch fails, instead of blanking the tab.
- **In‑flight coalescing** for median weather (the Czechia average asks for 4 cities at
  once; simultaneous requests for the same city now share one fetch).
- **Version snapshots.** Working releases are frozen into `Versions/<n>/` folders
  (git‑ignored). `Versions/1.0/` = this release. If the app misbehaves after a change,
  run the snapshot instead and compare.

Note: if Open‑Meteo's **daily** quota was exhausted by the incident, some tabs may stay
degraded until the quota resets at midnight UTC — the app now survives that gracefully.

### v1.4.0 — July 2026 — median everywhere, forecasts in History, Dec buttons
- **Graphs: Source dropdown.** Global median (default) or Openmeteo, feeding **all** lines
  including the Czechia average and the previous‑run "Today Forecast" series. Median data
  is fetched one model per call (ECMWF, DWD ICON, NOAA GFS, Météo‑France, MET Norway,
  best_match — no‑coverage models skipped) and medianed per hour; served by
  `GET /api/weather/:city?source=median`, cached in memory for 1 h.
- **History: future weeks.** The week dropdown now reaches **current + 2**; hours that have
  not happened yet are filled from the models' forecasts (up to Open‑Meteo's ~16‑day
  horizon) and rendered **faded + italic** so they can never be mistaken for actuals; the
  API responds with a `cutoff` marking the boundary. **Global median is now the default
  source.**
- **Table: every 2 hours + heat map.** Rows at 2‑hour steps (was 4), and the same
  green→red heat colouring as History, scaled to the values on screen.
- **Dec buttons.** History and Table each get a top‑right **Dec** button cycling
  0 → 1 → 2 decimal places (0 default), re‑rendering instantly from cached data.

### v1.3.1 — July 2026 — SVG flags, History heat map
- **Flag rendering fixed for real.** The v1.3.0 webfont approach failed in practice:
  `<button>` elements don't inherit the page font, and Windows has no native flag glyphs,
  so the tabs still showed "CZ"/"HU". The tabs and the future‑tab captions now use tiny
  **inline SVG flags** — vector shapes, no font, no CDN, render identically everywhere.
  The webfont was removed.
- **History heat map.** Every filled cell in the 📖 History table is colour‑coded within
  the displayed week: coldest hour = dark green background, warmest = dark red, hue
  gradient (green → yellow → orange → red) in between, with light text for contrast.
  The footer legend shows the scale with the week's actual min/max.

### v1.3.0 — July 2026 — History tab, 6‑day outlook, flag tabs
- **📖 History tab.** Pick a **city** (all eight), an **ISO week of this year** (1 → the
  current week) and a **source**, and see the actual temperature for every hour that has
  already happened in that week — 24 hourly rows × 7 day columns (Mon–Sun). Hours still in
  the future stay blank: this tab never shows forecast values. Sources: **Openmeteo**
  (best_match) or **Global median** — the per‑hour median of ECMWF, DWD ICON, NOAA GFS,
  Météo‑France, MET Norway and Open‑Meteo. Models are fetched one per call (same pattern
  as the cross‑check), so a source with no coverage (MET Norway's Nordic model does not
  reach CZ/HU) is skipped automatically and the footer lists what was actually used.
  Finished weeks come from Open‑Meteo's **Historical Forecast archive**; weeks touching
  the last ~3 days use the forecast endpoint's `past_days` so the newest hours are present.
  Served by `GET /api/history/:city?week=N&source=openmeteo|median` (in‑memory cache:
  6 h for finished weeks, 15 min for the current one).
- **Future tabs: one more day.** The CZ/HU outlook now covers **6 days** (Today → D+5).
- **Future tabs: 12:00 and 20:00 rows.** Temperature rows are now 8:00 / 12:00 / 16:00 /
  20:00 / 0:00, in chronological order.
- **Flag tabs.** "CZ future" / "HU future" are now **🇨🇿 future / 🇭🇺 future**. Windows has no
  native flag‑emoji glyphs (the tabs would show plain "CZ"/"HU" letters), so the page loads
  a tiny Twemoji **country‑flags subset font** from the same pinned jsDelivr CDN as
  Chart.js, restricted via `unicode-range` to flag codepoints only. If the CDN is
  unreachable the tabs degrade to the letters CZ / HU.
- **Tests restored.** `npm test` (offline unit tests in `tests/`) covers the new ISO‑week /
  median / table‑assembly helpers and the 6‑day parser. `tests/mock-fetch.js` lets you boot
  the whole app against a synthetic Open‑Meteo for smoke tests:
  `node --require ./tests/mock-fetch.js server.js`.

### v1.2.0 — July 2026 — consensus correction, Market brief, hardening
- **Consensus correction (cross‑check upgrade).** The cross‑check no longer only flags bad
  hours — when the primary (best_match) value is > 4 °C away from the median of the other
  sources *and* at least 3 of those sources agree within 2 °C of each other, the displayed
  Today value is replaced by their median (cyan ◆ marker; the raw model value stays in the
  tooltip and in the API's `primary` field). When the other sources disagree among
  themselves, the hour is only flagged (amber ▲), never replaced. Missing primary hours are
  gap‑filled from a tight consensus. Config: `CROSSCHECK.CONSENSUS_SPREAD_C`,
  `CROSSCHECK.CONSENSUS_MIN_SOURCES`. Cached/stored data is never modified.
- **📈 Market tab.** New per‑country (CZ / HU) power‑fundamentals brief for Yesterday
  (context) / Today / Tomorrow / D+2: population‑weighted demand temperature with HDD/CDD,
  a 0–100 % solar index (daily radiation vs clear‑sky monthly max), a 0–100 % wind index
  (120 m hub‑height wind through a simplified turbine power curve), grid‑risk flags
  (storms, cut‑out gusts, morning fog, snow, heat, frost, heavy rain) and a plain‑language
  day‑over‑day signal incl. residual‑load direction. New `/api/market/:country` route.
  Fundamentals only — explicitly not price advice.
- **Startup resilience.** The server now starts even when Postgres is missing or down —
  it warns and degrades to an in‑memory cache (previously it silently never listened).
  A pool error handler prevents crashes on DB restarts.
- **Front‑end data hygiene.** HTTP errors / error payloads are no longer cached as if they
  were weather data (previously a single 500 could break charts until a manual refresh);
  the Czechia average now skips invalid cities instead of crashing.
- **LIVE pressure fix.** The yesterday‑delta is only computed when both values are MSL
  pressure; the surface‑pressure fallback (~30–45 hPa lower at these altitudes) no longer
  produces a bogus ▼ comparison.
- **Test suite.** `npm test` (`node --test tests/`) with 27 offline unit tests covering the
  cross‑check consensus logic, market brief, LIVE parsing, verification and helpers.


### v1.1.0 — July 2026 — LIVE tab
- **LIVE tab.** New right‑now dashboard for Prague, Brno, Budapest and Debrecen —
  temperature, wind, rain/storms and pressure, each with the current value + ▲/▼ vs the same
  hour yesterday and hover‑for‑grid‑meaning tooltips. New `/api/live/:city` route.
- **Versioning.** The pre‑LIVE app is archived as a frozen baseline in `Temperature1.0/`;
  the main folder is bumped to **1.1.0** and carries development forward.

### July 2026 — data trust
- **Cross‑check / confidence.** Today's shown values are now compared against independent
  Open‑Meteo models (ECMWF, DWD ICON, NOAA GFS, Météo‑France) and MET Norway. Hours that
  disagree with the consensus by more than 4 °C are flagged with a confidence badge, a
  detail panel, and ⚠ markers on the chart. Data is never altered, and changes all sources
  agree on are not flagged. Adds the `/api/crosscheck/:city` route and the
  `METNO_USER_AGENT` env var.
- **Documented provisional history** — added the "Data stability" section explaining why
  recent past days can change between refreshes.

### June 2026 — maintenance & feature pass
- **Pinned the Chart.js CDN versions** (`chart.js@4.5.1`, `chartjs-plugin-annotation@3.1.0`).
  They were previously loaded unversioned ("always latest"), which risked an upstream major
  release silently breaking the charts.
- **Clickable legends** — legend items under each graph now toggle their line on/off, with
  independent left/right state that persists across city changes.
- **CZ / HU future headers** now show a third line, the **weekday name** (label / date / day).
- **Fixed a client‑side timezone bug** — the header date was derived from UTC + browser‑local
  time and could show the wrong day around midnight; it now uses `Europe/Prague`, matching the
  server.
- **Hardened `analyzeTemps`** against empty / all‑null data (no more `Infinity` bounds).
- **Dependencies** — raised floors to a current security baseline (`express ^4.21.2`,
  `pg ^8.22.0`), kept `node-cron` on 3.x, and widened the Node engines range to `>=20`
  (the deploy environment runs Node 22). `package-lock.json` re‑synced.

---

## License

No license file is currently included in this repository. Add one before distributing
publicly if you intend to open‑source the project.
