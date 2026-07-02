# Map Filters, Stay Markers & Data-Driven Airports — Design

## Goal

Three changes to `map.js`, landing together since the first two both touch
the same rendering/layer logic:

1. **Stay markers** — the map currently draws only flights and trains;
   accommodations aren't shown at all.
2. **Filters** — toggle layers by type (flights/trains/stays) and by trip
   leg (outbound/Europe/return).
3. **Data-driven airport coordinates** — replace the hardcoded
   `AIRPORT_COORDS` table with a lookup fetched from a free external API,
   so a new airport in the itinerary needs no code change.

## 1. Data-driven airports

`hexdb.io`'s keyless airport API (`GET https://hexdb.io/api/v1/airport/iata/{code}`)
returns lat/lon for an IATA code — verified working for all 12 codes
currently in the trip (NQN, AEP, EZE, CDG, ORY, ATH, VIE, GRU, GVA, AMS,
MUC, ZRH), coordinates matching the hardcoded table to 3+ decimal places.
Its `region_name`/`airport` fields are state/airport-name level ("Bayern",
"Munich Airport"), not clean city names — so **display labels keep coming
from the flight data's existing `fromCity`/`toCity`** (already
human-authored, parsed from `flighty.txt`), not from the API. The API is
used for coordinates only.

- **Server** (`server.js`): new cache file `data/airports.json`
  (`jsonStore`, gitignored like `weather.json`), keyed by IATA code →
  `{ lat, lon }`. Airport coordinates don't change, so unlike weather this
  cache never expires — a code is fetched once and kept forever.
  - `GET /api/airports`: derive the set of needed codes from `FLIGHTS`
    (`from`/`to` on every parsed flight), fetch any codes missing from the
    cache (through the same concurrency limiter added for weather —
    generalized to a shared `createLimiter`, reused as a second instance
    so airport calls don't compete with weather's budget), merge, persist,
    return the full map.
  - A code that fails to resolve (network error, unknown code) is simply
    left out of the response; the frontend already has to tolerate a
    missing airport (see below), so this reuses that path rather than
    needing separate error handling.
- **Client** (`map.js`): `AIRPORT_COORDS` constant is deleted.
  `renderMap()` gains an `airports` argument (the fetched code→{lat,lon}
  map); `_buildMap` looks up `airports[f.from]`/`airports[f.to]` instead of
  the old table. A flight whose airport isn't in the map is skipped
  exactly as today (`if (!dep || !arr) continue`).
- **Boot** (`app.js`): add `fetch('/api/airports')` to `init()`. Since
  every code airport is used by, at minimum, the outbound flight, this
  *can* block initial render like `trip`/`accommodations`/`flights` do
  (unlike weather, it's a handful of cheap lookups, and the map has
  nothing to draw without it) — added to the existing `Promise.all`, not
  deferred.

## 2. Stay markers

Each accommodation already has `lat`/`lon`/`color`/`city`/`check_in`/`check_out`
— everything needed to plot it, no data model change.

**Visual treatment:** rather than a pin icon (which would visually compete
with flight/train pins at the same city, since a stay's coordinates and a
train's city coordinates are often identical), each stay renders as a
large, soft, translucent **`L.circleMarker`** in the stay's own `color`,
drawn *first* (so flight/train pins layer on top, unobstructed) — a
color-matched "region wash" consistent with how that same color already
marks the stay everywhere else (day cards, legend, timeline). Clicking it
opens a popup with the city name and date range.

**De-duplication:** two stays share exact coordinates in this trip (both
Buenos Aires stays, both Paris stays). Group by rounded `lat,lon` the same
way flights/trains already group by airport code/city, so one circle marker
lists both stays' date ranges in its popup rather than drawing two
identical overlapping circles.

## 3. Filters

Two independent toggle-chip groups, styled like the existing
`.wishlist-sort-btn` pattern, placed above the map inside `.map-section`:

- **Type**: Flights / Trains / Stays — each a standalone toggle (not a
  radio group; any combination can be active).
- **Leg**: Outbound / Europe / Return — same toggle style.

All six chips start active (nothing hidden by default). Clicking a chip
toggles its layer/leg and re-runs `_buildMap` with the current filter
state — no new data fetch, just a redraw with a narrower slice of the
already-fetched flights/trains/stays.

**Leg derivation** — reuses data that already exists, no new field on any
entity:
- Flights already carry `direction: 'outbound' | 'return' | 'connection'`
  (computed server-side from `HOME_AIRPORTS` + trip midpoint). For
  filtering purposes, `'connection'` *is* the Europe leg (an
  intra-Europe flight is neither outbound-from-home nor return-to-home) —
  mapped 1:1, no new classification logic needed for flights.
- From the outbound/return flights, derive two date boundaries:
  `outboundEnd` = latest `arrivalDate` among `direction === 'outbound'`
  flights; `returnStart` = earliest `departureDate` among
  `direction === 'return'` flights.
- **Trains and stays** get their leg by comparing their date
  (`departureDate` for trains, `check_in` for stays) against those same
  two boundaries: `<= outboundEnd` → outbound, `>= returnStart` → return,
  otherwise → Europe. In this trip's actual data every train and all but
  two stays (the two Buenos Aires ones) land in the Europe bucket, which
  matches reality without any hardcoded country/city list.

## Non-goals

- No persistence of filter state across reloads — resets to all-on every
  page load.
- No offset/collision layout for overlapping circle markers beyond the
  coordinate-rounding de-duplication above.
- No new server field persisted anywhere — leg is computed at render time
  in `map.js` from data the map already receives.
