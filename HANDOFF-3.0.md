# Zephyr Weather 3.0 — handoff

**Date:** 2026-08-21 · **Session:** Cowork, working locally against
`C:\Users\tothk\Desktop\ZephyrTemperature` · **Previous:** `HANDOFF-2026-08-21.md` (the audit)

This release does everything on Vit's eight-point list plus the P0 items from the audit.
It supersedes the audit document, which is now a record of what *was* wrong.

---

## Verification status

| Check | Result |
|---|---|
| `npm test` | **128 passing**, 0 failing (was 22) |
| `npx eslint .` | clean, 0 errors, 0 warnings |
| `npm audit` | **0 vulnerabilities** (was 3) |
| Mocked end-to-end boot | all 15 routes 200; `/api/status` no longer 500s |
| Headless browser | all 5 tabs rendered at 1600 / 900 / 390 px — no console errors, no page errors, no failed requests, no horizontal overflow |
| Hostile-payload test | markup injected into every Market and cross-check string field renders as inert text; nothing executes |
| Old v2.0 test suite | all 22 tests pass **unmodified** against the new structure |

**Live smoke test after deploy is still worth 5 minutes** — this environment has no real
network, so everything above ran against `tests/mock-fetch.js`. After deploying, check:

1. Graphs load with **Global median** selected, and the Values toggle shows the same numbers.
2. Future shows CZ over HU, and its 12:00 temperature for Prague **matches** the Graphs line
   at 12:00 (this is the fix for point 4 — there is a test for it, but confirm on live data).
3. Weekly can select a week from last year.
4. Market shows real risk chips and a residual-load verdict.
5. `GET /api/health` → `db.ready: true` and `store.dbWriteFailures: 0`.

---

## What changed, against Vit's list

| # | Ask | What was done |
|---|-----|---------------|
| 1 | Full audit, fix bugs and data errors | Every P0 from the audit is fixed — see below. Plus the P1 architecture work, the P2 security items, the P3 test gap and the P4 tooling floor. |
| 2 | Table should be a toggle in Graphs | Table tab removed; **Chart ⇄ Values** toggle on Graphs, reading the exact series the chart draws. Dec button appears only in Values mode. |
| 3 | Group CZ future and HU future | One **Future** tab, Czechia above Hungary, from a single `/api/future` request. |
| 4 | Graphs and Future must agree, on global median | Future now reads the same global-median model set. A route test asserts the two agree hour by hour and fails if they ever diverge. |
| 5 | Rename History → Weekly | Done, including the route (`/api/weekly`, with `/api/history` kept for compatibility). |
| 6 | Nicer, smoother, bigger, faster hovers | Custom tooltip layer replacing every native `title`. 0.86 rem type, title line, arrow, viewport clamping, keyboard support. 120 ms to appear vs the browser's ~500 ms; CSS transitions halved 0.20 s → 0.10 s; Chart.js hover/tooltip animation halved 400/300 ms → 200/120 ms. |
| 7 | Market tab: concrete info, better readability | Rebuilt. Four headline tiles (residual load verdict, top risk, solar %, wind %), a forecast-stability strip, then a compact four-day table. Risks are typed chips with hovers instead of emoji sentences. Residual load is a signed score with its drivers attached. One request instead of five. |
| 8 | Rename to Zephyr Weather + temperature-bar favicon | Done everywhere — title, header, package name, docs. `public/favicon.svg` is a temperature bar; the name sits beside it in the tab. |

---

## P0 defects, and what each one actually was

