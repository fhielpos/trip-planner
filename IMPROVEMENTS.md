# Improvements

Deferred ideas and known limitations we've chosen not to build yet. Each entry: what it is, why it matters, and a sketch of the approach.

## Import / Export

### Harden import security
`POST /api/import` is currently protected only by the global `APP_PASSWORD` basic auth — if that env var isn't set, the endpoint is open. Import is a full overwrite, which makes it a higher-risk operation than the read/write endpoints.

Options considered:
- **Always require basic auth for import** — force the user to set `APP_PASSWORD` before the endpoint responds, even if the rest of the app is unprotected.
- **Separate `IMPORT_TOKEN` header** — a dedicated env var that must be sent as `X-Import-Token` on every import request, independent of the main app password.
- **Backup before overwrite** — before writing, snapshot the current data files so a mistaken import can be rolled back. Could be as simple as writing to `data/backup-YYYY-MM-DD.json` on each import call.

## Itinerary / Planning

### Auto-suggested activities from POI data
For a given stay, query a places API centered on its `lat`/`lon` (already stored on every accommodation), filtered by category (food, museum, viewpoint, outdoor), and surface results as one-click-add cards in the planner's add-activity modal. Accepted suggestions write into the calendar using the same shape manual entries already use — no new schema needed.

Why it matters: going from a blank day to a filled one is the highest-friction part of trip planning; suggestions turn that into curation.

Options considered:
- **Google Places** — best quality/ratings/photos, but paid per-request and needs API key management (env var, like `APP_PASSWORD`).
- **OpenStreetMap/Overpass** — free, no key, but noisier data and weaker rating signal, needs more filtering.

Approach: backend proxies the call (never expose the key client-side) and caches responses server-side (e.g. `data/suggestions-cache.json`, keyed by stay id), since POIs near a fixed lat/lon rarely change and re-querying every page load would waste quota/cost.

### Auto-fill stay coordinates on save
`lat`/`lon` for each stay currently live only in `data/accommodations.json`, hand-typed — the Stay add/edit modal never collects them (only `city`/`check_in`/`check_out`/`url`), so any stay created through the UI gets `lat: null, lon: null` and silently drops out of the map's stay circles, its `fitBounds`, and the weather feature.

**Airbnb's API was considered and ruled out.** Most stays link to Airbnb (`url` field), but Airbnb closed public API access around 2017 — what remains is a partner API gated behind a formal business-partnership application, not available to personal projects. The stored `url` also isn't a public listing page, it's a private `reservation-details` link into the account holder's trip dashboard (`airbnb.com.ar/trips/v1/reservation-details/...`), so even the scrape-a-URL trick already used for wishlist items (`/api/wishlist/fetch-url`, OG tags/JSON-LD) wouldn't work — it would just hit Airbnb's login wall.

**Better fit: Open-Meteo's free, keyless geocoding API** (`geocoding-api.open-meteo.com/v1/search?name=<city>`) — same family as the weather API already in use. Verified against two of the trip's smaller towns:
- Lauterbrunnen → `46.59307, 7.90938` (hand-entered value: `46.5936, 7.9086`)
- Loutraki → `37.9783, 22.97781` (hand-entered value: `37.9778, 22.9727`)

Both match to 3 decimal places — city-level precision, which is exactly what the map circles and weather lookups already need, not street-address precision.

Approach: when `POST`/`PUT /api/accommodations` receives no `lat`/`lon`, geocode the city name server-side as a fallback before saving. Removes the manual JSON-editing step for new stays going forward; existing hand-entered coordinates are untouched. See also "Country (and flag) for stays created in the UI" below — same root cause (the Stay modal's limited fields).

## Today view

### Curated local-tips layer per city (was: notes / recommendations per day)
Show editorial tips for the current place in the Today view — distinct from algorithmic POI suggestions (see "Auto-suggested activities" above) in that this is authored content ("insider tips", "don't miss", "avoid X at night"), not API-pulled data. That distinction is the point: it's a differentiator a generic trip planner can't copy by just integrating another API, since it depends on a trusted content source.

MVP without any CMS: a static curated JSON per city (`data/city-tips.json`, keyed by city name), hand-authored — proves the UX before building any authoring tooling. Longer term, this is also the natural home for partner/affiliate content if the app is ever licensed to a travel company, since their destination experts could populate it directly.

Deferred until the trip gets closer (or until there's an appetite to hand-author the first few cities' content).

### Country (and flag) for stays created in the UI
The Stay modal only asks for city, so UI-created stays have no `country` and render without a flag in the Today hero. Options: add a country field to the modal, or infer from city via a lookup. Cosmetic, low priority.

## Budget

### Warn when sub-budget caps exceed the global budget
Sub-budget caps and `initialBudget` are decoupled — you can allocate caps totalling more than the global budget (e.g. Food 6,000 + Shopping 3,000 + Activities 2,500 = 11,500 against a 10,000 budget) and the tool accepts it silently.

Not necessarily a bug: over-allocating on purpose is valid (you expect to underspend some categories). But there's currently no signal.

Possible approach (non-blocking, no data-model change):
- Live "Allocated X / Y" readout in the settings modal, turning red when over.
- Same summary on the displayed sub-budget block, so the unallocated remainder is always visible.

Avoid a hard block on save — a warning is friendlier and preserves intentional over-allocation.
