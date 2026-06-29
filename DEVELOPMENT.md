# Development Notes

## Running locally

```bash
docker compose up -d --build
# App at http://localhost:3000
```

Static files (`public/`) are COPY'd into the image — a rebuild is required to pick up frontend changes. Only `data/` is volume-mounted (changes to JSON files are live).

```bash
# Force a full rebuild (needed when editing public/ or server.js)
docker compose down
docker build --no-cache -t trip-planner-trip-planner .
docker compose up -d
```

`node_modules` has no registry access inside Docker, so it is COPY'd from the host. Run `npm install` on the host before rebuilding if dependencies change.

## Trip-specific hardcoding

Things in the codebase that are specific to this trip and would need updating for a different one:

### `server.js` — `HOME_AIRPORTS`
```js
const HOME_AIRPORTS = new Set(['NQN', 'AEP', 'EZE']);
```
Used to classify each flight leg as `outbound`, `connection`, or `return`. Must match the traveller's home airport(s).

### `public/js/map.js` — `AIRPORT_COORDS`
A lookup table of IATA code → lat/lon for every airport in the trip. Any flight leg whose airport code is missing from this table is silently dropped from the map. Expand it when adding new flights.

### `public/js/map.js` — `lat > 35` bounds filter
```js
const euCoords = allCoords.filter(([lat]) => lat > 35);
```
Filters out South American airports so the map opens fitted to Europe rather than a world view. Replace with an explicit bounding box in `trip.json` if the trip changes region.

### `public/js/map.js` — `curveDown` arc override
```js
const curveDown = f.to === 'ATH';
```
Flips the Bezier arc southward for the ORY→ATH flight so it routes through the Mediterranean rather than looping north over central Europe. Remove or adjust if the Greece leg changes.
