# Attraction Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user browse nearby points of interest for a stay and turn one into a scheduled calendar activity with one click, surfaced from the Today view and the planner's day-card expand view, with those activities also appearing as a new pin layer on the trip map.

**Architecture:** A new server endpoint queries OpenStreetMap's free Overpass API per stay (cached forever, like `airports.json`) and returns a flat list of POIs. A new shared frontend component (`recommendations.js`) renders that list as cards with an "Add" button, reused identically from both the Today view and the planner's day-card expand. "Add" opens the existing add-activity modal, now extended to accept a pre-fill (including `lat`/`lon`, two new hidden fields) and to persist those coordinates through save. The map gains a fourth pin layer reading calendar entries that carry coordinates.

**Tech Stack:** Plain Node/Express backend (no framework beyond what's already there), vanilla JS frontend (no bundler, no modules — every file is a plain `<script>` tag sharing global scope), Leaflet for the map. No test framework exists in this repo; every task is verified via `curl` (server) or a manual browser/console check (frontend), matching how the weather and map-filter features earlier in this project were verified.

## Global Constraints

- No new npm dependencies — Node 20's built-in `fetch` covers the Overpass call, same as every other external integration in this codebase (Open-Meteo, hexdb.io).
- No API keys — Overpass is free and keyless; this rules out Google Places, which was explicitly rejected in the design doc.
- Follow existing patterns exactly: `jsonStore()` for caching, `createLimiter()` for concurrency-bounding outbound calls (both already defined in `server.js`), the existing `_pinIcon`/`_chip` helpers in `map.js`, the existing modal object/field pattern in `app.js`.
- Every new user-facing string needs both `public/locales/en.json` and `public/locales/es.json` entries — no exceptions (per `CLAUDE.md`/project convention already followed by every prior feature this session).
- Commit messages: one line, no mention of Claude (per `/Users/franco/github/trip-planner/CLAUDE.md`). Use `git commit -s` (Signed-off-by required).
- Design reference: `docs/superpowers/specs/2026-07-02-attraction-recommendations-design.md` — read it if anything in this plan seems to contradict it; this plan implements it exactly, with one intentional reordering (see Task 2 vs. Task 3 below) and one intentional simplification (a single shared i18n string for both "See recommendations" surfaces, not two near-duplicates).

---

## Task 1: Server — recommendations endpoint

**Files:**
- Modify: `server.js:26-27` (add `RECOMMENDATIONS_FILE` constant)
- Modify: `server.js:504` (insert new section immediately after the `/api/airports` endpoint, before the `// Update trip info` comment)

**Interfaces:**
- Consumes: `readAccommodations()` (already defined, `server.js:255` area), `jsonStore()` (already defined), `createLimiter()` (already defined, `server.js:338` area).
- Produces: `GET /api/recommendations/:stayId` → `200` with a JSON array of `{ name: string, category: string, lat: number, lon: number, address: string|null }`, or `404` with `{ error: string }` if the stay doesn't exist or has no `lat`/`lon`. Later tasks (3) consume this endpoint via `fetch(`/api/recommendations/${stayId}`)`.

- [ ] **Step 1: Add the cache file constant**

In `server.js`, find:
```js
const WEATHER_FILE   = path.join(__dirname, 'data', 'weather.json');
const AIRPORTS_FILE  = path.join(__dirname, 'data', 'airports.json');
```
Change to:
```js
const WEATHER_FILE   = path.join(__dirname, 'data', 'weather.json');
const AIRPORTS_FILE  = path.join(__dirname, 'data', 'airports.json');
const RECOMMENDATIONS_FILE = path.join(__dirname, 'data', 'recommendations.json');
```

- [ ] **Step 2: Add the recommendations section**

In `server.js`, find the end of the airports section:
```js
app.get('/api/airports', async (req, res) => {
  const codes = [...new Set(FLIGHTS.flatMap(f => [f.from, f.to]))];
  const cache = airportsStore.read();
  const missing = codes.filter(c => !cache[c]);
  if (missing.length) {
    const fetched = await Promise.all(missing.map(fetchAirport));
    missing.forEach((code, i) => { if (fetched[i]) cache[code] = fetched[i]; });
    airportsStore.write(cache);
  }
  res.json(cache);
});

// Update trip info
```
Insert a new section between them:
```js
app.get('/api/airports', async (req, res) => {
  const codes = [...new Set(FLIGHTS.flatMap(f => [f.from, f.to]))];
  const cache = airportsStore.read();
  const missing = codes.filter(c => !cache[c]);
  if (missing.length) {
    const fetched = await Promise.all(missing.map(fetchAirport));
    missing.forEach((code, i) => { if (fetched[i]) cache[code] = fetched[i]; });
    airportsStore.write(cache);
  }
  res.json(cache);
});

// ── Recommendations ─────────────────────────────
// Nearby points of interest per stay, from OpenStreetMap's free Overpass
// API — see docs/superpowers/specs/2026-07-02-attraction-recommendations-design.md.
// Cached forever per stay once fetched (like airports.json): POI data
// barely changes, and Overpass's public instance asks callers not to
// refetch unnecessarily.

const recommendationsStore = jsonStore(RECOMMENDATIONS_FILE, () => ({}));
const recommendationsFetchLimit = createLimiter(4);

async function fetchOverpassPOIs(lat, lon) {
  const query = `[out:json][timeout:20];` +
    `(node["tourism"~"attraction|museum|viewpoint|gallery|artwork|zoo"](around:2000,${lat},${lon}););` +
    `out body 30;`;
  return recommendationsFetchLimit(async () => {
    try {
      const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      const json = await res.json();
      return (json.elements || [])
        .filter(el => el.tags?.name && el.lat != null && el.lon != null)
        .map(el => ({
          name:     el.tags.name,
          category: el.tags.tourism,
          lat:      el.lat,
          lon:      el.lon,
          address:  [el.tags['addr:street'], el.tags['addr:housenumber']].filter(Boolean).join(' ') || null,
        }));
    } catch {
      return [];
    }
  });
}

app.get('/api/recommendations/:stayId', async (req, res) => {
  const stay = readAccommodations().find(a => a.id === req.params.stayId);
  if (!stay || stay.lat == null || stay.lon == null) {
    return res.status(404).json({ error: 'Stay not found or missing coordinates' });
  }

  const cache = recommendationsStore.read();
  if (!cache[stay.id]) {
    cache[stay.id] = await fetchOverpassPOIs(stay.lat, stay.lon);
    recommendationsStore.write(cache);
  }
  res.json(cache[stay.id]);
});

// Update trip info
```

- [ ] **Step 3: Syntax check**

Run: `node --check server.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Verify against the real Overpass API**

The sandbox this was designed in sits behind a corporate proxy that Node's built-in `fetch` doesn't route through automatically (this is a sandbox-only quirk — a normal Docker host has direct internet access, so this step is only needed if you're verifying in a similarly proxied environment). If `fetch` fails silently and you get `404`/empty arrays for every stay, confirm plain internet access works first with:

```bash
curl -s "https://overpass-api.de/api/interpreter?data=%5Bout%3Ajson%5D%3B" -o /dev/null -w "%{http_code}\n"
```

Then start the server and hit the endpoint for the Vienna stay (id `a5`, per `data/accommodations.json`):

```bash
rm -f data/recommendations.json
PORT=3099 node server.js &
sleep 1
curl -s http://localhost:3099/api/recommendations/a5 | node -e "
const data = JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log('count:', data.length);
console.log(data.slice(0, 5));
"
kill %1
```
Expected: `count` around 15-30, with recognizable Vienna attraction names (Albertina, Hundertwasserhaus, Sisi Museum, etc. — matches the live sample already pulled during design). Run the same `curl` a second time (server still running) and confirm the response is instant (served from `data/recommendations.json`, not re-fetched).

Also verify the 404 path:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3099/api/recommendations/nonexistent
```
Expected: `404`.

Clean up: `rm -f data/recommendations.json` (gitignored, but don't leave stale test data around).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -s -m "feat: add recommendations endpoint backed by Overpass"
```

---

## Task 2: `app.js` — thread lat/lon through the add/edit modal

**Files:**
- Modify: `public/index.html:259` (add two hidden inputs)
- Modify: `public/js/app.js:480-503` (modal object), `:540-551` (`openAddModal`), `:553-571` (`openEditModal`), `:609-663` (submit handler), `:694-716` (`init`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `openAddModal(defaultDate, prefill)` — `prefill` is optional, shape `{ title, address, lat, lon }`. Task 3's `recommendations.js` calls this with a prefill object. `modal.lat` / `modal.lon` (DOM refs) — not consumed elsewhere directly, but the pattern (hidden input holding a numeric-or-empty string) is what Task 3's duplicate-guard logic in `recommendations.js` reads back out of `tripData.calendar` entries after save.

- [ ] **Step 1: Add hidden inputs to the modal form**

In `public/index.html`, find:
```html
      <form class="modal-form" id="modal-form">
        <input type="hidden" id="entry-id" />
```
Change to:
```html
      <form class="modal-form" id="modal-form">
        <input type="hidden" id="entry-id" />
        <input type="hidden" id="entry-lat" />
        <input type="hidden" id="entry-lon" />
```

- [ ] **Step 2: Add the two fields to the modal object**

In `public/js/app.js`, find:
```js
const modal = {
  overlay:    $('modal-overlay'),
  titleEl:    $('modal-title'),
  form:       $('modal-form'),
  id:         $('entry-id'),
```
Change to:
```js
const modal = {
  overlay:    $('modal-overlay'),
  titleEl:    $('modal-title'),
  form:       $('modal-form'),
  id:         $('entry-id'),
  lat:        $('entry-lat'),
  lon:        $('entry-lon'),
```

- [ ] **Step 3: Extend `openAddModal` to accept a prefill**

Find:
```js
function openAddModal(defaultDate) {
  modal.form.reset();
  modal.id.value = '';
  modal.form.dataset.kind = '';
  modal.titleEl.textContent = t('modal.addTitle');
  modal.deleteBtn.hidden = true;
  lockTypeButtons('');
  setType('activity');
  if (defaultDate) modal.date.value = defaultDate;
  modal.overlay.hidden = false;
  setTimeout(() => modal.title.focus(), 50);
}
```
Replace with:
```js
function openAddModal(defaultDate, prefill) {
  modal.form.reset();
  modal.id.value = '';
  modal.form.dataset.kind = '';
  modal.titleEl.textContent = t('modal.addTitle');
  modal.deleteBtn.hidden = true;
  lockTypeButtons('');
  setType('activity');
  if (defaultDate) modal.date.value = defaultDate;
  if (prefill) {
    modal.title.value   = prefill.title || '';
    modal.address.value = prefill.address || '';
    modal.lat.value      = prefill.lat ?? '';
    modal.lon.value      = prefill.lon ?? '';
  }
  modal.overlay.hidden = false;
  setTimeout(() => modal.title.focus(), 50);
}
```

- [ ] **Step 4: Round-trip lat/lon on edit**

Find:
```js
  modal.title.value     = e.title || '';
  modal.address.value   = e.address || '';
  modal.notes.value     = e.notes || '';
  modal.date.value      = e.date || '';
  modal.startTime.value = e.startTime || '';
  modal.endTime.value   = e.endTime || '';
  modal.overlay.hidden = false;
  setTimeout(() => modal.title.focus(), 50);
}

function openStayModal(id) {
```
Replace with:
```js
  modal.title.value     = e.title || '';
  modal.address.value   = e.address || '';
  modal.notes.value     = e.notes || '';
  modal.date.value      = e.date || '';
  modal.startTime.value = e.startTime || '';
  modal.endTime.value   = e.endTime || '';
  modal.lat.value        = e.lat ?? '';
  modal.lon.value        = e.lon ?? '';
  modal.overlay.hidden = false;
  setTimeout(() => modal.title.focus(), 50);
}

function openStayModal(id) {
```

- [ ] **Step 5: Persist lat/lon on save, and re-render the map afterward**

Find:
```js
  const payload = {
    type,
    title:     modal.title.value.trim(),
    address:   modal.address.value.trim(),
    notes:     modal.notes.value.trim(),
    date:      modal.date.value,
    startTime: modal.startTime.value,
    endTime:   modal.endTime.value,
  };
  try {
    if (id) {
      const r = await fetch(`/api/calendar/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const updated = await r.json();
      const idx = tripData.calendar.findIndex(x => x.id === id);
      if (idx !== -1) tripData.calendar[idx] = updated;
    } else {
      const r = await fetch('/api/calendar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      tripData.calendar.push(await r.json());
    }
    closeModal();
    renderPlanner();
    renderInfoBar();
  } catch { alert(t('modal.saveFailed')); }
});
```
Replace with:
```js
  const payload = {
    type,
    title:     modal.title.value.trim(),
    address:   modal.address.value.trim(),
    notes:     modal.notes.value.trim(),
    date:      modal.date.value,
    startTime: modal.startTime.value,
    endTime:   modal.endTime.value,
    lat:       modal.lat.value ? Number(modal.lat.value) : null,
    lon:       modal.lon.value ? Number(modal.lon.value) : null,
  };
  try {
    if (id) {
      const r = await fetch(`/api/calendar/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const updated = await r.json();
      const idx = tripData.calendar.findIndex(x => x.id === id);
      if (idx !== -1) tripData.calendar[idx] = updated;
    } else {
      const r = await fetch('/api/calendar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      tripData.calendar.push(await r.json());
    }
    closeModal();
    renderPlanner();
    renderInfoBar();
    if (typeof renderMap === 'function') {
      renderMap(tripData.flights, tripData.trains, tripData.accommodations, tripData.airports, tripData.calendar);
    }
  } catch { alert(t('modal.saveFailed')); }
});
```

- [ ] **Step 6: Pass calendar data into the initial map render**

Find (in `init()`):
```js
    if (typeof renderMap  === 'function') renderMap(tripData.flights, tripData.trains, tripData.accommodations, tripData.airports);
```
Change to:
```js
    if (typeof renderMap  === 'function') renderMap(tripData.flights, tripData.trains, tripData.accommodations, tripData.airports, tripData.calendar);
```

Note: `map.js` doesn't accept a 5th parameter yet — that's Task 4. Passing it now is harmless (JS silently ignores extra arguments to a function that doesn't declare them), and means Task 4 doesn't have to also touch this call site.

- [ ] **Step 7: Syntax check**

Run: `node --check public/js/app.js`
Expected: no output, exit code 0.

- [ ] **Step 8: Manual verification**

Start the server (`PORT=3099 node server.js &`), open `http://localhost:3099/` in a browser, open the devtools console, and run:

```js
openAddModal('2026-09-26', { title: 'Test POI', address: 'Test Street 1', lat: 48.2, lon: 16.37 });
```
Expected: the modal opens with Title = "Test POI", Location = "Test Street 1", and the date field set to 2026-09-26 (visually — the lat/lon hidden fields aren't visible, confirm via console: `document.getElementById('entry-lat').value` should be `"48.2"`).

Save it. Then run:
```js
fetch('/api/calendar').then(r=>r.json()).catch(()=>{}); // (if no direct calendar-only endpoint, check via) 
```
Actually simplest: reload the page, click the day (Sept 26) in the planner to expand it, click the new chip to edit it, and confirm the modal reopens with the same title/address (lat/lon aren't visible in the UI yet, but check `document.getElementById('entry-lat').value` is still `"48.2"` after `openEditModal` runs — i.e. it round-tripped through a save).

Delete this test activity afterward (Delete button in the modal) so it doesn't pollute the trip data.

- [ ] **Step 9: Commit**

```bash
git add public/index.html public/js/app.js
git commit -s -m "feat: thread lat/lon through the add/edit activity modal"
```

---

## Task 3: `recommendations.js` — shared recommendations component

**Files:**
- Create: `public/js/recommendations.js`
- Modify: `public/index.html:384` (add script tag)
- Modify: `public/locales/en.json`, `public/locales/es.json` (new strings)
- Modify: `public/css/styles.css` (recommendation card styles)

**Interfaces:**
- Consumes: `GET /api/recommendations/:stayId` (Task 1), `openAddModal(defaultDate, prefill)` (Task 2), global `tripData` (defined in `app.js`), global `t()` (defined in `i18n.js`).
- Produces: `renderRecommendations(container, stayId, defaultDate)` — an async function. Called by Task 5 (`today.js`) and Task 6 (`app.js` day-card expand) with a container element, a stay id, and the date to default new activities to.

- [ ] **Step 1: Add i18n strings**

In `public/locales/en.json`, find:
```json
  "today.spentToday": "{spent} spent today",
  "weather.historicalTooltip": "Typical for this date, based on the last 3 years — not a live forecast",
```
Change to:
```json
  "today.spentToday": "{spent} spent today",
  "weather.historicalTooltip": "Typical for this date, based on the last 3 years — not a live forecast",
  "recommendations.seeLink": "See recommendations",
  "recommendations.empty": "No recommendations found nearby.",
  "recommendations.loadFailed": "Couldn't load recommendations.",
  "recommendations.add": "Add",
  "recommendations.added": "Added ✓",
```

In `public/locales/es.json`, find:
```json
  "today.spentToday": "{spent} gastado hoy",
  "weather.historicalTooltip": "Típico para esta fecha, según los últimos 3 años — no es un pronóstico en vivo",
```
Change to:
```json
  "today.spentToday": "{spent} gastado hoy",
  "weather.historicalTooltip": "Típico para esta fecha, según los últimos 3 años — no es un pronóstico en vivo",
  "recommendations.seeLink": "Ver recomendaciones",
  "recommendations.empty": "No se encontraron recomendaciones cerca.",
  "recommendations.loadFailed": "No se pudieron cargar las recomendaciones.",
  "recommendations.add": "Agregar",
  "recommendations.added": "Agregado ✓",
```

- [ ] **Step 2: Create `recommendations.js`**

Create `public/js/recommendations.js`:
```js
/* =============================================
   Attraction Recommendations — shared panel used
   by both the Today view and the planner's
   day-card expand view.
   ============================================= */

function _recEscHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// A recommendation is "already added" if some calendar entry already has
// a lat/lon within ~10m of it — cross-referenced client-side against
// tripData.calendar, no new data needed.
function _recAlreadyAdded(rec) {
  return (tripData?.calendar || []).some(e =>
    e.lat != null && e.lon != null &&
    Math.abs(e.lat - rec.lat) < 0.0001 && Math.abs(e.lon - rec.lon) < 0.0001
  );
}

function _recCard(rec, defaultDate) {
  const added = _recAlreadyAdded(rec);
  const card = document.createElement('div');
  card.className = 'rec-card';
  card.innerHTML = `
    <div class="rec-card-info">
      <span class="rec-card-name">${_recEscHtml(rec.name)}</span>
      <span class="rec-card-category">${_recEscHtml(rec.category)}</span>
    </div>
    <button type="button" class="rec-card-add"${added ? ' disabled' : ''}>
      ${added ? t('recommendations.added') : t('recommendations.add')}
    </button>`;
  if (!added) {
    card.querySelector('.rec-card-add').addEventListener('click', () => {
      openAddModal(defaultDate, {
        title:   rec.name,
        address: rec.address || '',
        lat:     rec.lat,
        lon:     rec.lon,
      });
    });
  }
  return card;
}

async function renderRecommendations(container, stayId, defaultDate) {
  container.innerHTML = '';
  container.classList.add('rec-panel');
  try {
    const res = await fetch(`/api/recommendations/${stayId}`);
    if (!res.ok) { container.textContent = t('recommendations.loadFailed'); return; }
    const recs = await res.json();
    if (!recs.length) { container.textContent = t('recommendations.empty'); return; }
    recs.forEach(rec => container.appendChild(_recCard(rec, defaultDate)));
  } catch {
    container.textContent = t('recommendations.loadFailed');
  }
}
```

- [ ] **Step 3: Add CSS for the recommendation cards**

In `public/css/styles.css`, add after the `.day-add-btn:hover` rule (find `.day-add-btn:hover { ... }` and its closing brace):
```css
.rec-panel {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.5rem;
}
.rec-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-card);
}
.rec-card-info {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}
.rec-card-name {
  font-family: var(--font-display);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rec-card-category {
  font-size: 0.66rem;
  color: var(--text-3);
  text-transform: capitalize;
}
.rec-card-add {
  flex-shrink: 0;
  padding: 0.25rem 0.55rem;
  border-radius: 6px;
  border: 1px solid var(--accent);
  background: var(--accent-dim);
  color: var(--accent);
  font-family: var(--font-display);
  font-size: 0.68rem;
  font-weight: 600;
  cursor: pointer;
}
.rec-card-add:hover { background: var(--accent); color: #fff; }
.rec-card-add:disabled {
  opacity: 0.5;
  cursor: default;
  border-color: var(--border);
  background: none;
  color: var(--text-3);
}
```

- [ ] **Step 4: Load the new script**

In `public/index.html`, find:
```html
  <script src="/js/timeline.js"></script>
  <script src="/js/today.js"></script>
```
Change to:
```html
  <script src="/js/timeline.js"></script>
  <script src="/js/recommendations.js"></script>
  <script src="/js/today.js"></script>
```

- [ ] **Step 5: Syntax check**

Run: `node --check public/js/recommendations.js`
Expected: no output, exit code 0.

Run: `node -e "JSON.parse(require('fs').readFileSync('public/locales/en.json'))" && echo OK`
Run: `node -e "JSON.parse(require('fs').readFileSync('public/locales/es.json'))" && echo OK`
Expected: both print `OK`.

- [ ] **Step 6: Manual verification**

Start the server, open the app in a browser, open devtools console, and run:
```js
const div = document.createElement('div');
document.body.prepend(div);
renderRecommendations(div, 'a5', '2026-09-26');
```
Expected: within a couple seconds, a list of recommendation cards appears at the top of the page (Vienna attractions — Albertina, Hundertwasserhaus, etc.), each with a category badge and an "Add" button. Click one's "Add" button — the add-activity modal should open pre-filled with that POI's name. Close the modal without saving, then remove the test div: `div.remove()`.

- [ ] **Step 7: Commit**

```bash
git add public/js/recommendations.js public/index.html public/locales/en.json public/locales/es.json public/css/styles.css
git commit -s -m "feat: add shared recommendations panel component"
```

---

## Task 4: `map.js` — Places pin layer + filter chip

**Files:**
- Modify: `public/js/map.js` (multiple locations, see steps)
- Modify: `public/css/styles.css` (place swatch color)
- Modify: `public/locales/en.json`, `public/locales/es.json` (`map.legendPlace`)

**Interfaces:**
- Consumes: `tripData.calendar` entries with `lat`/`lon` (populated via Task 2/3's add-activity flow).
- Produces: nothing new consumed by later tasks — this is the last map-touching task in this plan.

- [ ] **Step 1: i18n**

In `public/locales/en.json`, find:
```json
  "map.legendStay": "Stays",
```
Change to:
```json
  "map.legendStay": "Stays",
  "map.legendPlace": "Places",
```

In `public/locales/es.json`, find:
```json
  "map.legendStay": "Estadías",
```
Change to:
```json
  "map.legendStay": "Estadías",
  "map.legendPlace": "Lugares",
```

- [ ] **Step 2: CSS for the place swatch**

In `public/css/styles.css`, find:
```css
.map-filter-swatch-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
```
Change to:
```css
.map-filter-swatch-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
.map-filter-swatch-dot--place { background: var(--c-activity); }
```

- [ ] **Step 3: Update module state and `renderMap` signature**

In `public/js/map.js`, find:
```js
let _map = null;
let _lastFlights = null;
let _lastTrains  = null;
let _lastAccommodations = null;
let _lastAirports = null;

// Type + leg filters — both start fully on; toggled via the chip bar
// built into #map-filters. See docs/superpowers/specs/
// 2026-07-02-map-filters-and-data-driven-airports-design.md.
const _filters = {
  types: { flight: true, train: true, stay: true },
  legs:  { outbound: true, europe: true, return: true },
};

function renderMap(flights, trains, accommodations, airports) {
  _lastFlights = flights;
  _lastTrains  = trains;
  _lastAccommodations = accommodations;
  _lastAirports = airports;
  _buildMap(flights, trains, accommodations, airports);
}
```
Change to:
```js
let _map = null;
let _lastFlights = null;
let _lastTrains  = null;
let _lastAccommodations = null;
let _lastAirports = null;
let _lastCalendar = null;

// Type + leg filters — both start fully on; toggled via the chip bar
// built into #map-filters. See docs/superpowers/specs/
// 2026-07-02-map-filters-and-data-driven-airports-design.md and
// 2026-07-02-attraction-recommendations-design.md (the "place" type).
const _filters = {
  types: { flight: true, train: true, stay: true, place: true },
  legs:  { outbound: true, europe: true, return: true },
};

function renderMap(flights, trains, accommodations, airports, calendarEntries) {
  _lastFlights = flights;
  _lastTrains  = trains;
  _lastAccommodations = accommodations;
  _lastAirports = airports;
  _lastCalendar = calendarEntries;
  _buildMap(flights, trains, accommodations, airports, calendarEntries);
}
```

- [ ] **Step 4: Add the 'place' pin icon variant**

Find:
```js
function _pinIcon(type) {
  const bg   = type === 'flight'
    ? _cssVar('--accent', '#d49258')
    : _cssVar('--c-train', '#5fa88e');
  const glyph = type === 'flight' ? '✈' : '⊛';
  return L.divIcon({
```
Change to:
```js
function _pinIcon(type) {
  const bg = type === 'flight' ? _cssVar('--accent', '#d49258')
    : type === 'train' ? _cssVar('--c-train', '#5fa88e')
    : _cssVar('--c-activity', '#d8b47a');
  const glyph = type === 'flight' ? '✈' : type === 'train' ? '⊛' : '★';
  return L.divIcon({
```

- [ ] **Step 5: Add the Places chip to the filter bar**

Find:
```js
  typeRow.appendChild(_chip('type', 'stay', _filters.types,
    `<span class="map-filter-swatch-dot"></span><span>${t('map.legendStay')}</span>`));

  const legRow = document.createElement('div');
```
Change to:
```js
  typeRow.appendChild(_chip('type', 'stay', _filters.types,
    `<span class="map-filter-swatch-dot"></span><span>${t('map.legendStay')}</span>`));
  typeRow.appendChild(_chip('type', 'place', _filters.types,
    `<span class="map-filter-swatch-dot map-filter-swatch-dot--place"></span><span>${t('map.legendPlace')}</span>`));

  const legRow = document.createElement('div');
```

- [ ] **Step 6: Update the filter click handler and theme-toggle listener to pass calendar data**

Find:
```js
  el.querySelectorAll('.map-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.kind === 'type' ? _filters.types : _filters.legs;
      group[btn.dataset.value] = !group[btn.dataset.value];
      _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports);
    });
  });
```
Change to:
```js
  el.querySelectorAll('.map-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.kind === 'type' ? _filters.types : _filters.legs;
      group[btn.dataset.value] = !group[btn.dataset.value];
      _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports, _lastCalendar);
    });
  });
```

Find (near the bottom of the file):
```js
document.getElementById('theme-toggle').addEventListener('click', () => {
  if (_lastFlights || _lastTrains) {
    requestAnimationFrame(() => _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports));
  }
});
```
Change to:
```js
document.getElementById('theme-toggle').addEventListener('click', () => {
  if (_lastFlights || _lastTrains) {
    requestAnimationFrame(() => _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports, _lastCalendar));
  }
});
```

- [ ] **Step 7: Update `_buildMap`'s signature and add the place-pin loop**

Find:
```js
function _buildMap(flights, trains, accommodations, airports) {
```
Change to:
```js
function _buildMap(flights, trains, accommodations, airports, calendarEntries) {
```

Find:
```js
  // Fit to European portion — South America would shrink the view to world scale
  const euCoords = allCoords.filter(([lat]) => lat > 35);
```
Change to:
```js
  // ── Place pins (scheduled activities that carry coordinates) ──
  if (_filters.types.place) {
    for (const entry of (calendarEntries || [])) {
      if (entry.lat == null || entry.lon == null) continue;
      if (!_filters.legs[_legFor(entry.date, windows)]) continue;

      L.marker([entry.lat, entry.lon], { icon: _pinIcon('place') })
        .addTo(_map)
        .bindPopup(L.popup({ className: 'map-popup', minWidth: 160 }).setContent(`
          <div class="map-popup-city">${entry.title}</div>
          <div class="map-popup-sub">${entry.date}</div>
        `));
      allCoords.push([entry.lat, entry.lon]);
    }
  }

  // Fit to European portion — South America would shrink the view to world scale
  const euCoords = allCoords.filter(([lat]) => lat > 35);
```

- [ ] **Step 8: Syntax check**

Run: `node --check public/js/map.js`
Expected: no output, exit code 0.

- [ ] **Step 9: Manual verification**

This depends on having at least one calendar entry with `lat`/`lon` — reuse the Task 2 verification flow: open the app, run
```js
openAddModal('2026-09-26', { title: 'Test POI', address: '', lat: 48.2082, lon: 16.3738 });
```
in the console, save it. Scroll to the map section. Expected: a new "Places" chip appears in the filter bar (alongside Flights/Trains/Stays), active by default, and a star-icon pin renders at the Vienna coordinates. Click the "Places" chip to toggle it off — the pin disappears; click again — it reappears. Click the pin — popup shows "Test POI" and the date.

Delete the test activity afterward (via the modal's Delete button, reachable by clicking the pin's corresponding day-card chip, or re-adding via `openEditModal` if you noted its id) so it doesn't pollute trip data.

- [ ] **Step 10: Commit**

```bash
git add public/js/map.js public/css/styles.css public/locales/en.json public/locales/es.json
git commit -s -m "feat: add Places pin layer to the map"
```

---

## Task 5: `today.js` — recommendations section in the Today view

**Files:**
- Modify: `public/js/today.js`

**Interfaces:**
- Consumes: `renderRecommendations(container, stayId, defaultDate)` (Task 3), `t('recommendations.seeLink')` (Task 3).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add the recommendations section to the rendered HTML**

In `public/js/today.js`, find:
```js
      ${acts.length ? `
      <div class="today-block">
        <h3 class="today-block-title">${t('today.activities')}</h3>
        ${acts.map(actRow).join('')}
      </div>` : ''}
      ${budgetLine ? `<button type="button" class="today-budget" id="today-budget">💶 ${budgetLine}</button>` : ''}
```
Change to:
```js
      ${acts.length ? `
      <div class="today-block">
        <h3 class="today-block-title">${t('today.activities')}</h3>
        ${acts.map(actRow).join('')}
      </div>` : ''}
      ${imageStay ? `
      <div class="today-block">
        <button type="button" class="today-recs-toggle" id="today-recs-toggle">${t('recommendations.seeLink')}</button>
        <div class="today-recs-panel" id="today-recs-panel" hidden></div>
      </div>` : ''}
      ${budgetLine ? `<button type="button" class="today-budget" id="today-budget">💶 ${budgetLine}</button>` : ''}
```

Note: `imageStay` is already computed earlier in `renderToday()` (`const imageStay = stay || (data.accommodations || []).find(a => a.check_out === today);`) — reused here rather than introducing a new variable, since it's exactly "the stay to scope this day to," including the checkout-day fallback.

- [ ] **Step 2: Wire the toggle**

Find:
```js
  section.querySelector('#today-dev-prev')?.addEventListener('click', () => goToDevDay(-1));
  section.querySelector('#today-dev-next')?.addEventListener('click', () => goToDevDay(1));
}
```
Change to:
```js
  section.querySelector('#today-dev-prev')?.addEventListener('click', () => goToDevDay(-1));
  section.querySelector('#today-dev-next')?.addEventListener('click', () => goToDevDay(1));

  const recsToggle = section.querySelector('#today-recs-toggle');
  const recsPanel  = section.querySelector('#today-recs-panel');
  recsToggle?.addEventListener('click', () => {
    const opening = recsPanel.hidden;
    recsPanel.hidden = !opening;
    if (opening && !recsPanel.dataset.loaded) {
      recsPanel.dataset.loaded = '1';
      renderRecommendations(recsPanel, imageStay.id, today);
    }
  });
}
```

- [ ] **Step 3: CSS for the toggle button**

In `public/css/styles.css`, find:
```css
.today-budget:hover { color: var(--today-fg-1, var(--text-1)); border-color: var(--today-fg-3, var(--text-3)); }
```
Change to:
```css
.today-budget:hover { color: var(--today-fg-1, var(--text-1)); border-color: var(--today-fg-3, var(--text-3)); }

.today-recs-toggle {
  display: inline-block;
  margin-top: 1.25rem;
  font: inherit;
  font-size: 0.85rem;
  color: var(--today-fg-2, var(--text-2));
  background: var(--today-budget-bg, none);
  border: 1px solid var(--today-budget-border, var(--border));
  border-radius: var(--radius);
  padding: 0.45rem 0.75rem;
  cursor: pointer;
}
.today-section.has-image .today-recs-toggle {
  --today-budget-bg: rgba(10,8,6,0.4);
  --today-budget-border: rgba(251,246,239,0.35);
}
.today-recs-toggle:hover { color: var(--today-fg-1, var(--text-1)); border-color: var(--today-fg-3, var(--text-3)); }
.today-recs-panel { margin-top: 0.5rem; }
```

- [ ] **Step 4: Syntax check**

Run: `node --check public/js/today.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Manual verification**

Start the server, open `http://localhost:3099/?today=2026-09-26` (a day inside the Vienna stay). Expected: the Today view hero shows Vienna, and below the activities block a "See recommendations" button appears. Click it — a loading gap, then Vienna POI cards appear (same list as Task 3's console test). Click "Add" on one — the modal opens pre-filled, with the date defaulted to 2026-09-26. Close without saving.

Also check a checkout-only day if one exists in this trip (per the design doc, the final day — `?today=2026-10-29`) — confirm the button still appears (using the departing stay's recommendations, not a crash).

- [ ] **Step 6: Commit**

```bash
git add public/js/today.js public/css/styles.css
git commit -s -m "feat: surface recommendations in the Today view"
```

---

## Task 6: `app.js` — recommendations button in the day-card expand view

**Files:**
- Modify: `public/js/app.js:266-289` (`toggleCardExpand`)
- Modify: `public/css/styles.css` (day-card panel variant)

**Interfaces:**
- Consumes: `renderRecommendations` (Task 3), `t('recommendations.seeLink')` (Task 3), `getActiveStay()` (already defined in `app.js`).
- Produces: nothing consumed elsewhere — last task in this plan.

- [ ] **Step 1: Extend `toggleCardExpand`**

Find:
```js
function toggleCardExpand(card, expand) {
  const chipsEl = card.querySelector('.day-chips');
  const chips = chipsByDate[card.dataset.date] || [];
  let addBtn = card.querySelector('.day-add-btn');

  if (expand) {
    card.classList.add('expanded');
    renderChips(chipsEl, chips, Infinity);
    if (!addBtn) {
      addBtn = document.createElement('button');
      addBtn.className = 'day-add-btn';
      addBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg> ${t('card.addEvent')}`;
      addBtn.addEventListener('click', e => {
        e.stopPropagation();
        openAddModal(card.dataset.date);
      });
      card.appendChild(addBtn);
    }
  } else {
    card.classList.remove('expanded');
    renderChips(chipsEl, chips, CHIPS_MAX);
    if (addBtn) addBtn.remove();
  }
}
```
Replace with:
```js
function toggleCardExpand(card, expand) {
  const chipsEl = card.querySelector('.day-chips');
  const chips = chipsByDate[card.dataset.date] || [];
  let addBtn    = card.querySelector('.day-add-btn');
  let recsBtn   = card.querySelector('.day-recs-btn');
  let recsPanel = card.querySelector('.day-recs-panel');

  if (expand) {
    card.classList.add('expanded');
    renderChips(chipsEl, chips, Infinity);
    if (!addBtn) {
      addBtn = document.createElement('button');
      addBtn.className = 'day-add-btn';
      addBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg> ${t('card.addEvent')}`;
      addBtn.addEventListener('click', e => {
        e.stopPropagation();
        openAddModal(card.dataset.date);
      });
      card.appendChild(addBtn);
    }
    const stay = getActiveStay(tripData.accommodations, card.dataset.date);
    if (stay && !recsBtn) {
      recsBtn = document.createElement('button');
      recsBtn.className = 'day-add-btn day-recs-btn';
      recsBtn.textContent = t('recommendations.seeLink');
      recsBtn.addEventListener('click', e => {
        e.stopPropagation();
        let panel = card.querySelector('.day-recs-panel');
        if (panel) { panel.hidden = !panel.hidden; return; }
        panel = document.createElement('div');
        panel.className = 'day-recs-panel';
        card.appendChild(panel);
        renderRecommendations(panel, stay.id, card.dataset.date);
      });
      card.appendChild(recsBtn);
    }
  } else {
    card.classList.remove('expanded');
    renderChips(chipsEl, chips, CHIPS_MAX);
    if (addBtn) addBtn.remove();
    if (recsBtn) recsBtn.remove();
    if (recsPanel) recsPanel.remove();
  }
}
```

- [ ] **Step 2: CSS for the day-card panel variant**

In `public/css/styles.css`, find the `.rec-panel` rule added in Task 3:
```css
.rec-panel {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.5rem;
}
```
Change to:
```css
.rec-panel,
.day-recs-panel {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.5rem;
}
```

(The `.day-recs-panel` element itself gets the `rec-panel`-equivalent layout without needing `renderRecommendations` to know which class name it was given — it's the *caller* in Task 6 that named the container `day-recs-panel` instead of adding the `rec-panel` class; `renderRecommendations` in Task 3 does `container.classList.add('rec-panel')` on whatever container it's given, so `.day-recs-panel` will actually already have `rec-panel` added dynamically too. This CSS step still ensures `.day-recs-panel` looks right even before JS runs, avoiding a layout flash.)

- [ ] **Step 3: Syntax check**

Run: `node --check public/js/app.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual verification**

Start the server, open the app, click a day card that falls within a stay (e.g. Sept 26, Vienna) to expand it. Expected: alongside the existing "+ Add event" button, a "See recommendations" button appears. Click it — Vienna POI cards render inline within the card. Click "Add" on one — modal opens pre-filled, date defaulted to that day. Close without saving. Click the day card again to collapse it — confirm the recommendations button and panel are removed (not just hidden) along with the add button, matching existing collapse behavior.

Also click a day card that has **no** active stay (a gap day, or a day outside the trip's stay coverage, if any exist) and confirm no "See recommendations" button appears — only "+ Add event".

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js public/css/styles.css
git commit -s -m "feat: add recommendations button to day-card expand view"
```

---

## Final check

After all 6 tasks: run `node --check` on every modified `.js` file one more time, and do one full manual pass — load the app fresh (no console tricks this time), navigate to a day inside a stay via the planner, open recommendations from both the Today view and the day-card, add one real recommendation to the calendar, confirm it shows up as a "Places" pin on the map, toggle the Places filter chip to confirm it hides/shows, then delete the test activity to leave the trip data clean.
