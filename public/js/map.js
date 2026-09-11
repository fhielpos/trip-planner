/* =============================================
   Trip Route Map — Leaflet + CartoDB
   ============================================= */

let _map = null;
let _lastFlights = null;
let _lastTrains  = null;
let _lastAccommodations = null;
let _lastAirports = null;
let _lastCalendar = null;
let _lastAllCoords = [];

// Place-pin markers from the last build, keyed by calendar-entry id —
// lets showEventOnMap() re-open the popup for an event the user jumped to.
let _placeMarkers = {};

// Geocoded AI suggestions for the "AI ideas" layer. Fetched once per page
// load from /api/ai-suggestions/pins; a non-empty `pending` schedules one
// retry so late-resolved coordinates still land on the map. `_aiPinsGen`
// is bumped by invalidateAiPins() so an in-flight fetch from before the
// invalidation is discarded instead of overwriting fresh data.
let _aiPins = null;
let _aiPinsFetching = false;
let _aiPinsRetry = false;
let _aiPinsGen = 0;

// The map is built once at page load, while the Mapa tab (and its
// #trip-map container) may still be display:none behind the default
// Today tab — Leaflet computes tile layout and fitBounds() math from the
// container's size at call time, so a fit done against a zero-size
// hidden container never corrects itself once the tab becomes visible.
// mobile-nav.js's setMobileTab() calls this after switching to 'map' so
// Leaflet re-measures the now-visible container and re-fits the route.
function refreshMapView() {
  if (!_map) return;
  _map.invalidateSize();
  _applyFitView(_lastAllCoords);
}

// Fits the map to the full route — same logic used on initial render and by
// the reset-view control, so a pin click's zoom-in can always be undone.
function _applyFitView(coords) {
  const euCoords = coords.filter(([lat]) => lat > 35);
  const fitCoords = euCoords.length ? euCoords : coords;
  if (fitCoords.length >= 2) {
    _map.fitBounds(L.latLngBounds(fitCoords).pad(0.25));
  } else if (fitCoords.length === 1) {
    _map.setView(fitCoords[0], 11);
  } else {
    _map.setView([46, 10], 4); // everything filtered out — default Europe view rather than a broken map
  }
}

// Guarded so map.js still evaluates (filter bar, stays timeline, inline
// itinerary) when Leaflet failed to load — offline install or blocked CDN.
const _ResetViewControl = typeof L !== 'undefined' && L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const link = L.DomUtil.create('a', 'map-reset-control', container);
    link.href = '#';
    link.title = t('map.resetView');
    link.setAttribute('aria-label', t('map.resetView'));
    link.innerHTML = '⤢';
    L.DomEvent.on(link, 'click', L.DomEvent.stop);
    L.DomEvent.on(link, 'click', () => _applyFitView(_lastAllCoords));
    return container;
  },
});

const _TodayControl = typeof L !== 'undefined' && L.Control.extend({
  options: { position: 'bottomleft' },
  initialize(target) {
    this._target = target;
  },
  onAdd() {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control map-today-control');
    const link = L.DomUtil.create('a', 'map-today-control-link', container);
    link.href = '#';
    link.title = t('map.jumpToday');
    link.setAttribute('aria-label', t('map.jumpToday'));
    link.innerHTML = `<span class="map-today-control-icon">📍</span><span>${t('map.jumpToday')}</span>`;
    L.DomEvent.on(link, 'click', L.DomEvent.stop);
    L.DomEvent.on(link, 'click', () => this._map.flyTo(this._target, PIN_CLICK_ZOOM));
    return container;
  },
});

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Type + leg filters — both start fully on; toggled via the chip bar
// built into #map-filters. See docs/superpowers/specs/
// 2026-07-02-map-filters-and-data-driven-airports-design.md and
// 2026-07-02-attraction-recommendations-design.md (the "place" type).
const _filters = {
  types: { flight: true, train: true, stay: true, place: true, ai: true },
  legs:  { outbound: true, europe: true, return: true },
};

function _aiSuggestionsEnabled() {
  return Boolean(typeof tripData !== 'undefined' && tripData && tripData.config
    && tripData.config.aiSuggestionsEnabled);
}

// Fetch the pinned AI suggestions once, then rebuild the map so the pins
// appear. If the server still has an address to resolve (`pending`), take
// one more pass a few seconds later.
function _ensureAiPins() {
  if (_aiPins !== null || _aiPinsFetching || !_aiSuggestionsEnabled()) return;
  _aiPinsFetching = true;
  const gen = _aiPinsGen;
  const stale = () => gen !== _aiPinsGen; // invalidateAiPins() ran while we waited
  fetch('/api/ai-suggestions/pins')
    .then(r => (r.ok ? r.json() : { pins: [], pending: 0 }))
    .then(data => {
      if (stale()) return;
      _aiPins = Array.isArray(data.pins) ? data.pins : [];
      if (data.pending && !_aiPinsRetry) {
        _aiPinsRetry = true;
        setTimeout(() => { if (!stale()) { _aiPins = null; _ensureAiPins(); } }, 8000);
      }
      _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports, _lastCalendar);
    })
    .catch(() => { if (!stale()) _aiPins = []; })
    .finally(() => { if (!stale()) _aiPinsFetching = false; });
}

