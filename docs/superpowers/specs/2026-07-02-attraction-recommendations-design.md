# Attraction Recommendations — Design

## Goal

Surface nearby points of interest (museums, viewpoints, attractions) for
each stay, and let you turn one into a scheduled calendar activity with one
click — without cluttering the map with dozens of un-chosen suggestions.

## Model: two stages, not three

Earlier drafts of this considered a middle "saved, unscheduled" holding
state between a raw suggestion and a scheduled activity. Rejected: a
recommendation goes **directly** to being a scheduled calendar activity via
the existing add-activity modal. There is no separate "places to visit"
list/store. The map's new pin layer (see below) is just "calendar activities
that happen to have a location" — it starts empty and fills in only as you
add recommendation-sourced activities.

## Data source: OpenStreetMap Overpass

Free, keyless — consistent with every other integration added so far
(Open-Meteo, hexdb.io). Verified live against Vienna: querying
`tourism~"attraction|museum|viewpoint|gallery"` within 1.5km returned 20
correctly-named, real results (Albertina, Hundertwasserhaus, Sisi Museum,
Kaisergruft, Café Central, ...). Trade-off accepted knowingly: no ratings,
photos, or opening hours (Google Places has these but is paid and needs a
key — rejected for a personal project with no revenue).

**Query**: node search, `tourism` tag matching
`attraction|museum|viewpoint|gallery|artwork|zoo`, radius 2km around the
stay's `lat`/`lon`, capped at ~30 results.

**Note on Overpass etiquette**: the public `overpass-api.de` instance asks
callers not to hammer it — reinforces why this must be cached, not
refetched per view (see below), and why it's fetched on-demand per stay,
never eagerly for all 13 stays at once.

## Server (`server.js`)

- New cache file `data/recommendations.json` (`jsonStore`, gitignored like
  `weather.json`/`airports.json`), keyed by stay id → array of
  `{ name, category, lat, lon, address }`. Cached **forever** once fetched
  per stay — POI data barely changes, same reasoning as `airports.json`
  (unlike `weather.json`, which expires daily).
- `GET /api/recommendations/:stayId`: look up the stay via
  `readAccommodations()`; 404 if not found or if it has no `lat`/`lon`. If
  cached, serve as-is. Otherwise query Overpass (through the existing
  `createLimiter`-based concurrency guard, a second instance alongside the
  weather/airports ones), parse `elements[].tags.name` /
  `tags.tourism` / lat/lon / any `addr:*` tags into the cache shape,
  persist, return.
- A stay with zero Overpass results caches an empty array (not re-fetched
  every call) — same "cache what you got, even if empty-ish" posture as
  weather's per-day gaps.

## Frontend

### Recommendations panel (new, shared component)

A small reusable renderer — `renderRecommendations(container, stayId,
defaultDate)` — used identically in both surfacing points below. Fetches
`GET /api/recommendations/:stayId` lazily (only when the panel is actually
opened), renders a flat list of cards (name, category badge, "Add" button).
No category filter inside the panel for v1 — just the badge.

**Duplicate guard**: before rendering, cross-reference each recommendation's
`lat`/`lon` (rounded to ~4 decimals) against `tripData.calendar` entries
that already carry `lat`/`lon`. A match renders as "Added ✓" and disables
the button — computed client-side, no new data.

### Surfacing point 1: Today view

`today.js` `renderToday()` gains a collapsed-by-default section — a "See
places recommendations" link/button under the existing activities block.
Only rendered when there's a stay to scope to: the active stay, or (on the
final checkout day, no active stay) the same departing-stay fallback
`renderToday()` already uses for the hero image. Expanding it calls
`renderRecommendations()` for that stay, defaulting any "Add" to today's
date.

### Surfacing point 2: Day-card expand (planner)

`app.js` `toggleCardExpand()` gains a second button next to the existing
`.day-add-btn` ("+ Add event"): "See recommendations" — rendered only when
`getActiveStay()` returns a stay for that day (out-of-stay gap days, if
any, get no recommendations button, same as they get no `.day-location`
today). Clicking it expands an inline panel within the card (same
`renderRecommendations()` call), scoped to that day's active stay,
defaulting "Add" to that specific day.

Both surfacing points resolve to the *same* stay-scoped list — Overpass
results are location-based, not date-based, so every day within one stay
sees identical recommendations.

### "Add" action → existing modal, extended

- `index.html`: two new hidden inputs on the entry form, `entry-lat` /
  `entry-lon`, alongside the existing `entry-address` etc.
- `app.js`: `openAddModal(defaultDate, prefill)` gains an optional second
  parameter — `{ title, address, lat, lon }` — setting those fields (and
  the two new hidden ones) when present; existing no-arg callers are
  unaffected (default `undefined`).
- The submit handler's non-accommodation payload gains
  `lat: modal.lat.value ? Number(modal.lat.value) : null` (and `lon`
  likewise). `POST /api/calendar` needs **no server change** — it already
  spreads `...req.body` into the stored entry.

### Map pin type: "Places"

- A 4th chip in the existing type-filter row (`map.js`), alongside
  Flights/Trains/Stays.
- `_buildMap()` gains a pass over `tripData.calendar` filtering to entries
  with non-null `lat`/`lon`; each renders as a marker (new `_pinIcon('place')`
  variant) with a popup showing title + date. Leg-filtered via the entry's
  `date` against the same `_legFor()` windows already used for trains/stays.
- Starts empty on a fresh trip — that's expected, not an error state.

## i18n

New strings, both locales: the "See places recommendations" / "See
recommendations" link labels, an "Add"/"Added ✓" pair for recommendation
cards, and `map.legendPlace` ("Places" / "Lugares") for the new filter
chip. Category values (`museum`, `attraction`, etc.) come from OSM's
`tourism` tag verbatim rather than through the `t()` lookup — a small,
fixed, English-only vocabulary is an acceptable v1 trade-off rather than
building a translation table for OSM tag values.

## Non-goals

- No "places to visit" holding list — confirmed two-stage model only.
- No category filter inside the recommendations panel (badge only).
- No geocoding of manually-typed activity addresses — only
  recommendation-sourced activities get map pins in v1.
- No user-configurable search radius/category set.
- No de-duplication against *other trip* data beyond the existing
  calendar (e.g., no cross-check against the shopping wishlist).
