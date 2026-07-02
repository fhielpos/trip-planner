const express = require('express');
const basicAuth = require('express-basic-auth');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const COMMIT = process.env.COMMIT || (() => {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['pipe','pipe','ignore'] }).toString().trim(); }
  catch { return 'unknown'; }
})();

const app = express();
const PORT = process.env.PORT || 3000;

// Operator-controlled config, not exposed as a user-facing setting — set
// RECOMMENDATIONS_ENABLED=false in the environment to turn the whole
// feature off (endpoint 404s, both "See recommendations" entry points
// stop rendering). Defaults on.
const RECOMMENDATIONS_ENABLED = process.env.RECOMMENDATIONS_ENABLED !== 'false';

if (process.env.APP_PASSWORD) {
  app.use(basicAuth({
    users: { 'franco': process.env.APP_PASSWORD },
    challenge: true,
    realm: 'Trip Planner',
  }));
}
const DATA_FILE    = path.join(__dirname, 'data', 'trip.json');
const ACCOM_FILE   = path.join(__dirname, 'data', 'accommodations.json');
const FLIGHTY_FILE = path.join(__dirname, 'data', 'flighty.txt');
const BUDGET_FILE    = path.join(__dirname, 'data', 'budget.json');
const WISHLIST_FILE  = path.join(__dirname, 'data', 'wishlist.json');
const WEATHER_FILE   = path.join(__dirname, 'data', 'weather.json');
const AIRPORTS_FILE  = path.join(__dirname, 'data', 'airports.json');
const RECOMMENDATIONS_FILE = path.join(__dirname, 'data', 'recommendations.json');

// Airports that mark the home end of the trip (used to classify outbound vs return).
const HOME_AIRPORTS = new Set(['NQN', 'AEP', 'EZE']);