// Drop the cached pin set and re-fetch — called after a suggestion is
// pinned/unpinned or committed to the itinerary, so the layer stays in
// step without a page reload. Bumping the generation makes any in-flight
// fetch a no-op on completion.
function invalidateAiPins() {
  _aiPinsGen++;
  _aiPins = null;
  _aiPinsFetching = false;
  _aiPinsRetry = false;
  if (_map && _filters.types.ai && _aiSuggestionsEnabled()) _ensureAiPins();
}

// "Remove from map" from an AI pin's popup.
function _removeAiPin(pin) {
  fetch('/api/ai-suggestions/pins', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: pin.date, name: pin.name }),
  })
    .then(r => (r.ok ? r.json() : null))
    .then(body => {
      if (body && Array.isArray(body.pinned) && typeof _aiEntry === 'function') {
        const set = _aiEntry(pin.date).pinned;
        if (set) { set.clear(); body.pinned.forEach(n => set.add(String(n).toLowerCase())); }
      }
    })
    .finally(() => {
      invalidateAiPins();
      if (typeof refreshOpenAiPanels === 'function') refreshOpenAiPanels();
    });
}

// Jump the map to an event's location and open its popup. Switches to the
// Mapa tab first on mobile; scrolls the map into view on desktop.
function showEventOnMap(entry) {
  const lat = Number(entry && entry.lat);
  const lon = Number(entry && entry.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  // The popup lives on the Places layer — make sure it's on so the marker
  // for this entry actually exists before we try to open it.
  if (!_filters.types.place) {
    _filters.types.place = true;
    if (_map) _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports, _lastCalendar);
  }

  const go = () => {
    if (!_map) return;
    _map.invalidateSize();
    _map.flyTo([lat, lon], PIN_CLICK_ZOOM);
    const marker = entry && entry.id ? _placeMarkers[entry.id] : null;
    if (marker) setTimeout(() => marker.openPopup(), 380);
  };

  if (typeof isMobileViewport === 'function' && isMobileViewport() && typeof setMobileTab === 'function') {
    if (typeof closeSheet === 'function') closeSheet();
    setMobileTab('map');
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 160);
  } else {
    document.querySelector('.map-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    go();
  }
}

function renderMap(flights, trains, accommodations, airports, calendarEntries) {
  _lastFlights = flights;
  _lastTrains  = trains;
  _lastAccommodations = accommodations;
  _lastAirports = airports;
  _lastCalendar = calendarEntries;
  _buildMap(flights, trains, accommodations, airports, calendarEntries);
}

// TODO(redesign): 4a calls for an offline base (self-hosted vector land/sea
// for the trip bbox, or install-time-cached raster tiles) so the map works
// in plane mode. Out of scope for this slice — CARTO dark_all/light_all
// still themes correctly, so it stays until the offline-base infra lands.
//
// CARTO now requires an API key (unauthenticated tiles still load but come
// back watermarked "API KEY REQUIRED") — appended as `?key=` when the
// server has one configured (CARTO_API_KEY, surfaced via /api/config).
// Unset, tiles fall back to the same watermarked-but-functional behavior.
function _tileUrl() {
  const theme = document.documentElement.getAttribute('data-theme');
  const isDark = theme !== 'light' && theme !== 'terracotta';
  const style = isDark ? 'dark_all' : 'light_all';
  const key = typeof tripData !== 'undefined' && tripData?.config?.cartoApiKey;
  const suffix = key ? `?key=${encodeURIComponent(key)}` : '';
  return `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png${suffix}`;
}

function _cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// Quadratic bezier sampled at n+1 points, given an explicit control point.
function _bezierPoints(lat1, lon1, ctrlLat, ctrlLon, lat2, lon2, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([
      u * u * lat1 + 2 * u * t * ctrlLat + t * t * lat2,
      u * u * lon1 + 2 * u * t * ctrlLon + t * t * lon2,
    ]);
  }
  return pts;
}

// High arc for long-haul flights on a Mercator map
function _curvedPoints(lat1, lon1, lat2, lon2, n, curveDown = false) {
  const dLon = lon2 - lon1;
  const dLat = lat2 - lat1;
  const sign = curveDown ? -1 : 1;
  const ctrlLat = (lat1 + lat2) / 2 + sign * (Math.abs(dLon) * 0.45 + Math.abs(dLat) * 0.18);
  const ctrlLon = (lon1 + lon2) / 2;
  return _bezierPoints(lat1, lon1, ctrlLat, ctrlLon, lat2, lon2, n);
}

// Zoom level a pin click flies to — close enough to see streets
const PIN_CLICK_ZOOM = 13;

// Gentle arc for trains — much less curvature than flights
function _trainPoints(lat1, lon1, lat2, lon2, n) {
  const dist = Math.abs(lat2 - lat1) + Math.abs(lon2 - lon1);
  const ctrlLat = (lat1 + lat2) / 2 + dist * 0.06;
  const ctrlLon = (lon1 + lon2) / 2;
  return _bezierPoints(lat1, lon1, ctrlLat, ctrlLon, lat2, lon2, n);
}

