# Weather Forecast — Design

## Goal

Show a per-day weather badge (icon + temperature) for each stay, on both the
planner day cards and the Today view hero, using each stay's existing
`lat`/`lon` — no new location data needed.

## The forecast-horizon problem

Today is 2026-07-02; the trip runs 2026-09-14 → 2026-10-29 (74–178 days out).
Live weather APIs only forecast ~16 days ahead. That means for most of the
trip's life in this app, there is no real forecast to show — only once a
given day falls within 16 days of "now" does live data exist.

To avoid the feature showing nothing for the next two months, days beyond
the forecast horizon show a **historical average** ("typical weather for
this date, based on past years") instead of a live forecast. The two are
visually distinguished (see UI section) so historical estimates are never
mistaken for a real forecast.

## Data source

[Open-Meteo](https://open-meteo.com) — free, keyless, sufficient for both
needs:
- **Forecast API** (`api.open-meteo.com/v1/forecast`) — daily
  `temperature_2m_max`, `temperature_2m_min`, `weathercode` for dates within
  ~16 days.
- **Archive API** (`archive-api.open-meteo.com/v1/archive`) — same daily
  fields for historical dates. For a trip date, query the same calendar
  date across the previous 3 years (2023, 2024, 2025) and average
  `tempMax`/`tempMin`; take the most frequent `weathercode` among the three
  as the representative icon.

No API key, no new npm dependency — Node 20's built-in `fetch` (already used
for `/api/wishlist/fetch-url`) covers both calls.

## Server changes (`server.js`)

- New cache file `data/weather.json`, read/written via the existing
  `jsonStore` helper — shape:
  ```json
  {
    "computedFor": "2026-07-02",
    "byStay": {
      "a1": { "2026-09-14": { "tempMax": 18, "tempMin": 11, "code": 3, "source": "historical" }, "...": {} }
    }
  }
  ```
- `computeWeather()`: iterates `readAccommodations()`; for each stay, splits
  its `check_in..check_out` date range into "within 16 days of today"
  (forecast) vs. "beyond" (historical), fetches accordingly, and merges
  into `byStay[stay.id]`.
- `GET /api/weather`: if `weather.json` exists and `computedFor` equals
  today's date (server-local `YYYY-MM-DD`), serve the cached file as-is. If
  the model doesn't exist yet or is stale (a new day, or a `?today=`
  dev-override doesn't affect this — it's always real server "now"),
  recompute via `computeWeather()`, write the cache, then serve. This is the
  same "compute lazily on first read" idea already used for parsing
  `flighty.txt`, just re-triggered daily instead of once at boot.
- No new dependency, no cron/scheduler — the daily staleness check on read
  is enough given traffic is a single user's page loads, not high volume.
- If either Open-Meteo call fails (network, rate limit, etc.), that stay is
  simply left out of `byStay` for this pass — the endpoint still returns
  200 with whatever data it does have, and the frontend already tolerates
  missing weather (see below). No retry logic in v1.

## Weathercode → icon mapping

A small bucket function, not a full WMO table:

| Codes | Icon | Meaning |
|---|---|---|
| 0 | ☀️ | Clear |
| 1, 2 | 🌤️ | Mostly clear / partly cloudy |
| 3 | ☁️ | Overcast |
| 45, 48 | 🌫️ | Fog |
| 51–67, 80–82 | 🌧️ | Drizzle / rain / showers |
| 71–77, 85, 86 | ❄️ | Snow |
| 95, 96, 99 | ⛈️ | Thunderstorm |

## Frontend changes

- `public/js/app.js` `init()`: add `fetch('/api/weather')` to the existing
  `Promise.all` alongside trip/accommodations/flights; store the response
  as `tripData.weather` (the `byStay` object).
- `renderPlanner()`: for an in-trip day with an active `stay`, look up
  `tripData.weather?.[stay.id]?.[dayStr]`. If present, render a compact
  `icon temp°` badge next to the existing `.day-location` city label. If
  absent (API failure, or a day outside both forecast and the 3-year
  archive lookup somehow), render nothing — no placeholder, no error state.
- `public/js/today.js` `renderToday()`: same lookup for the resolved
  stay/day, rendered larger in the hero — `icon tempMax°/tempMin°`. When
  `source === 'historical'`, append a `~` prefix and a `title` tooltip
  ("typical for this date, based on 2023–2025") so it reads as an estimate,
  not a forecast promise.
- `public/locales/en.json` / `es.json`: one new string for the historical
  tooltip text.

## Non-goals

- No hourly forecast, precipitation probability, or severe-weather alerts.
- No unit toggle — Celsius only (Open-Meteo default), consistent with the
  rest of the app assuming metric/international units.
- No retry/backoff on Open-Meteo failures — a failed stay just shows no
  badge until the next daily recompute.
- No historical fallback beyond 3 years back or configurable year count.