function parseFlightyText(text) {
  function timeToMin(str) {
    const m = str.trim().match(/^(\d+):(\d+)\s+(AM|PM)$/i);
    if (!m) return 0;
    let h = parseInt(m[1]);
    const mn = parseInt(m[2]);
    if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
    if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
    return h * 60 + mn;
  }

  function gmtToMin(str) {
    const m = str.match(/GMT([+-])(\d+)/i);
    if (!m) return 0;
    return (m[1] === '+' ? 1 : -1) * parseInt(m[2]) * 60;
  }

  function minTo24h(total) {
    const h = Math.floor(total / 60) % 24;
    const mn = total % 60;
    return `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
  }

  function parseMonthDate(str) {
    const MONTHS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
    const m = str.trim().match(/(\w{3})\w*\s+(\d+),\s+(\d{4})/);
    if (!m) return null;
    return `${m[3]}-${String(MONTHS[m[1]]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  }

  function shiftDate(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  const blocks = text.split(/\n--\s*(?:\n|$)/).map(b => b.trim()).filter(Boolean);
  const flights = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 5) continue;

    // Line 0: "JetSMART 3172 on Sep 14, 2026"
    const hdr = lines[0].match(/^(.+?)\s+(\S+)\s+on\s+(.+)$/);
    if (!hdr) continue;
    const airline  = hdr[1].trim();
    const number   = hdr[2].trim();
    const depDate  = parseMonthDate(hdr[3]);
    if (!depDate) continue;

    // Fixed positions after stripping blank lines:
    // [0] header  [1] route  [2] ↗dep  [3] ↘arr  [4] flight-length  [5] arriving-at  [6] updates
    const routeLine = lines[1];
    const depLine   = lines[2];
    const arrLine   = lines[3];
    const durLine   = lines[4];
    const termLine  = lines[5];
    const urlLine   = lines[6];

    const depM = depLine?.match(/↗\s+(.+?)\s+(GMT[+-]\d+)\s+(\w+)\s+\((.+?)\)/);
    const arrM = arrLine?.match(/↘\s+(.+?)\s+(GMT[+-]\d+)\s+(\w+)\s+\((.+?)\)/);
    if (!depM || !arrM) continue;

    const depTimeStr = depM[1];
    const depGmt     = depM[2];
    const fromCode   = depM[3];
    const status     = depM[4];
    const arrTimeStr = arrM[1];
    const toCode     = arrM[3];

    // Compute arrival date via UTC arithmetic (handles overnight/multi-day flights)
    const durM = durLine?.match(/(\d+)\s+hr(?:,\s+(\d+)\s+min)?/);
    const durationMin = durM ? parseInt(durM[1]) * 60 + parseInt(durM[2] || 0) : 0;
    const depUtcMin   = timeToMin(depTimeStr) - gmtToMin(depGmt);
    const extraDays   = Math.floor((depUtcMin + durationMin) / (24 * 60));
    const arrDate     = extraDays > 0 ? shiftDate(depDate, extraDays) : depDate;

    // Terminal / gate
    const termM    = termLine?.match(/Terminal\s+(\S+)\s*•\s*Gate\s+(\S+)/);
    const terminal = termM?.[1] !== '--' ? termM?.[1] ?? null : null;
    const gate     = termM?.[2] !== '--' ? termM?.[2] ?? null : null;

    // Flighty live URL
    const flightyUrl = urlLine?.startsWith('Updates:') ? urlLine.slice(8).trim() : null;

    // City names from "Neuquen to Buenos Aires"
    const routeParts = routeLine?.split(' to ');
    const fromCity = routeParts?.[0]?.trim() || '';
    const toCity   = routeParts?.[1]?.trim() || '';

    // Placeholder — every flight gets reclassified by the midpoint pass below.
    const direction = 'connection';

    flights.push({
      id: `f${flights.length + 1}`,
      airline,
      flightNumber: `${airline} ${number}`,
      from: fromCode,
      fromCity,
      to: toCode,
      toCity,
      departureDate: depDate,
      departureTime: minTo24h(timeToMin(depTimeStr)),
      arrivalDate: arrDate,
      arrivalTime: minTo24h(timeToMin(arrTimeStr)),
      terminal,
      gate,
      status,
      direction,
      flightyUrl,
    });
  }

  // Re-classify using the trip midpoint so home airports that appear on both ends
  // (e.g. AEP used for outbound NQN→AEP and return AEP→NQN) resolve correctly.
  const allDates = flights.map(f => f.departureDate).sort();
  if (allDates.length) {
    const firstMs = new Date(allDates[0] + 'T00:00:00Z').getTime();
    const lastMs  = new Date(allDates[allDates.length - 1] + 'T00:00:00Z').getTime();
    const midDate = new Date(firstMs + (lastMs - firstMs) / 2).toISOString().slice(0, 10);

    flights.forEach(f => {
      if      (HOME_AIRPORTS.has(f.from) && f.departureDate <= midDate) f.direction = 'outbound';
      else if (HOME_AIRPORTS.has(f.to)   && f.departureDate >  midDate) f.direction = 'return';
      else                                                                f.direction = 'connection';
    });
  }

  // Chain: any non-outbound leg on or after the first confirmed return date is also return
  // (catches transit legs like CDG→GRU that precede GRU→EZE on the same day).
  const firstReturnDate = flights
    .filter(f => f.direction === 'return')
    .map(f => f.departureDate)
    .sort()[0];
  if (firstReturnDate) {
    flights.forEach(f => {
      if (f.direction !== 'outbound' && f.departureDate >= firstReturnDate)
        f.direction = 'return';
    });
  }

  return flights;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'data', 'images')));