function _pinIcon(type, colorOverride, isPast) {
  const bg = colorOverride || (type === 'flight' ? _cssVar('--accent', '#d49258')
    : type === 'train' ? _cssVar('--c-train', '#5fa88e')
    : type === 'ai' ? _cssVar('--accent', '#d49258')
    : _cssVar('--c-activity', '#d8b47a'));
  const glyph = type === 'flight' ? '✈️' : type === 'train' ? '🚆' : type === 'stay' ? '🛏️'
    : type === 'ai' ? '✦' : '📍';
  const pastClass = isPast ? ' map-pin--past' : '';
  return L.divIcon({
    className: '',
    html: `<div class="map-pin-zoom"><div class="map-pin map-pin--${type}${pastClass}" style="background:${bg}">${glyph}</div></div>`,
    iconSize:    [30, 30],
    iconAnchor:  [15, 33],
    popupAnchor: [0, -34],
  });
}

function _applyPinScale() {
  if (!_map) return;
  const pane = _map.getPane('markerPane');
  if (!pane) return;
  const zoom = _map.getZoom();
  pane.classList.toggle('map-pins--compact', zoom < 6);
  pane.classList.toggle('map-pins--large', zoom > 10);
}

// Route lines crisscross the whole route at the overview zoom, which is the
// point — but once you've flown into a single city (same threshold as the
// pin scale-up above) they just cut across the streets you're looking at,
// so hide them until you zoom back out.
function _applyLineVisibility() {
  if (!_map) return;
  const pane = _map.getPane('overlayPane');
  if (!pane) return;
  pane.classList.toggle('map-lines--hidden', _map.getZoom() > 10);
}

// ── Leg derivation ──────────────────────────────
// Flights already carry `direction` (outbound/return/connection), computed
// server-side from home airports + trip midpoint. From the outbound/return
// flights we derive two date boundaries; trains and stays are classified
// by comparing their own date against those boundaries — no new field
// needed anywhere, and "connection" flights fold into the Europe leg.

function _legWindows(flights) {
  const outboundArrivals = flights.filter(f => f.direction === 'outbound').map(f => f.arrivalDate).sort();
  const returnDepartures = flights.filter(f => f.direction === 'return').map(f => f.departureDate).sort();
  return {
    outboundEnd: outboundArrivals.length ? outboundArrivals[outboundArrivals.length - 1] : null,
    returnStart: returnDepartures.length ? returnDepartures[0] : null,
  };
}

function _legFor(dateStr, windows) {
  if (windows.outboundEnd && dateStr <= windows.outboundEnd) return 'outbound';
  if (windows.returnStart && dateStr >= windows.returnStart) return 'return';
  return 'europe';
}

function _flightLeg(f) {
  return f.direction === 'outbound' ? 'outbound' : f.direction === 'return' ? 'return' : 'europe';
}

// code → "City (CODE)", derived from the flight data itself rather than
// the airports API (which only supplies coordinates — see design doc).
function _airportLabels(flights) {
  const labels = {};
  for (const f of flights) {
    if (!labels[f.from]) labels[f.from] = `${f.fromCity} (${f.from})`;
    if (!labels[f.to])   labels[f.to]   = `${f.toCity} (${f.to})`;
  }
  return labels;
}

// Stays with a successfully-geocoded address each get their own individual
// marker at the exact position. Stays sharing area-level coordinates
// (repeat visits to the same city, or no/failed address) still render as
// one circle marker listing every visit, rather than stacked duplicates.
function _groupStaysByCoord(accommodations) {
  const exact = [];
  const groups = {};
  for (const a of accommodations) {
    if (a.geocode_status === 'ok' && a.exact_lat != null && a.exact_lon != null) {
      exact.push({ lat: a.exact_lat, lon: a.exact_lon, color: a.color, stays: [a], isExact: true });
      continue;
    }
    if (a.lat == null || a.lon == null) continue;
    const key = `${a.lat},${a.lon}`;
    if (!groups[key]) groups[key] = { lat: a.lat, lon: a.lon, color: a.color, stays: [], isExact: false };
    groups[key].stays.push(a);
  }
  return [...exact, ...Object.values(groups)];
}

// ── Stay clustering + circle markers (4a) ──────
// No marker-cluster library is vendored and adding one needs npm/CDN, so
// nearby stays are grouped by a fixed lat/lon distance threshold instead —
// enough to fold the Paris and Alpine repeat-visit piles into one circle
// while keeping distinct cities apart.
const _CLUSTER_THRESHOLD_DEG = 1.15;

function _clusterStayGroups(groups) {
  const clusters = [];
  for (const g of groups) {
    let host = clusters.find(c =>
      Math.abs(c.lat - g.lat) < _CLUSTER_THRESHOLD_DEG &&
      Math.abs(c.lon - g.lon) < _CLUSTER_THRESHOLD_DEG);
    if (!host) { host = { members: [], _latSum: 0, _lonSum: 0, lat: g.lat, lon: g.lon }; clusters.push(host); }
    host.members.push(g);
    host._latSum += g.lat; host._lonSum += g.lon;
    host.lat = host._latSum / host.members.length;
    host.lon = host._lonSum / host.members.length;
  }
  return clusters;
}

