/* =============================================
   Trip Route Map — Leaflet + CartoDB
   ============================================= */

let _map = null;
let _lastFlights = null;
let _lastTrains  = null;

// IATA → coordinates + display name
const AIRPORT_COORDS = {
  NQN: { lat: -38.9490, lon: -68.1558, name: 'Neuquén (NQN)' },
  AEP: { lat: -34.5587, lon: -58.4116, name: 'Buenos Aires (AEP)' },
  EZE: { lat: -34.8222, lon: -58.5358, name: 'Buenos Aires (EZE)' },
  CDG: { lat:  49.0097, lon:   2.5479, name: 'Paris (CDG)' },
  ORY: { lat:  48.7262, lon:   2.3652, name: 'Paris Orly (ORY)' },
  ATH: { lat:  37.9364, lon:  23.9445, name: 'Athens (ATH)' },
  VIE: { lat:  48.1103, lon:  16.5697, name: 'Vienna (VIE)' },
  GRU: { lat: -23.4356, lon: -46.4731, name: 'São Paulo (GRU)' },
  GVA: { lat:  46.2380, lon:   6.1089, name: 'Geneva (GVA)' },
  AMS: { lat:  52.3105, lon:   4.7683, name: 'Amsterdam (AMS)' },
  MUC: { lat:  48.3537, lon:  11.7750, name: 'Munich (MUC)' },
  ZRH: { lat:  47.4647, lon:   8.5492, name: 'Zürich (ZRH)' },
};

function renderMap(flights, trains) {
  _lastFlights = flights;
  _lastTrains  = trains;
  _buildMap(flights, trains);
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

function _buildMap(flights, trains) {
  const container = document.getElementById('trip-map');
  if (!container || typeof L === 'undefined') return;

  if (_map) { _map.remove(); _map = null; }

  _map = L.map('trip-map', { scrollWheelZoom: false, zoomControl: true });
  L.tileLayer(_tileUrl(), {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
  }).addTo(_map);

  const accentColor = _cssVar('--accent', '#d49258');
  const trainColor  = _cssVar('--c-train', '#5fa88e');

  const allCoords = [];   // for fitBounds

  // ── Flight routes ──────────────────────────────
  const airportFlights = {};  // code → [flight, …]
  for (const f of (flights || [])) {
    const dep = AIRPORT_COORDS[f.from];
    const arr = AIRPORT_COORDS[f.to];
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

  // Flight pins — one per unique airport code
  for (const [code, flist] of Object.entries(airportFlights)) {
    const c = AIRPORT_COORDS[code];
    if (!c) continue;
    const lines = flist.map(f => `${f.flightNumber} · ${f.from}→${f.to} · ${f.departureDate}`).join('<br>');
    L.marker([c.lat, c.lon], { icon: _pinIcon('flight') })
      .addTo(_map)
      .bindPopup(L.popup({ className: 'map-popup', minWidth: 180 }).setContent(`
        <div class="map-popup-city">${c.name}</div>
        <div class="map-popup-sub">${lines}</div>
      `));
  }

  // ── Train routes ───────────────────────────────
  const cityTrains = {};  // city → [train, …]
  for (const tr of (trains || [])) {
    if (tr.fromLat == null || tr.toLat == null) continue;

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
  }
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  if (_lastFlights || _lastTrains) {
    requestAnimationFrame(() => _buildMap(_lastFlights, _lastTrains));
  }
});