// Read/write a JSON file as a whole document. `fallback` (value or thunk) is
// used only when the file doesn't exist, so trip.json — which always ships
// with the repo — behaves exactly as before (crash if missing).
function jsonStore(file, fallback) {
  return {
    read() {
      if (fallback !== undefined && !fs.existsSync(file)) {
        return typeof fallback === 'function' ? fallback() : fallback;
      }
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    write(data) {
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    },
  };
}

// Merge `patch` into the list item with the given id; returns the updated
// item, or null if no item has that id.
function mergeById(list, id, patch) {
  const idx = list.findIndex(item => item.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch, id };
  return list[idx];
}

// Remove the list item with the given id; returns whether one was removed.
function removeById(list, id) {
  const idx = list.findIndex(item => item.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  return true;
}

const tripStore = jsonStore(DATA_FILE);

function readData() {
  const data = tripStore.read();
  if (!data.trains) data.trains = [];
  return data;
}

function writeData(data) {
  tripStore.write(data);
}

// Get all trip data
app.get('/api/trip', (req, res) => {
  res.json(readData());
});

// ── Accommodations ─────────────────────────────

const accomStore = jsonStore(ACCOM_FILE);

function writeAccommodations(list) {
  list.sort((a, b) => (a.check_in || '').localeCompare(b.check_in || ''));
  accomStore.write(list);
}

function readAccommodations() {
  const list = accomStore.read();
  // Older files have no ids; assign and persist them once.
  if (list.some(a => !a.id)) {
    list.forEach((a, i) => { if (!a.id) a.id = `a${i + 1}`; });
    writeAccommodations(list);
  }
  return list;
}

function validStayDates(check_in, check_out) {
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  return ok(check_in) && ok(check_out) && check_in < check_out;
}

app.get('/api/accommodations', (req, res) => {
  res.json(readAccommodations());
});

app.post('/api/accommodations', (req, res) => {
  const { city, check_in, check_out, country, url, color, lat, lon } = req.body;
  if (!city || !validStayDates(check_in, check_out)) {
    return res.status(400).json({ error: 'city, check_in and check_out (check_in < check_out) are required' });
  }
  const list = readAccommodations();
  const stay = {
    id: 'a' + Date.now(),
    city: String(city),
    country: country || '',
    check_in, check_out,
    lat: lat ?? null,
    lon: lon ?? null,
    color: color || null,
    url: url || null,
  };
  list.push(stay);
  writeAccommodations(list);
  res.status(201).json(stay);
});

app.put('/api/accommodations/:id', (req, res) => {
  const list = readAccommodations();
  const idx = list.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Stay not found' });
  const merged = { ...list[idx], ...req.body, id: req.params.id };
  if (!merged.city || !validStayDates(merged.check_in, merged.check_out)) {
    return res.status(400).json({ error: 'city, check_in and check_out (check_in < check_out) are required' });
  }
  list[idx] = merged;
  writeAccommodations(list);
  res.json(merged);
});

app.delete('/api/accommodations/:id', (req, res) => {
  const list = readAccommodations();
  if (!removeById(list, req.params.id)) return res.status(404).json({ error: 'Stay not found' });
  writeAccommodations(list);
  res.status(204).end();
});

// ── Weather ─────────────────────────────────────
// Forecast for the next ~16 days (Open-Meteo's reliable live-forecast
// window); for stay days outside that window, a 3-year historical average
// for the same calendar date stands in as a "typical weather" estimate.
// Recomputed once per calendar day on read (see GET /api/weather below),
// not per request — see docs/superpowers/specs/2026-07-02-weather-forecast-design.md.

const weatherStore = jsonStore(WEATHER_FILE, () => ({ computedFor: null, byStay: {} }));

const WEATHER_HORIZON_DAYS  = 15;
const WEATHER_HISTORY_YEARS = 3;

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysUTC(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shiftYear(dateStr, yearDelta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y + yearDelta}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function dateRange(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDaysUTC(d, 1)) out.push(d);
  return out;
}

// A trip's worth of stays can add up to dozens of Open-Meteo calls in one
// computeWeather() pass (each historical chunk queries 3 prior years) —
// firing them all at once trips Open-Meteo's burst rate limit (429), so
// cap how many are in flight together.
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const weatherFetchLimit = createLimiter(4);

async function fetchDaily(baseUrl, lat, lon, start, end) {
  const url = `${baseUrl}?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=UTC` +
    `&start_date=${start}&end_date=${end}`;
  return weatherFetchLimit(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const json = await res.json();
      return json.daily || null;
    } catch {
      return null;
    }
  });
}

function mostFrequent(arr) {
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}