function _stayNights(stays) {
  return stays.reduce((sum, s) =>
    sum + Math.round((parseLocal(s.check_out) - parseLocal(s.check_in)) / 86400000), 0);
}

// 20–32px, scaled by nights; current stay pinned at 32px + glow.
function _stayCircleIcon(nights, isCurrent, isPast) {
  const size = isCurrent ? 32 : Math.max(20, Math.min(32, Math.round(18 + nights * 1.7)));
  const cls = 'map-stay-circle'
    + (isCurrent ? ' map-stay-circle--current' : '')
    + (isPast ? ' map-stay-circle--past' : '');
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" style="width:${size}px;height:${size}px"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// Pick the most relevant visit from a coordinate group (repeat visits share
// one marker): the one covering today, else the next upcoming, else the last.
function _pickStay(group, today) {
  const sorted = [...group.stays].sort((a, b) => a.check_in.localeCompare(b.check_in));
  return sorted.find(s => s.check_in <= today && s.check_out > today)
      || sorted.find(s => s.check_in >= today)
      || sorted[sorted.length - 1];
}

function _openStayFromGroup(group, accommodations) {
  if (typeof openStaySheet !== 'function') return;
  openStaySheet(_pickStay(group, appToday()), accommodations);
}

// Bottom sheet shown on a stay pin (or stays-timeline segment) tap.
function openStaySheet(stay, accommodations) {
  const sheet = document.getElementById('day-sheet');
  const backdrop = document.getElementById('day-sheet-backdrop');
  const body = document.getElementById('day-sheet-body');
  if (!sheet || !backdrop || !body || !stay) return;

  const all = [...(accommodations || _lastAccommodations || [])]
    .sort((a, b) => a.check_in.localeCompare(b.check_in));
  const idx = all.findIndex(s => s.id === stay.id);
  const total = all.length;
  const today = appToday();
  const nights = Math.round((parseLocal(stay.check_out) - parseLocal(stay.check_in)) / 86400000);
  const isCurrent = stay.check_in <= today && stay.check_out > today;
  const range = `${fmtDate(stay.check_in, { year: false })} – ${fmtDate(stay.check_out, { year: false })}`;
  const places = (_lastCalendar || []).filter(e =>
    e.type !== 'accommodation' && e.date >= stay.check_in && e.date < stay.check_out).length;
  const flag = typeof countryFlag === 'function' ? countryFlag(stay.country) : '';

  const metaLine = `${range} · ${t('map.nightsCount', { n: nights })}`
    + (idx >= 0 ? ` · ${t('map.stayIndex', { i: idx + 1, total })}` : '');

  sheet.classList.remove('sheet--day');
  sheet.classList.add('sheet--stay');
  const titleEl = document.getElementById('day-sheet-title');
  if (titleEl) titleEl.textContent = stay.city;

  body.innerHTML = `
    <div class="mmap-staysheet">
      <div class="mmap-staysheet-head">
        <span class="mmap-staysheet-circle">${flag}</span>
        <span class="mmap-staysheet-city">${_escHtml(stay.city)}</span>
        ${isCurrent ? `<span class="mmap-staysheet-here label">${t('map.staySheetHere')}</span>` : ''}
      </div>
      <div class="mmap-staysheet-meta mono">${metaLine}</div>
      <div class="mmap-staysheet-actions">
        <button type="button" class="label mmap-staysheet-act" data-stay-day>${t('map.staySheetDay')} ›</button>
        <button type="button" class="label mmap-staysheet-act" data-stay-places>${t('map.staySheetPlaces', { n: places })} ›</button>
        <a class="label mmap-staysheet-act" href="/journey.html" data-stay-route>${t('map.staySheetRoute')} ›</a>
      </div>
    </div>`;

  const close = () => {
    sheet.hidden = true; backdrop.hidden = true;
    sheet.classList.remove('sheet--stay');
  };
  body.querySelector('[data-stay-day]')?.addEventListener('click', () => {
    close();
    if (typeof openDaySheet === 'function' && typeof tripData !== 'undefined') openDaySheet(stay.check_in, tripData);
    else if (typeof setMobileTab === 'function') setMobileTab('calendar');
  });
  body.querySelector('[data-stay-places]')?.addEventListener('click', () => {
    close();
    if (typeof setMobileTab === 'function') setMobileTab('calendar');
  });

  backdrop.hidden = false;
  sheet.hidden = false;
}

// ── Filter bar ──────────────────────────────────

function _chip(kind, value, activeMap, contentHtml) {
  const active = activeMap[value];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `map-filter-chip${active ? ' active' : ''}`;
  btn.dataset.kind = kind;
  btn.dataset.value = value;
  btn.innerHTML = contentHtml;
  return btn;
}

function _buildFilterBar() {
  const el = document.getElementById('map-filters');
  if (!el) return;
  el.innerHTML = '';

  const typeRow = document.createElement('div');
  typeRow.className = 'map-filter-row';
  typeRow.appendChild(_chip('type', 'flight', _filters.types,
    `<span class="map-filter-swatch-line map-filter-swatch-line--flight"></span><span>${t('map.legendFlight')}</span>`));
  typeRow.appendChild(_chip('type', 'train', _filters.types,
    `<span class="map-filter-swatch-line map-filter-swatch-line--train"></span><span>${t('map.legendTrain')}</span>`));
  typeRow.appendChild(_chip('type', 'stay', _filters.types,
    `<span class="map-filter-swatch-dot"></span><span>${t('map.legendStay')}</span>`));
  typeRow.appendChild(_chip('type', 'place', _filters.types,
    `<span class="map-filter-swatch-dot map-filter-swatch-dot--place"></span><span>${t('map.legendPlace')}</span>`));
  if (_aiSuggestionsEnabled()) {
    typeRow.appendChild(_chip('type', 'ai', _filters.types,
      `<span class="map-filter-swatch-dot map-filter-swatch-dot--ai">✦</span><span>${t('map.legendAiIdeas')}</span>`));
  }

  const legRow = document.createElement('div');
  legRow.className = 'map-filter-row';
  legRow.appendChild(_chip('leg', 'outbound', _filters.legs, `<span>${t('map.legOutbound')}</span>`));
  legRow.appendChild(_chip('leg', 'europe', _filters.legs, `<span>${t('map.legEurope')}</span>`));
  legRow.appendChild(_chip('leg', 'return', _filters.legs, `<span>${t('map.legReturn')}</span>`));

  el.appendChild(typeRow);
  el.appendChild(legRow);

  el.querySelectorAll('.map-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.kind === 'type' ? _filters.types : _filters.legs;
      group[btn.dataset.value] = !group[btn.dataset.value];
      _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports, _lastCalendar);
    });
  });
}

