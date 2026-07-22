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

const _ResetViewControl = L.Control.extend({
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

function _tileUrl() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  return isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
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

function _pinIcon(type, colorOverride) {
  const bg = colorOverride || (type === 'flight' ? _cssVar('--accent', '#d49258')
    : type === 'train' ? _cssVar('--c-train', '#5fa88e')
    : _cssVar('--c-activity', '#d8b47a'));
  const glyph = type === 'flight' ? '✈️' : type === 'train' ? '🚆' : type === 'stay' ? '🛏️' : '📍';
  return L.divIcon({
    className: '',
    html: `<div class="map-pin map-pin--${type}" style="background:${bg}">${glyph}</div>`,
    iconSize:    [24, 24],
    iconAnchor:  [12, 12],
    popupAnchor: [0, -16],
  });
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
  if (!container || typeof L === 'undefined') return;

  _buildFilterBar();
  if (isMobileViewport()) {
    _buildInlineItinerary(flights, trains);
    registerMobileRerender(() => _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports, _lastCalendar));
  } else {
    document.getElementById('mmap-itinerary').innerHTML = '';
  }

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

  const accentColor = _cssVar('--accent', '#d49258');
  const trainColor  = _cssVar('--c-train', '#5fa88e');
  const windows = _legWindows(flights || []);
  const labels  = _airportLabels(flights || []);

  const allCoords = [];   // for fitBounds

  // ── Stay markers ────────────────────────────────
  if (_filters.types.stay) {
    for (const group of _groupStaysByCoord(accommodations || [])) {
      const leg = _legFor(group.stays[0].check_in, windows);
      if (!_filters.legs[leg]) continue;

      const color = group.color || accentColor;
      L.marker([group.lat, group.lon], { icon: _pinIcon('stay', color) })
        .addTo(_map)
        .on('click', () => _map.flyTo([group.lat, group.lon], PIN_CLICK_ZOOM))
        .bindPopup(L.popup({ className: 'map-popup', minWidth: 170 }).setContent(`
          <div class="map-popup-city">${group.stays[0].city}</div>
          ${group.isExact ? `<div class="map-popup-sub">${_escHtml(group.stays[0].address)}</div>` : ''}
          <div class="map-popup-sub">${group.stays.map(s => `${s.check_in} → ${s.check_out}`).join('<br>')}</div>
        `));
      allCoords.push([group.lat, group.lon]);
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
      L.polyline(_curvedPoints(dep.lat, dep.lon, arr.lat, arr.lon, 60, curveDown), {
        color: accentColor,
        weight: 2,
        opacity: 0.65,
        dashArray: '8, 6',
      }).addTo(_map);

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
    L.marker([c.lat, c.lon], { icon: _pinIcon('flight') })
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

      L.polyline(_trainPoints(tr.fromLat, tr.fromLon, tr.toLat, tr.toLon, 30), {
        color: trainColor,
        weight: 2.5,
        opacity: 0.75,
        dashArray: '3, 6',
      }).addTo(_map);

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
    L.marker([lat, lon], { icon: _pinIcon('train') })
      .addTo(_map)
      .on('click', () => _map.flyTo([lat, lon], PIN_CLICK_ZOOM))
      .bindPopup(L.popup({ className: 'map-popup', minWidth: 170 }).setContent(`
        <div class="map-popup-city">${city}</div>
        <div class="map-popup-sub">${lines}</div>
      `));
  }

  // ── Place pins (scheduled activities that carry coordinates) ──
  if (_filters.types.place) {
    for (const entry of (calendarEntries || [])) {
      if (entry.lat == null || entry.lon == null) continue;
      if (!_filters.legs[_legFor(entry.date, windows)]) continue;

      L.marker([entry.lat, entry.lon], { icon: _pinIcon('place') })
        .addTo(_map)
        .on('click', () => _map.flyTo([entry.lat, entry.lon], PIN_CLICK_ZOOM))
        .bindPopup(L.popup({ className: 'map-popup', minWidth: 160 }).setContent(`
          <div class="map-popup-city">${entry.title}</div>
          <div class="map-popup-sub">${entry.date}</div>
        `));
      allCoords.push([entry.lat, entry.lon]);
    }
  }

  _lastAllCoords = allCoords;
  if (prevView) {
    _map.setView(prevView.center, prevView.zoom, { animate: false });
  } else {
    _applyFitView(allCoords);
  }
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
  const legs = [
    ...(flights || []).map(f => ({ date: f.departureDate, from: f.fromCity, to: f.toCity, detail: `${f.flightNumber} · ${formatTime(f.departureTime)}`, icon: '✈', kind: 'flight' })),
    ...(trains || []).map(tr => ({ date: tr.departureDate, from: tr.fromCity, to: tr.toCity, detail: tr.departureTime ? formatTime(tr.departureTime) : '', icon: '🚆', kind: 'train' })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  el.innerHTML = `
    <div class="mtoday-block-header" style="padding:6px 0 8px">
      <h3 class="mtoday-block-title">${t('itinerary.title')}</h3>
      <a class="mtoday-link" href="/itinerary.html">${t('map.viewAll')} ›</a>
    </div>
    ${legs.map((l, i) => `
      <div class="mmap-leg-card mmap-leg-card--${l.kind}">
        <div class="mmap-leg-top"><span>${i + 1}/${legs.length}</span><span>${fmtDate(l.date, { year: false })}</span></div>
        <div class="mmap-leg-route"><span>${l.icon}</span><span class="mmap-leg-route-text">${_escHtml(l.from)} → ${_escHtml(l.to)}</span></div>
        <div class="mmap-leg-detail">${l.detail}</div>
      </div>
    `).join('')}
  `;
}