async function fetchForecastDays(lat, lon, start, end) {
  const daily = await fetchDaily('https://api.open-meteo.com/v1/forecast', lat, lon, start, end);
  if (!daily) return {};
  const out = {};
  daily.time.forEach((date, i) => {
    out[date] = {
      tempMax: Math.round(daily.temperature_2m_max[i]),
      tempMin: Math.round(daily.temperature_2m_min[i]),
      code:    daily.weathercode[i],
      source:  'forecast',
    };
  });
  return out;
}

// Averages the given date range across the previous WEATHER_HISTORY_YEARS
// years, keyed back to the original (trip-year) dates.
async function fetchHistoricalDays(lat, lon, start, end) {
  const targetDates = dateRange(start, end);
  const perYear = await Promise.all(
    Array.from({ length: WEATHER_HISTORY_YEARS }, (_, i) => i + 1).map(yearsAgo =>
      fetchDaily(
        'https://archive-api.open-meteo.com/v1/archive',
        lat, lon,
        shiftYear(start, -yearsAgo), shiftYear(end, -yearsAgo)
      )
    )
  );

  const out = {};
  targetDates.forEach((date, i) => {
    const maxes = [], mins = [], codes = [];
    for (const daily of perYear) {
      if (!daily || daily.temperature_2m_max[i] == null) continue;
      maxes.push(daily.temperature_2m_max[i]);
      mins.push(daily.temperature_2m_min[i]);
      codes.push(daily.weathercode[i]);
    }
    if (!maxes.length) return;
    out[date] = {
      tempMax: Math.round(maxes.reduce((a, b) => a + b, 0) / maxes.length),
      tempMin: Math.round(mins.reduce((a, b) => a + b, 0) / mins.length),
      code:    mostFrequent(codes),
      source:  'historical',
    };
  });
  return out;
}

async function weatherForStay(stay, today, horizonEnd) {
  if (stay.lat == null || stay.lon == null) return {};
  const stayEnd = addDaysUTC(stay.check_out, -1); // check_out is exclusive
  if (stayEnd < stay.check_in) return {};

  const fStart = stay.check_in > today ? stay.check_in : today;
  const fEnd   = stayEnd < horizonEnd ? stayEnd : horizonEnd;
  const hasForecast = fStart <= fEnd;

  const jobs = [];
  if (hasForecast) {
    jobs.push(fetchForecastDays(stay.lat, stay.lon, fStart, fEnd));
    if (stay.check_in < fStart) jobs.push(fetchHistoricalDays(stay.lat, stay.lon, stay.check_in, addDaysUTC(fStart, -1)));
    if (fEnd < stayEnd) jobs.push(fetchHistoricalDays(stay.lat, stay.lon, addDaysUTC(fEnd, 1), stayEnd));
  } else {
    jobs.push(fetchHistoricalDays(stay.lat, stay.lon, stay.check_in, stayEnd));
  }

  const parts = await Promise.all(jobs);
  return Object.assign({}, ...parts);
}

async function computeWeather() {
  const today = todayUTC();
  const horizonEnd = addDaysUTC(today, WEATHER_HORIZON_DAYS);
  const stays = readAccommodations();
  const byStay = {};
  await Promise.all(stays.map(async stay => {
    byStay[stay.id] = await weatherForStay(stay, today, horizonEnd);
  }));
  return { computedFor: today, byStay };
}

app.get('/api/weather', async (req, res) => {
  let cache = weatherStore.read();
  if (cache.computedFor !== todayUTC()) {
    cache = await computeWeather();
    weatherStore.write(cache);
  }
  res.json(cache.byStay);
});

// Flights parsed from the flighty.txt export — the file is static at
// runtime (nothing ever writes to it), so parse it once instead of per request.
const FLIGHTS = parseFlightyText(fs.readFileSync(FLIGHTY_FILE, 'utf8'));
app.get('/api/flights', (req, res) => {
  res.json(FLIGHTS);
});

// ── Airports ────────────────────────────────────
// Coordinates looked up from hexdb.io's free keyless airport API instead of
// a hand-maintained table — a code is fetched once and cached forever
// (airport locations don't change, unlike weather).