function _buildMap(flights, trains, accommodations, airports, calendarEntries) {
  const container = document.getElementById('trip-map');
  if (!container) return;

  _buildFilterBar();
  if (isMobileViewport()) {
    _buildInlineItinerary(flights, trains);
    if (typeof renderStaysTimeline === 'function' && typeof tripData !== 'undefined') {
      renderStaysTimeline(tripData);
    }
    registerMobileRerender(() => _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports, _lastCalendar));
  } else {
    document.getElementById('mmap-itinerary').innerHTML = '';
  }

  // Leaflet is CDN-loaded; when it fails to load (offline install, blocked
  // network) the chrome above still renders — only the interactive canvas
  // below is skipped.
  if (typeof L === 'undefined') return;

  // Filter toggles (and the theme-toggle repaint) rebuild the whole map —
  // preserve whatever the user was already looking at instead of re-fitting
  // to the full route each time. Only a fresh render (no prior map) or the
  // reset-view control should move the view.
  const prevView = _map ? { center: _map.getCenter(), zoom: _map.getZoom() } : null;

  if (_map) { _map.remove(); _map = null; }

  _map = L.map('trip-map', { scrollWheelZoom: false, zoomControl: true });
  L.tileLayer(_tileUrl(), {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
  }).addTo(_map);
  new _ResetViewControl().addTo(_map);
  _map.on('zoomend', _applyPinScale);
  // 'zoom' (not just 'zoomend') so lines vanish mid-animation, the instant
  // the threshold is crossed — waiting for 'zoomend' let them stay visible
  // for the whole flyTo/zoom-button animation and only disappear at the end.
  _map.on('zoom zoomend', _applyLineVisibility);

  const today = appToday();
  const todayStay = getActiveStay(accommodations || [], today);
  if (todayStay) {
    const useExact = todayStay.geocode_status === 'ok' && todayStay.exact_lat != null && todayStay.exact_lon != null;
    const lat = useExact ? todayStay.exact_lat : todayStay.lat;
    const lon = useExact ? todayStay.exact_lon : todayStay.lon;
    if (lat != null && lon != null) {
      new _TodayControl([lat, lon]).addTo(_map);
    }
  }

  const accentColor = _cssVar('--accent', '#d49258');
  const trainColor  = _cssVar('--c-train', '#5fa88e');
  // Arc colours follow the legend swatches (tan flights / green trains),
  // one scheme across the whole map.
  const flightLineColor = _cssVar('--map-flight-line', '#d4a87c');
  const trainLineColor  = _cssVar('--map-train-line', '#86c9a4');
  const windows = _legWindows(flights || []);
  const labels  = _airportLabels(flights || []);

  const allCoords = [];   // for fitBounds

  // ── Stay markers ───────────────────────────────
  // Mobile Mapa tab (4a): clustered circles sized by nights, current stay
  // glowing, tap opens the stay sheet. Desktop keeps its labelled pin+popup.
  if (_filters.types.stay && !isMobileViewport()) {
    for (const group of _groupStaysByCoord(accommodations || [])) {
      const leg = _legFor(group.stays[0].check_in, windows);
      if (!_filters.legs[leg]) continue;

      const color = group.color || accentColor;
      const isPast = group.stays.every(s => s.check_out <= today);
      L.marker([group.lat, group.lon], { icon: _pinIcon('stay', color, isPast) })
        .addTo(_map)
        .on('click', () => _map.flyTo([group.lat, group.lon], PIN_CLICK_ZOOM))
        .bindPopup(L.popup({ className: 'map-popup', minWidth: 170 }).setContent(`
          <div class="map-popup-city">${group.stays[0].city}</div>
          ${group.isExact ? `<div class="map-popup-sub">${_escHtml(group.stays[0].address)}</div>` : ''}
          <div class="map-popup-sub">${group.stays.map(s => `${s.check_in} → ${s.check_out}`).join('<br>')}</div>
        `));
      allCoords.push([group.lat, group.lon]);
    }
  } else if (_filters.types.stay) {
    const visibleGroups = _groupStaysByCoord(accommodations || [])
      .filter(g => _filters.legs[_legFor(g.stays[0].check_in, windows)]);
    const activeStay = getActiveStay(accommodations || [], today);
    const isActiveGroup = g => activeStay && g.stays.some(s => s.id === activeStay.id);
    const current = visibleGroups.filter(isActiveGroup);
    const rest    = visibleGroups.filter(g => !isActiveGroup(g));

    for (const cluster of _clusterStayGroups(rest)) {
      const members = cluster.members;
      const stays = members.flatMap(m => m.stays);
      const isPast = stays.every(s => s.check_out <= today);
      allCoords.push(...members.map(m => [m.lat, m.lon]));

      if (members.length === 1) {
        const g = members[0];
        L.marker([g.lat, g.lon], { icon: _stayCircleIcon(_stayNights(g.stays), false, isPast) })
          .addTo(_map)
          .on('click', () => _openStayFromGroup(g, accommodations));
        continue;
      }

      const label = `${_escHtml(stays[0].city)} · ${t('map.clusterStays', { n: stays.length })}`;
      L.marker([cluster.lat, cluster.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div class="map-cluster${isPast ? ' map-cluster--past' : ''}">`
              + `<span class="map-cluster-count mono">${stays.length}</span>`
              + `<span class="map-cluster-label label mono">${label}</span></div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        }),
      }).addTo(_map).on('click', () =>
        _map.fitBounds(L.latLngBounds(members.map(m => [m.lat, m.lon])).pad(0.4)));
    }

    for (const g of current) {
      L.marker([g.lat, g.lon], { icon: _stayCircleIcon(_stayNights(g.stays), true, false) })
        .addTo(_map)
        .on('click', () => _openStayFromGroup(g, accommodations));
      allCoords.push([g.lat, g.lon]);
    }
  }

  // ── Flight routes ──────────────────────────────
  const airportFlights = {};  // code → [flight, …]
  if (_filters.types.flight) {
    for (const f of (flights || [])) {
      if (!_filters.legs[_flightLeg(f)]) continue;
      const dep = airports?.[f.from];
      const arr = airports?.[f.to];
      if (!dep || !arr) continue;

      const curveDown = f.to === 'ATH';
      const isPastFlight = f.departureDate < today;
      const restOpacity = isPastFlight ? 0.3 : 0.5;
      const hoverOpacity = isPastFlight ? 0.6 : 0.85;
      const flightLine = L.polyline(_curvedPoints(dep.lat, dep.lon, arr.lat, arr.lon, 60, curveDown), {
        color: flightLineColor,
        weight: 1.5,
        opacity: restOpacity,
        dashArray: '6 5',
        className: isPastFlight ? 'route-line--past' : '',
      }).addTo(_map);
      flightLine.on('mouseover', () => flightLine.setStyle({ opacity: hoverOpacity, weight: 2.5 }));
      flightLine.on('mouseout',  () => flightLine.setStyle({ opacity: restOpacity,  weight: 1.5 }));

      allCoords.push([dep.lat, dep.lon], [arr.lat, arr.lon]);
      for (const code of [f.from, f.to]) {
        if (!airportFlights[code]) airportFlights[code] = [];
        airportFlights[code].push(f);
      }
    }
  }

  // Flight pins — one per unique airport code
  for (const [code, flist] of Object.entries(airportFlights)) {
    const c = airports?.[code];
    if (!c) continue;
    const lines = flist.map(f => `${f.flightNumber} · ${f.from}→${f.to} · ${f.departureDate}`).join('<br>');
    const isPast = flist.every(f => f.departureDate < today);
    L.marker([c.lat, c.lon], { icon: _pinIcon('flight', null, isPast) })
      .addTo(_map)
      .on('click', () => _map.flyTo([c.lat, c.lon], PIN_CLICK_ZOOM))
      .bindPopup(L.popup({ className: 'map-popup', minWidth: 180 }).setContent(`
        <div class="map-popup-city">${labels[code] || code}</div>
        <div class="map-popup-sub">${lines}</div>
      `));
  }

  // ── Train routes ───────────────────────────────
  const cityTrains = {};  // city → [train, …]
  if (_filters.types.train) {
    for (const tr of (trains || [])) {
      if (tr.fromLat == null || tr.toLat == null) continue;
      if (!_filters.legs[_legFor(tr.departureDate, windows)]) continue;

      const isPastTrain = tr.departureDate < today;
      const trainRestOpacity = isPastTrain ? 0.3 : 0.5;
      const trainHoverOpacity = isPastTrain ? 0.6 : 0.85;
      const trainLine = L.polyline(_trainPoints(tr.fromLat, tr.fromLon, tr.toLat, tr.toLon, 30), {
        color: trainLineColor,
        weight: 1.5,
        opacity: trainRestOpacity,
        dashArray: '6 5',
        className: isPastTrain ? 'route-line--past' : '',
      }).addTo(_map);
      trainLine.on('mouseover', () => trainLine.setStyle({ opacity: trainHoverOpacity, weight: 2.5 }));
      trainLine.on('mouseout',  () => trainLine.setStyle({ opacity: trainRestOpacity,  weight: 1.5 }));

      allCoords.push([tr.fromLat, tr.fromLon], [tr.toLat, tr.toLon]);
      for (const [city, lat, lon] of [
        [tr.fromCity, tr.fromLat, tr.fromLon],
        [tr.toCity,   tr.toLat,   tr.toLon],
      ]) {
        if (!city) continue;
        if (!cityTrains[city]) cityTrains[city] = { lat, lon, trains: [] };
        cityTrains[city].trains.push(tr);
      }
    }
  }

  // Train pins — one per unique city
  for (const [city, { lat, lon, trains: tlist }] of Object.entries(cityTrains)) {
    const lines = tlist
      .filter((t, i, arr) => arr.findIndex(x => x.id === t.id) === i)
      .map(t => `${t.fromCity} → ${t.toCity} · ${t.departureDate}`)
      .join('<br>');
    const isPast = tlist.every(t => t.departureDate < today);
    L.marker([lat, lon], { icon: _pinIcon('train', null, isPast) })
      .addTo(_map)
      .on('click', () => _map.flyTo([lat, lon], PIN_CLICK_ZOOM))
      .bindPopup(L.popup({ className: 'map-popup', minWidth: 170 }).setContent(`
        <div class="map-popup-city">${city}</div>
        <div class="map-popup-sub">${lines}</div>
      `));
  }

  // ── Place pins (scheduled activities that carry coordinates) ──
  _placeMarkers = {};
  if (_filters.types.place) {
    for (const entry of (calendarEntries || [])) {
      if (entry.lat == null || entry.lon == null) continue;
      if (!_filters.legs[_legFor(entry.date, windows)]) continue;

      const isPast = entry.date < today;
      const marker = L.marker([entry.lat, entry.lon], { icon: _pinIcon('place', null, isPast) })
        .addTo(_map)
        .on('click', () => _map.flyTo([entry.lat, entry.lon], PIN_CLICK_ZOOM))
        .bindPopup(L.popup({ className: 'map-popup', minWidth: 160 }).setContent(`
          <div class="map-popup-city">${_escHtml(entry.title)}</div>
          <div class="map-popup-sub">${entry.date}</div>
        `));
      if (entry.id) _placeMarkers[entry.id] = marker;
      allCoords.push([entry.lat, entry.lon]);
    }
  }

  // ── AI suggestion pins ("AI ideas" layer) ──
  // Only suggestions the traveller pinned via "Add to map" — a dashed
  // accent pin, kept out of the fit-bounds set so enabling the layer
  // never yanks the view around. A pin whose title already matches an
  // itinerary entry is hidden here too (the server drops it on its next
  // read; this keeps the map in step immediately after an add).
  if (_filters.types.ai && _aiSuggestionsEnabled()) {
    _ensureAiPins();
    // Exact-title match only — mirrors the server, and a loose (substring)
    // match would hide unrelated pins ("Walk" vs "Walk along the Seine").
    const plannedTitles = new Set((calendarEntries || [])
      .filter(e => e.type !== 'accommodation' && e.title)
      .map(e => e.title.trim().toLowerCase()));
    for (const pin of (_aiPins || [])) {
      if (pin.lat == null || pin.lon == null) continue;
      if (!_filters.legs[_legFor(pin.date, windows)]) continue;
      if (plannedTitles.has(pin.name.trim().toLowerCase())) continue;
      const catLabel = t('aiSuggestions.cat.' + pin.category);
      const popupEl = document.createElement('div');
      popupEl.innerHTML = `
        <div class="map-popup-city">${_escHtml(pin.name)}</div>
        <div class="map-popup-sub">${_escHtml([catLabel, pin.city].filter(Boolean).join(' · '))}</div>
        ${pin.address ? `<div class="map-popup-sub">${_escHtml(pin.address)}</div>` : ''}
        <div class="map-popup-ai-foot">
          <span class="map-popup-sub--ai">${_escHtml(t('map.aiPinNote'))}</span>
          <button type="button" class="map-popup-ai-remove">${_escHtml(t('map.aiPinRemove'))}</button>
        </div>`;
      popupEl.querySelector('.map-popup-ai-remove').addEventListener('click', () => _removeAiPin(pin));
      L.marker([pin.lat, pin.lon], { icon: _pinIcon('ai', null, pin.date < today) })
        .addTo(_map)
        .on('click', () => _map.flyTo([pin.lat, pin.lon], PIN_CLICK_ZOOM))
        .bindPopup(L.popup({ className: 'map-popup map-popup--ai', minWidth: 190 }).setContent(popupEl));
    }
  }

  _lastAllCoords = allCoords;
  if (prevView) {
    _map.setView(prevView.center, prevView.zoom, { animate: false });
  } else {
    _applyFitView(allCoords);
  }
  _applyPinScale();
  _applyLineVisibility();
  renderMobileRoutePreview(accommodations);
}

