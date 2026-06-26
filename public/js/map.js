/* =============================================
   Trip Route Map — Leaflet + CartoDB
   ============================================= */

let _map = null;
let _lastAccommodations = null;
let _lastColorMap = null;

function renderMap(accommodations, colorMap) {
  _lastAccommodations = accommodations;
  _lastColorMap = colorMap;
  _buildMap(accommodations, colorMap);
}

function _tileUrl() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  return isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
}

function _accentColor() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || '#d49258';
}

// Quadratic bezier arc between two coordinates.
// Control point is the midpoint offset northward — produces visually curved routes on Mercator maps.
function _curvedPoints(lat1, lon1, lat2, lon2, n) {
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  // Offset control point northward proportional to segment extent
  const ctrlLat = (lat1 + lat2) / 2 + Math.abs(dLon) * 0.45 + Math.abs(dLat) * 0.18;
  const ctrlLon = (lon1 + lon2) / 2;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([
      u * u * lat1 + 2 * u * t * ctrlLat + t * t * lat2,
      u * u * lon1 + 2 * u * t * ctrlLon + t * t * lon2,
    ]);
  }
  return pts;
}

function _buildMap(accommodations, colorMap) {
  const container = document.getElementById('trip-map');
  if (!container || typeof L === 'undefined') return;

  const stops = accommodations.filter(a => a.lat != null && a.lon != null);
  if (!stops.length) return;

  if (_map) { _map.remove(); _map = null; }

  _map = L.map('trip-map', { scrollWheelZoom: false, zoomControl: true });

  L.tileLayer(_tileUrl(), {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
  }).addTo(_map);

  // Geodesic route — curved arcs instead of straight lines
  const routePoints = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    const seg = _curvedPoints(a.lat, a.lon, b.lat, b.lon, 60);
    if (i > 0) seg.shift(); // avoid duplicate endpoint
    routePoints.push(...seg);
  }
  L.polyline(routePoints, {
    color: _accentColor(),
    weight: 2,
    opacity: 0.65,
    dashArray: '8, 6',
  }).addTo(_map);

  // Build city → [visit numbers] index for combined labels on repeated cities
  const cityVisits = {};
  stops.forEach((a, i) => {
    const key = a.city;
    if (!cityVisits[key]) cityVisits[key] = [];
    cityVisits[key].push(i + 1);
  });

  // Numbered markers
  stops.forEach((a, i) => {
    const colour = colorMap[a.check_in] || { accent: _accentColor() };
    const visits = cityVisits[a.city];
    const label = visits.length > 1 ? visits.join(' · ') : String(i + 1);

    const icon = L.divIcon({
      className: '',
      html: `<div class="map-pin" style="background:${colour.accent}">${label}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -18],
    });

    const reservationLink = a.url
      ? `<a href="${a.url}" target="_blank" rel="noopener" class="map-popup-link">${typeof t === 'function' ? t('map.viewReservation') : 'View reservation ↗'}</a>`
      : '';

    const popup = L.popup({ className: 'map-popup', minWidth: 150 }).setContent(`
      <div class="map-popup-city">${a.city}</div>
      <div class="map-popup-country">${a.country}</div>
      <div class="map-popup-dates">${a.check_in} → ${a.check_out}</div>
      ${reservationLink}
    `);

    L.marker([a.lat, a.lon], { icon }).addTo(_map).bindPopup(popup);
  });

  // Fit to European stops only — Buenos Aires stretches the bounds to world view
  const viewStops = stops.filter(a => a.lat > 35);
  const boundsStops = viewStops.length ? viewStops : stops;
  _map.fitBounds(L.latLngBounds(boundsStops.map(a => [a.lat, a.lon])).pad(0.25));
}

// Rebuild map when theme or language changes
document.getElementById('theme-toggle').addEventListener('click', () => {
  if (_lastAccommodations && _lastColorMap) {
    requestAnimationFrame(() => _buildMap(_lastAccommodations, _lastColorMap));
  }
});

document.addEventListener('langchange', () => {
  if (_lastAccommodations && _lastColorMap) {
    _buildMap(_lastAccommodations, _lastColorMap);
  }
});