const airportsStore = jsonStore(AIRPORTS_FILE, () => ({}));
const airportsFetchLimit = createLimiter(4);

async function fetchAirport(code) {
  return airportsFetchLimit(async () => {
    try {
      const res = await fetch(`https://hexdb.io/api/v1/airport/iata/${code}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const json = await res.json();
      if (json.latitude == null || json.longitude == null) return null;
      return { lat: json.latitude, lon: json.longitude };
    } catch {
      return null;
    }
  });
}

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
const wikipediaFetchLimit = createLimiter(4);

// Wikipedia's free REST API returns a real thumbnail for any page that has
// one — measured at ~30% coverage across a sample of named POIs (most
// don't have a Wikipedia article at all; those that do usually have an
// image). No key, same "lang:Title" tag already used for the link
// fallback, so this is additive rather than a new data dependency.
async function fetchWikipediaThumbnail(wikipediaTag) {
  if (!wikipediaTag) return null;
  const sep = wikipediaTag.indexOf(':');
  if (sep === -1) return null;
  const lang = wikipediaTag.slice(0, sep).trim();
  const title = wikipediaTag.slice(sep + 1).trim();
  if (!lang || !title) return null;
  return wikipediaFetchLimit(async () => {
    try {
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'trip-planner/1.0 (personal trip-planning app, non-commercial)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const json = await res.json();
      return json.thumbnail?.source || null;
    } catch {
      return null;
    }
  });
}

// OSM's `wikipedia` tag is "lang:Title" — turn it into a real URL. Used as
// a fallback when a POI has no `website` tag (most named attractions have
// at least one of the two; a picture would be nicer but OSM rarely has a
// direct, usable image URL, so a link is the reliable middle ground).
function wikipediaUrl(tag) {
  if (!tag) return null;
  const sep = tag.indexOf(':');
  if (sep === -1) return null;
  const lang = tag.slice(0, sep).trim();
  const title = tag.slice(sep + 1).trim();
  if (!lang || !title) return null;
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

// Returns null on failure (network error, non-ok status) so the caller can
// tell "genuinely no POIs here" (an empty array — cacheable) apart from
// "the request didn't work" (not cacheable). A descriptive User-Agent is
// required here, not just polite: Node's fetch sends none by default, and
// Overpass's public instance reliably 406s requests that lack one — the
// requests aren't flaky, they're rejected deterministically without it.
async function fetchOverpassPOIsOnce(lat, lon) {
  const query = `[out:json][timeout:20];` +
    `(node["tourism"~"attraction|museum|viewpoint|gallery|artwork|zoo"](around:2000,${lat},${lon}););` +
    `out body 30;`;
  try {
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'trip-planner/1.0 (personal trip-planning app, non-commercial)',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const pois = (json.elements || [])
      .filter(el => el.tags?.name && el.lat != null && el.lon != null)
      .map(el => ({
        name:      el.tags.name,
        category:  el.tags.tourism,
        lat:       el.lat,
        lon:       el.lon,
        address:   [el.tags['addr:street'], el.tags['addr:housenumber']].filter(Boolean).join(' ') || null,
        link:      el.tags.website || wikipediaUrl(el.tags.wikipedia) || null,
        wikipedia: el.tags.wikipedia || null, // used below to fetch a thumbnail, stripped before returning
      }));

    const images = await Promise.all(pois.map(p => fetchWikipediaThumbnail(p.wikipedia)));
    return pois.map(({ wikipedia, ...poi }, i) => ({ ...poi, image: images[i] }));
  } catch {
    return null;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchOverpassPOIs(lat, lon) {
  return recommendationsFetchLimit(async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await fetchOverpassPOIsOnce(lat, lon);
      if (result !== null) return result;
      if (attempt < 3) await sleep(800);
    }
    return null;
  });
}

app.get('/api/recommendations/:stayId', async (req, res) => {
  if (!RECOMMENDATIONS_ENABLED) return res.status(404).json({ error: 'Not found' });

  const stay = readAccommodations().find(a => a.id === req.params.stayId);
  if (!stay || stay.lat == null || stay.lon == null) {
    return res.status(404).json({ error: 'Stay not found or missing coordinates' });
  }

  const cache = recommendationsStore.read();
  if (cache[stay.id]) return res.json(cache[stay.id]);

  const fetched = await fetchOverpassPOIs(stay.lat, stay.lon);
  if (fetched === null) {
    return res.status(502).json({ error: 'Failed to fetch recommendations, try again' });
  }
  cache[stay.id] = fetched;
  recommendationsStore.write(cache);
  res.json(fetched);
});

// Update trip info
app.put('/api/trip', (req, res) => {
  const data = readData();
  data.trip = { ...data.trip, ...req.body };
  writeData(data);
  res.json(data.trip);
});

// Add a calendar entry
app.post('/api/calendar', (req, res) => {
  const data = readData();
  const entry = {
    id: 'c' + Date.now(),
    ...req.body
  };
  data.calendar.push(entry);
  writeData(data);
  res.status(201).json(entry);
});

// Update a calendar entry
app.put('/api/calendar/:id', (req, res) => {
  const data = readData();
  const updated = mergeById(data.calendar, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Entry not found' });
  writeData(data);
  res.json(updated);
});

// Delete a calendar entry
app.delete('/api/calendar/:id', (req, res) => {
  const data = readData();
  if (!removeById(data.calendar, req.params.id)) return res.status(404).json({ error: 'Entry not found' });
  writeData(data);
  res.status(204).end();
});

// Update a flight
app.put('/api/flights/:id', (req, res) => {
  const data = readData();
  const updated = mergeById(data.flights, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Flight not found' });
  writeData(data);
  res.json(updated);
});

// ── Trains ─────────────────────────────────────

app.get('/api/trains', (req, res) => {
  res.json(readData().trains);
});

app.post('/api/trains', (req, res) => {
  const data = readData();
  const train = { id: 't' + Date.now(), ...req.body };
  data.trains.push(train);
  writeData(data);
  res.status(201).json(train);
});

app.put('/api/trains/:id', (req, res) => {
  const data = readData();
  const updated = mergeById(data.trains, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Train not found' });
  writeData(data);
  res.json(updated);
});

app.delete('/api/trains/:id', (req, res) => {
  const data = readData();
  if (!removeById(data.trains, req.params.id)) return res.status(404).json({ error: 'Train not found' });
  writeData(data);
  res.status(204).end();
});

// ── Budget ─────────────────────────────────────

const budgetStore = jsonStore(BUDGET_FILE, () => ({ initialBudget: 0, currency: 'EUR', entries: [] }));
function readBudget()       { return budgetStore.read(); }
function writeBudget(data)  { budgetStore.write(data); }

app.get('/api/budget', (req, res) => {
  res.json(readBudget());
});

app.put('/api/budget/settings', (req, res) => {
  const b = readBudget();
  if (req.body.initialBudget !== undefined) b.initialBudget = Number(req.body.initialBudget);
  if (req.body.currency)                    b.currency = req.body.currency;
  if (Array.isArray(req.body.subBudgets)) {
    b.subBudgets = req.body.subBudgets
      .filter(s => s && s.category && Number(s.amount) > 0)
      .map(s => ({ category: s.category, amount: Number(s.amount) }));
  }
  if (Array.isArray(req.body.categories)) {
    b.categories = req.body.categories
      .filter(c => c && c.id && c.name)
      .map(c => ({ id: String(c.id), name: String(c.name), color: c.color || '#b0a898' }));
  }
  writeBudget(b);
  res.json(b);
});

app.post('/api/budget/entries', (req, res) => {
  const b = readBudget();
  const entry = {
    id:          'b' + Date.now(),
    date:        req.body.date,
    amount:      Number(req.body.amount),
    category:    req.body.category || 'other',
    description: req.body.description || '',
    city:        req.body.city || '',
  };
  b.entries.push(entry);
  writeBudget(b);
  res.json(entry);
});

app.put('/api/budget/entries/:id', (req, res) => {
  const b = readBudget();
  const updated = mergeById(b.entries, req.params.id, { ...req.body, amount: Number(req.body.amount) });
  if (!updated) return res.status(404).json({ error: 'not found' });
  writeBudget(b);
  res.json(updated);
});

app.delete('/api/budget/entries/:id', (req, res) => {
  const b = readBudget();
  b.entries = b.entries.filter(e => e.id !== req.params.id);
  writeBudget(b);
  res.sendStatus(204);
});

// ── Wishlist ────────────────────────────────────

const wishlistStore = jsonStore(WISHLIST_FILE, () => ({ items: [] }));
function readWishlist()      { return wishlistStore.read(); }
function writeWishlist(data) { wishlistStore.write(data); }

app.get('/api/wishlist', (req, res) => res.json(readWishlist()));

app.post('/api/wishlist', (req, res) => {
  const w = readWishlist();
  const item = {
    id:    'w' + Date.now(),
    name:  req.body.name || '',
    price: Number(req.body.price) || 0,
    url:   req.body.url || '',
  };
  w.items.push(item);
  writeWishlist(w);
  res.json(item);
});

app.put('/api/wishlist/:id', (req, res) => {
  const w = readWishlist();
  const updated = mergeById(w.items, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'not found' });
  if (req.body.price !== undefined) updated.price = Number(req.body.price);
  writeWishlist(w);
  res.json(updated);
});

app.delete('/api/wishlist/:id', (req, res) => {
  const w = readWishlist();
  w.items = w.items.filter(i => i.id !== req.params.id);
  writeWishlist(w);
  res.sendStatus(204);
});

// Read a <meta property="X" content="Y"> value, tolerating either attribute order.
function metaContent(html, property) {
  return html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"'<>]+)["']`, 'i'))?.[1]
      || html.match(new RegExp(`<meta[^>]+content=["']([^"'<>]+)["'][^>]+property=["']${property}["']`, 'i'))?.[1]
      || null;
}

function _decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

app.post('/api/wishlist/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    if (!resp.ok) {
      const blocked = resp.status === 403 || resp.status === 429 || resp.status === 503;
      return res.status(502).json({ error: blocked ? 'blocked' : `HTTP ${resp.status}` });
    }
    const html = await resp.text();

    const ogTitle = metaContent(html, 'og:title');
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    let rawName = _decodeHtmlEntities((ogTitle || titleTag || '').trim());
    rawName = rawName.split(/\s+[|\-–—]\s+/)[0].trim().substring(0, 200);

    // 1. Open Graph / meta tags
    let priceStr = metaContent(html, 'og:price:amount') || metaContent(html, 'product:price:amount');

    // 2. JSON-LD structured data (used by Decathlon, many large retailers)
    if (!priceStr) {
      const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      for (const [, json] of ldBlocks) {
        try {
          const data = JSON.parse(json);
          const nodes = Array.isArray(data) ? data : [data];
          for (const node of nodes) {
            const offers = node.offers ?? node['@graph']?.find?.(n => n.offers)?.offers;
            if (!offers) continue;
            const offer = Array.isArray(offers) ? offers[0] : offers;
            if (offer.price != null) { priceStr = String(offer.price); break; }
          }
        } catch { /* malformed JSON-LD, skip */ }
        if (priceStr) break;
      }
    }

    const price = priceStr ? parseFloat(String(priceStr).replace(/[^0-9.]/g, '')) || null : null;

    res.json({ name: rawName, price });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Fetch failed' });
  }
});

// ── Export ─────────────────────────────────────

app.get('/api/export', (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  const payload = {
    trip:           readData(),
    budget:         readBudget(),
    wishlist:       readWishlist(),
    accommodations: readAccommodations(),
    flighty:        fs.readFileSync(FLIGHTY_FILE, 'utf8'),
  };
  res.setHeader('Content-Disposition', `attachment; filename="trip-export-${date}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload, null, 2));
});

app.get('/api/version', (req, res) => res.json({ commit: COMMIT }));

app.get('/api/config', (req, res) => res.json({ recommendationsEnabled: RECOMMENDATIONS_ENABLED }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Trip Planner running at http://localhost:${PORT}`);
});