// Today tab's "Ruta" preview button was a blank bordered box with no map
// content — this renders a small, non-interactive Leaflet map (real tiles
// + stay pins, fit to the route) into it so it's an actual preview, not a
// placeholder. All interaction handlers are disabled so a tap always falls
// through to the button's own [data-goto-tab="map"] click handler instead
// of being consumed by Leaflet. Called from _buildMap (data already in
// scope there) and safe to call before the Today DOM exists — it's a
// no-op until #mtoday-map-preview shows up in a later render.
let _previewMap = null;
function renderMobileRoutePreview(accommodations) {
  const el = document.getElementById('mtoday-map-preview');
  if (!el || typeof L === 'undefined') return;

  const stays = (accommodations || []).filter(a => a.lat != null && a.lon != null);
  if (!stays.length) return;

  let mount = el.querySelector('.mtoday-map-preview-mount');
  if (!mount) {
    mount = document.createElement('div');
    mount.className = 'mtoday-map-preview-mount';
    el.insertBefore(mount, el.firstChild);
  }

  if (_previewMap) { _previewMap.remove(); _previewMap = null; }
  _previewMap = L.map(mount, {
    zoomControl: false, attributionControl: false, dragging: false,
    scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false,
    boxZoom: false, keyboard: false, tap: false,
  });
  L.tileLayer(_tileUrl(), { maxZoom: 19 }).addTo(_previewMap);

  const coords = [];
  for (const group of _groupStaysByCoord(stays)) {
    L.circleMarker([group.lat, group.lon], {
      radius: 5, color: group.color, fillColor: group.color, fillOpacity: 0.9, weight: 2,
    }).addTo(_previewMap);
    coords.push([group.lat, group.lon]);
  }
  const euCoords = coords.filter(([lat]) => lat > 35);
  const fitCoords = euCoords.length ? euCoords : coords;
  if (fitCoords.length >= 2) _previewMap.fitBounds(L.latLngBounds(fitCoords).pad(0.2));
  else if (fitCoords.length === 1) _previewMap.setView(fitCoords[0], 9);
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  if (_lastFlights || _lastTrains) {
    requestAnimationFrame(() => _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports, _lastCalendar));
  }
});

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.mmap-header [data-goto-tab]').forEach(btn =>
    btn.addEventListener('click', () => setMobileTab(btn.dataset.gotoTab)));
});