| ID | Defect | Fix |
|----|--------|-----|
| 0.1 | `updated_at TIMESTAMP` parsed in the Node process zone → a UTC container with a Prague database read every row 1-2 h off, the cache always looked stale, **every request refetched** | `TIMESTAMPTZ` + an in-place `ALTER TABLE … USING` migration in `src/db.js` |
| 0.2 | DB write errors swallowed → the stale DB row was returned forever while memory's fresh copy was never consulted | `src/weather/store.js` tracks write failures, reads take whichever copy is newer, failures are counted in `/api/health` |
| 0.3 | `/api/status` was the only route with no `dbReady` guard | Rebuilt on the store; returns 200 with the DB absent, and reports both memory and DB timestamps |
| 0.4 | Cached payloads carry baked-in day labels; a 23:40 payload was authoritative until 00:40 | Freshness is age **and** `hasCurrentDayLabels()`, applied to the weather store, the median cache and the cross-check verdict (which is now stamped with the day it is for) |
| 0.5 | No coalescing on the best_match path | `store.fetchAndCache` is coalesced per city; the shared `TtlCache` coalesces everything else |
| 0.6 | `POST /api/fetch` unauthenticated, unthrottled, no in-flight guard — and two concurrent runs could **lose frozen history** | `src/refresh.js`: one run at a time, `FETCH_MIN_INTERVAL_MS` throttle, optional `FETCH_TOKEN` |
| 0.7 | No try/catch on `/api/weather`, no error middleware, no `unhandledRejection` handler | Every handler wrapped, real error middleware, JSON 404, process-level handlers |
| 0.8 | Weekly could only address weeks of the current ISO year | `(year, week)` addressing via `shiftIsoWeek`; ~18 months back, 2 weeks forward, tested across the boundary |
| 0.9 | `express.static('public')` was cwd-relative | Absolute path from `__dirname` |

Also fixed from the lower tiers: the SSL setting is env-gated (2.2), the cron has a
`timezone` option (4.3), the client cache has a TTL (5.3), the CDN dependency is vendored
(5.2), inline `onclick` handlers are gone (5.4), and the client no longer reimplements the
server's ISO-week maths (5.5).

---

## New things worth knowing about

- **`GET /api/health`** — cache hit/miss/stale counters, upstream request and retry counts,
  DB state, and the last refresh result. The caching bugs above ran undetected for months
  because there was no way to see them. Watch `store.dbWriteFailures` and
  `caches[].stale` after deploying.
- **`npm run mock`** — boots the whole app against a synthetic Open-Meteo with no network.
  Useful for UI work on a plane, and it is what the route tests run against.
- **`METNO_USER_AGENT` is now enforced.** If it is unset, MET Norway is **not called at all**
  rather than called with a placeholder User-Agent, which violates met.no's terms and gets
  the source silently banned. Set it — this has been an open action item since v1.2.0.
- **The tooltip renders text, never HTML.** If you add a tip, pass a plain string; markup
  will be shown literally, on purpose.

---

## Known gaps / deliberate non-decisions

1. **Express 4, not 5.** Express 5's async error handling would let the `wrap()` helper go,
   but it is a breaking upgrade and this release already moves a lot. `wrap()` costs nothing.
2. **No TypeScript, no build step.** The front-end is native ES modules served statically,
   which is why there is still no bundler. Fine at this size; revisit if it doubles.
3. **The Czechia average is still computed client-side.** It is an unweighted mean, distinct
   from the Market tab's population-weighted demand temperature. Both are correct for their
   purpose and each explains itself on hover, but if it ever needs to be one number, move it
   to the server.
4. **The frozen-history invariant has unit tests but no integration test** — proving it
   across a real refetch cycle needs a Postgres fixture.
5. **`Versions/` snapshots are still missing.** They were git-ignored and never committed,
   so v1.0 and the v1.4.1 snapshot are gone unless they exist on your machine.

---

## Next candidates, in rough order of value

1. Deploy, then watch `/api/health` for a day. If `dbWriteFailures` or the stale counters are
   non-zero, something is wrong with the Railway Postgres connection, and now you can see it.
2. Set `LOG_FORMAT=json` on Railway so the logs are queryable.
3. Consider `FETCH_TOKEN` if the instance is publicly reachable — `POST /api/fetch` is still
   the highest-value target, throttled but open.
4. An integration test for the freeze invariant against a real Postgres.
5. If the Market tab earns its keep, the obvious next step is an actual residual-load
   *number* (MW) rather than a directional score, which needs installed-capacity constants.

---

*Prepared by Claude (Cowork). Every claim above was verified by running it: the test suite,
the linter, `npm audit`, a mocked end-to-end boot, and a headless browser pass over all five
tabs at three viewport widths.*
