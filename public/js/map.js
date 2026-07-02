/* =============================================
   Trip Route Map — Leaflet + CartoDB
   ============================================= */

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

// Gentle arc for trains — much less curvature than flights
function _trainPoints(lat1, lon1, lat2, lon2, n) {
  const dist = Math.abs(lat2 - lat1) + Math.abs(lon2 - lon1);
  const ctrlLat = (lat1 + lat2) / 2 + dist * 0.06;
  const ctrlLon = (lon1 + lon2) / 2;
  return _bezierPoints(lat1, lon1, ctrlLat, ctrlLon, lat2, lon2, n);
}

function _pinIcon(type) {
  const bg   = type === 'flight'
    ? _cssVar('--accent', '#d49258')
    : _cssVar('--c-train', '#5fa88e');
  const glyph = type === 'flight' ? '✈' : '⊛';
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

// Stays sharing exact coordinates (repeat visits to the same city) render
// as one circle marker listing every visit, rather than stacked duplicates.
function _groupStaysByCoord(accommodations) {
  const groups = {};
  for (const a of accommodations) {
    if (a.lat == null || a.lon == null) continue;
    const key = `${a.lat},${a.lon}`;
    if (!groups[key]) groups[key] = { lat: a.lat, lon: a.lon, color: a.color, stays: [] };
    groups[key].stays.push(a);
  }
  return Object.values(groups);
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
      _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports);
    });
  });
}

function _buildMap(flights, trains, accommodations, airports) {
  const container = document.getElementById('trip-map');
  if (!container || typeof L === 'undefined') return;

  _buildFilterBar();

  if (_map) { _map.remove(); _map = null; }

  _map = L.map('trip-map', { scrollWheelZoom: false, zoomControl: true });
  L.tileLayer(_tileUrl(), {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
  }).addTo(_map);

  const accentColor = _cssVar('--accent', '#d49258');
  const trainColor  = _cssVar('--c-train', '#5fa88e');
  const windows = _legWindows(flights || []);
  const labels  = _airportLabels(flights || []);

  const allCoords = [];   // for fitBounds

  // ── Stay markers (drawn first, so pins layer on top) ───
  if (_filters.types.stay) {
    for (const group of _groupStaysByCoord(accommodations || [])) {
      const leg = _legFor(group.stays[0].check_in, windows);
      if (!_filters.legs[leg]) continue;

      const color = group.color || accentColor;
      L.circleMarker([group.lat, group.lon], {
        radius: 22,
        color,
        weight: 1,
        opacity: 0.5,
        fillColor: color,
        fillOpacity: 0.18,
      })
        .addTo(_map)
        .bindPopup(L.popup({ className: 'map-popup', minWidth: 170 }).setContent(`
          <div class="map-popup-city">${group.stays[0].city}</div>
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
      .bindPopup(L.popup({ className: 'map-popup', minWidth: 170 }).setContent(`
        <div class="map-popup-city">${city}</div>
        <div class="map-popup-sub">${lines}</div>
      `));
  }

  // Fit to European portion — South America would shrink the view to world scale
  const euCoords = allCoords.filter(([lat]) => lat > 35);
  const fitCoords = euCoords.length ? euCoords : allCoords;
  if (fitCoords.length >= 2) {
    _map.fitBounds(L.latLngBounds(fitCoords).pad(0.25));
  } else if (fitCoords.length === 1) {
    _map.setView(fitCoords[0], 11);
  } else {
    _map.setView([46, 10], 4); // everything filtered out — default Europe view rather than a broken map
  }
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  if (_lastFlights || _lastTrains) {
    requestAnimationFrame(() => _buildMap(_lastFlights, _lastTrains, _lastAccommodations, _lastAirports));
  }
});