// Mobile Mapa tab — inline itinerary leg-card list rendered below the map
// and its filter chips, reusing the same flight/train shape as itinerary.js
// (see its leg-list derivation) rather than duplicating that whole page.
function _buildInlineItinerary(flights, trains) {
  const el = document.getElementById('mmap-itinerary');
  if (!el) return;
  const fmtT = v => (typeof formatTime24 === 'function' ? formatTime24(v) : formatTime(v));
  const legs = [
    ...(flights || []).map(f => ({
      date: f.departureDate, from: f.fromCity, to: f.toCity, kind: 'flight', icon: '✈',
      detail: f.departureTime ? `${f.flightNumber} · ${fmtT(f.departureTime)}` : `${f.flightNumber} · ${t('map.noSchedule')}`,
    })),
    ...(trains || []).map(tr => ({
      date: tr.departureDate, from: tr.fromCity, to: tr.toCity, kind: 'train', icon: '⇢',
      detail: `${t('map.trainLower')} · ${tr.departureTime ? fmtT(tr.departureTime) : t('map.noSchedule')}`,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const today = appToday();
  let upcoming = legs.map((l, i) => ({ ...l, n: i + 1 })).filter(l => l.date >= today).slice(0, 2);
  if (!upcoming.length) upcoming = legs.map((l, i) => ({ ...l, n: i + 1 })).slice(-2);

  el.innerHTML = `
    <div class="mtoday-block-header" style="padding:6px 0 8px">
      <h3 class="mtoday-block-title">${t('map.upcomingLegs')}</h3>
      <a class="mtoday-link" href="/journey.html">${t('map.seeCount', { n: legs.length })} ›</a>
    </div>
    ${upcoming.map(l => `
      <div class="mmap-leg-card mmap-leg-card--${l.kind}">
        <div class="mmap-leg-top"><span class="mono">${l.n}/${legs.length}</span><span class="mono">${fmtDate(l.date, { year: false })}</span></div>
        <div class="mmap-leg-route"><span>${l.icon}</span><span class="mmap-leg-route-text">${_escHtml(l.from)} → ${_escHtml(l.to)}</span></div>
        <div class="mmap-leg-detail mono">${_escHtml(l.detail)}</div>
      </div>
    `).join('')}
  `;
}
