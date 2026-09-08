const express = require('express');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');
const { execSync } = require('child_process');
const {
  COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  createSessionToken,
  requireAuth,
  robotsTagMiddleware,
  getClientIp,
  isIpBlocked,
  recordFailedLogin,
  recordSuccessfulLogin,
} = require('./auth');

const COMMIT = process.env.COMMIT || (() => {
  try { return fs.readFileSync(path.join(__dirname, '.build-id'), 'utf8').trim(); } catch {}
  try { return execSync('git rev-parse --short HEAD', { stdio: ['pipe','pipe','ignore'] }).toString().trim(); }
  catch { return 'unknown'; }
})();

const COMMIT_MESSAGE = process.env.COMMIT_MESSAGE || (() => {
  try { return execSync('git log -1 --pretty=%s', { stdio: ['pipe','pipe','ignore'] }).toString().trim(); }
  catch { return ''; }
})();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(robotsTagMiddleware);

// Operator-controlled config, not exposed as a user-facing setting — set
// RECOMMENDATIONS_ENABLED=true in the environment to turn the whole
// feature on (endpoint 404s and both "See recommendations" entry points
// stay hidden otherwise). Defaults off.
const RECOMMENDATIONS_ENABLED = process.env.RECOMMENDATIONS_ENABLED === 'true';

// AI activity suggestions — operator-controlled, off by default. Needs both
// an API key and the explicit flag; without both, /api/ai-suggestions* 404s
// and the client shows no entry point. AI_SUGGESTIONS_MODEL overrides the
// model (exact id, no date suffix). Key is read here only, never returned.
const AI_SUGGESTIONS_ENABLED =
  process.env.AI_SUGGESTIONS_ENABLED === 'true' && Boolean(process.env.ANTHROPIC_API_KEY);
const AI_SUGGESTIONS_MODEL = process.env.AI_SUGGESTIONS_MODEL || 'claude-haiku-4-5';

const DATA_FILE    = path.join(__dirname, 'data', 'trip.json');
const ACCOM_FILE   = path.join(__dirname, 'data', 'accommodations.json');
const FLIGHTY_FILE = path.join(__dirname, 'data', 'flighty.txt');
const BUDGET_FILE    = path.join(__dirname, 'data', 'budget.json');
const WISHLIST_FILE  = path.join(__dirname, 'data', 'wishlist.json');
const WEATHER_FILE   = path.join(__dirname, 'data', 'weather.json');
const AIRPORTS_FILE  = path.join(__dirname, 'data', 'airports.json');
const RECOMMENDATIONS_FILE = path.join(__dirname, 'data', 'recommendations.json');
const AI_SUGGESTIONS_FILE = path.join(__dirname, 'data', 'ai-suggestions.json');
const DOCUMENTS_FILE = path.join(__dirname, 'data', 'documents.json');
const DOCUMENTS_DIR  = path.join(__dirname, 'data', 'documents-files');
const FLIGHTS_FILE = path.join(__dirname, 'data', 'flights.json');
const RATES_FILE = path.join(__dirname, 'data', 'rates.json');

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

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const ip = getClientIp(req);
  if (isIpBlocked(ip)) {
    return res.status(403).json({ error: 'Too many failed attempts. Access blocked.' });
  }

  const { password } = req.body || {};
  if (!process.env.APP_PASSWORD || password !== process.env.APP_PASSWORD) {
    recordFailedLogin(ip);
    const error = isIpBlocked(ip) ? 'Too many failed attempts. Access blocked.' : 'Invalid password';
    return res.status(401).json({ error });
  }
  recordSuccessfulLogin(ip);

  // Railway terminates TLS at its edge and forwards plain HTTP internally, so req.secure
  // alone isn't enough — check X-Forwarded-Proto too. Locally (curl/browser over plain
  // HTTP) both are false, which is required: a hardcoded `secure: true` cookie would never
  // be resent by the browser over HTTP, breaking every local test.
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.use(requireAuth);

// Templates the current commit into the service worker's own bytes so a
// deploy actually changes the file the browser compares against — serving
// it as a plain static file would leave every deploy invisible to the SW's
// update check, since that check only looks at the script's bytes, not
// anything it fetches at runtime.
app.get('/sw.js', (req, res) => {
  const sw = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8')
    .replaceAll('__COMMIT__', COMMIT);
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(sw);
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

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

function validTotalPrice(v) {
  return v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

// A per-entry rate override must be strictly positive (it's a divisor in
// toUSD) — unlike validTotalPrice, 0 is not a valid value here.
function validRate(v) {
  return v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);
}

const NOMINATIM_USER_AGENT = 'trip-planner/1.0 (personal trip-planning app, non-commercial)';
let _lastNominatimCall = 0;
const geocodeLimiter = createLimiter(1);

// Turns a free-text address into { lat, lon }, or null if no match / any
// failure. Enforces Nominatim's "max 1 req/sec" usage policy via a
// last-call timestamp gate — createLimiter alone only bounds concurrency,
// not spacing between calls.
async function geocodeAddress(address) {
  return geocodeLimiter(async () => {
    const wait = _lastNominatimCall + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    _lastNominatimCall = Date.now();
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': NOMINATIM_USER_AGENT,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const results = await res.json();
      if (!Array.isArray(results) || results.length === 0) return null;
      const lat = parseFloat(results[0].lat);
      const lon = parseFloat(results[0].lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { lat, lon };
    } catch {
      return null;
    }
  });
}

app.get('/api/accommodations', (req, res) => {
  res.json(readAccommodations());
});

app.post('/api/accommodations', (req, res) => {
  const { city, check_in, check_out, country, url, color, lat, lon, address, total_price } = req.body;
  if (!city || !validStayDates(check_in, check_out)) {
    return res.status(400).json({ error: 'city, check_in and check_out (check_in < check_out) are required' });
  }
  if (!validTotalPrice(total_price)) {
    return res.status(400).json({ error: 'total_price must be a non-negative number or null' });
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
    address: address || '',
    total_price: total_price ?? null,
    exact_lat: null,
    exact_lon: null,
    geocode_status: null,
  };
  list.push(stay);
  writeAccommodations(list);
  res.status(201).json(stay);
});

app.put('/api/accommodations/:id', async (req, res) => {
  const list = readAccommodations();
  const idx = list.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Stay not found' });
  const merged = { ...list[idx], ...req.body, id: req.params.id };
  if (!merged.city || !validStayDates(merged.check_in, merged.check_out)) {
    return res.status(400).json({ error: 'city, check_in and check_out (check_in < check_out) are required' });
  }
  if (!validTotalPrice(merged.total_price)) {
    return res.status(400).json({ error: 'total_price must be a non-negative number or null' });
  }

  if (merged.address !== list[idx].address) {
    const trimmed = (merged.address || '').trim();
    if (!trimmed) {
      merged.exact_lat = null;
      merged.exact_lon = null;
      merged.geocode_status = null;
    } else {
      const geocoded = await geocodeAddress(trimmed);
      if (geocoded) {
        merged.exact_lat = geocoded.lat;
        merged.exact_lon = geocoded.lon;
        merged.geocode_status = 'ok';
      } else {
        merged.exact_lat = null;
        merged.exact_lon = null;
        merged.geocode_status = 'failed';
      }
    }
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

const weatherStore = jsonStore(WEATHER_FILE, () => ({ computedFor: null, computedAt: null, byStay: {} }));

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

async function fetchDaily(baseUrl, lat, lon, start, end, extraFields = []) {
  const dailyFields = ['temperature_2m_max', 'temperature_2m_min', 'weathercode', ...extraFields].join(',');
  const url = `${baseUrl}?latitude=${lat}&longitude=${lon}` +
    `&daily=${dailyFields}&timezone=auto` +
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

function _hhmm(v) {
  return typeof v === 'string' && v.length >= 16 ? v.slice(11, 16) : null; // "2026-07-09T06:45" -> "06:45"
}

async function fetchForecastDays(lat, lon, start, end) {
  const daily = await fetchDaily('https://api.open-meteo.com/v1/forecast', lat, lon, start, end, ['sunrise', 'sunset']);
  if (!daily || !Array.isArray(daily.time)) return {};
  const out = {};
  daily.time.forEach((date, i) => {
    const tmax = daily.temperature_2m_max?.[i];
    const tmin = daily.temperature_2m_min?.[i];
    // Open-Meteo returns rows past its forecast horizon with null values —
    // skip them rather than emitting a bogus 0°/0° day (and never call
    // .slice on a null sunrise/sunset, which used to crash the whole run).
    if (tmax == null || tmin == null) return;
    const sunrise = _hhmm(daily.sunrise?.[i]);
    const sunset  = _hhmm(daily.sunset?.[i]);
    out[date] = {
      tempMax: Math.round(tmax),
      tempMin: Math.round(tmin),
      code:    daily.weathercode?.[i] ?? null,
      source:  'forecast',
      ...(sunrise && sunset ? { sunrise, sunset } : {}),
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
      if (!daily || !Array.isArray(daily.temperature_2m_max) || daily.temperature_2m_max[i] == null) continue;
      maxes.push(daily.temperature_2m_max[i]);
      mins.push(daily.temperature_2m_min[i]);
      if (daily.weathercode?.[i] != null) codes.push(daily.weathercode[i]);
    }
    if (!maxes.length) return;
    out[date] = {
      tempMax: Math.round(maxes.reduce((a, b) => a + b, 0) / maxes.length),
      tempMin: Math.round(mins.reduce((a, b) => a + b, 0) / mins.length),
      code:    codes.length ? mostFrequent(codes) : null,
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
  const prev = weatherStore.read().byStay || {};
  const byStay = {};
  // One stay's failed Open-Meteo call must not sink the whole recompute —
  // isolate each, and keep the previous data for any that fall over so a
  // transient error doesn't blank a stay's weather.
  await Promise.all(stays.map(async stay => {
    try {
      byStay[stay.id] = await weatherForStay(stay, today, horizonEnd);
    } catch (err) {
      console.error(`[weather] stay ${stay.id} (${stay.city}) failed: ${err.message}`);
      byStay[stay.id] = prev[stay.id] || {};
    }
  }));
  return { computedFor: today, computedAt: new Date().toISOString(), byStay };
}

app.get('/api/weather', async (req, res) => {
  try {
    let cache = weatherStore.read();
    if (cache.computedFor !== todayUTC()) {
      cache = await computeWeather();
      weatherStore.write(cache);
    }
    res.json(cache.byStay);
  } catch (err) {
    console.error(`[weather] recompute failed, serving cache: ${err.message}`);
    res.json(weatherStore.read().byStay || {});
  }
});

app.post('/api/weather/refresh', async (req, res) => {
  try {
    const cache = await computeWeather();
    weatherStore.write(cache);
    res.json({ computedFor: cache.computedFor, computedAt: cache.computedAt });
  } catch (err) {
    console.error(`[weather] refresh failed: ${err.message}`);
    res.status(502).json({ error: 'Weather refresh failed' });
  }
});

// Flights are persisted in data/flights.json (stable ids, editable fields
// like document_ids), synced against flighty.txt on every boot by natural
// key (flightNumber + departureDate) — flighty.txt itself is still static
// at runtime otherwise. A flight already in the persisted store keeps its
// id and any custom fields; only its live/tracked fields are refreshed. A
// persisted flight missing from a fresh parse is never auto-removed.
function syncFlights(parsed, persisted) {
  const byKey = new Map(persisted.map(f => [`${f.flightNumber}|${f.departureDate}`, f]));
  let nextNum = persisted.reduce((max, f) => {
    const m = /^f(\d+)$/.exec(f.id);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);

  const LIVE_FIELDS = [
    'airline', 'from', 'fromCity', 'to', 'toCity', 'departureDate',
    'departureTime', 'arrivalDate', 'arrivalTime', 'terminal', 'gate',
    'status', 'direction', 'flightyUrl',
  ];

  for (const flight of parsed) {
    const key = `${flight.flightNumber}|${flight.departureDate}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const field of LIVE_FIELDS) existing[field] = flight[field];
    } else {
      nextNum += 1;
      const created = { ...flight, id: `f${nextNum}`, document_ids: [] };
      persisted.push(created);
      byKey.set(key, created);
    }
  }
  return persisted;
}

const flightsStore = jsonStore(FLIGHTS_FILE, () => []);
flightsStore.write(syncFlights(parseFlightyText(fs.readFileSync(FLIGHTY_FILE, 'utf8')), flightsStore.read()));
// Flights only sync against flighty.txt at boot (see syncFlights doc comment
// above) — this timestamp is what "last synced" means for that data.
const serverBootTime = new Date().toISOString();

function readFlights()      { return flightsStore.read(); }
function writeFlights(list) { flightsStore.write(list); }

// One-time cleanup: trip.json's old `flights` array predates flights.json,
// is never read by anything (GET /api/flights always served the separately
// parsed constant, not this), and is actively misleading to leave in place.
(() => {
  const data = tripStore.read();
  if (data.flights !== undefined) {
    delete data.flights;
    tripStore.write(data);
  }
})();

app.get('/api/flights', (req, res) => {
  res.json(readFlights());
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
  const codes = [...new Set(readFlights().flatMap(f => [f.from, f.to]))];
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

// ── AI activity suggestions ────────────────────
// The model proposes a few things to do on a given trip day. Explicit-click
// only, tiny hand-built prompt, forced tool-schema response, re-sanitized
// server-side. Cost is capped two ways: 1 free fetch + 3 refreshes per
// day (then a 72h lock, cleared by TTL or the admin reset), and a global
// 50-calls / rolling-24h backstop. See
// docs/superpowers/specs/2026-09-02-ai-activity-suggestions-design.md.

const AI_MAX_REFRESHES_PER_DAY = 3;
const AI_MAX_BRIEFS_PER_DAY = 1; // free-text "advanced" searches, separate from refreshes
const AI_LOCK_MS = 72 * 60 * 60 * 1000;
const AI_GLOBAL_LIMIT = 50;
const AI_GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const AI_CATEGORIES = ['sightseeing', 'culture', 'outdoors', 'food', 'nightlife', 'shopping', 'daytrip'];
const AI_POOL_MAX = 20;      // suggestions kept per day across category combos
const AI_SUGGESTIONS_PER_CALL = 6;
// Map "AI ideas" layer: how many suggestion addresses to resolve per
// /pins request. Nominatim is gated to ~1 req/sec, so this bounds the
// worst-case response time; the rest resolve on the client's next poll.
const AI_PINS_GEOCODE_PER_REQUEST = 6;
const AI_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const AI_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const aiSuggestionsStore = jsonStore(AI_SUGGESTIONS_FILE, () => ({
  cache: {}, refreshes: {}, global: { windowStart: null, count: 0 },
}));
const aiFetchLimit = createLimiter(1); // serialise concurrent clicks

// The stay whose window covers `date` (check_in inclusive, check_out
// exclusive — the checkout day belongs to the next place / transit).
function aiActiveStay(date) {
  return readAccommodations().find(a => a.check_in <= date && date < a.check_out) || null;
}

function aiPlanHash(titles) {
  return crypto.createHash('sha1').update(titles.slice().sort().join('|')).digest('hex').slice(0, 8);
}

// Sorted, de-duped, whitelisted category list; '' when none selected.
function aiNormCategories(raw) {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  return [...new Set(list.map(c => String(c).trim().toLowerCase()))]
    .filter(c => AI_CATEGORIES.includes(c))
    .sort();
}
const aiCatKey = cats => cats.length ? cats.join(',') : 'all';

// Cache-combo key for a context. A free-text brief gets its own hashed
// slot so briefs never collide with each other or with category combos;
// otherwise it's the sorted category list (or 'all').
function aiComboKey(ctx) {
  if (ctx.brief) return 'brief:' + crypto.createHash('sha1').update(ctx.brief.toLowerCase()).digest('hex').slice(0, 8);
  return aiCatKey(ctx.categories);
}

function aiBuildContext(date, lang, categories, brief) {
  const stay = aiActiveStay(date);
  if (!stay || !stay.city) return null;
  const cleanBrief = String(brief ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const data = readData();
  const cal = data.calendar || [];
  const todayTitles = cal
    .filter(e => e.date === date && e.type !== 'accommodation' && e.title)
    .map(e => e.title.trim());
  const tripTitles = [...new Set(cal
    .filter(e => e.type !== 'accommodation' && e.title)
    .map(e => e.title.trim()))].slice(0, 20);
  const d = new Date(date + 'T00:00:00Z');
  return {
    date,
    lang: lang === 'es' ? 'es' : 'en',
    // A brief replaces the category chips — ignore any categories sent with it.
    categories: cleanBrief ? [] : aiNormCategories(categories),
    brief: cleanBrief,
    city: stay.city,
    country: stay.country || '',
    weekday: AI_WEEKDAYS[d.getUTCDay()],
    month: AI_MONTHS[d.getUTCMonth()],
    alreadyPlannedToday: todayTitles,
    alreadyPlannedTrip: tripTitles,
    planHash: aiPlanHash(todayTitles),
  };
}

function aiBuildPrompt(ctx) {
  const place = [ctx.city, ctx.country].filter(Boolean).join(', ');
  return [
    `City: ${place}`,
    `Date: ${ctx.date} (${ctx.weekday}, ${ctx.month})`,
    ctx.alreadyPlannedToday.length
      ? `Already planned that day: ${ctx.alreadyPlannedToday.join('; ')}`
      : `Nothing is planned that day yet.`,
    ctx.alreadyPlannedTrip.length
      ? `Already planned elsewhere on this trip: ${ctx.alreadyPlannedTrip.join('; ')}`
      : null,
    ctx.brief
      ? `The traveler is specifically looking for: "${ctx.brief}". Prioritise suggestions that match this. A strong nearby alternative is fine if it clearly fits.`
      : null,
    ctx.categories.length
      ? `Focus on these kinds of activities: ${ctx.categories.join(', ')}. One strong pick outside them is fine if it clearly stands out.`
      : null,
    `Reply language: ${ctx.lang}`,
    `For each suggestion give its address: street and number plus the city when you are confident of it, otherwise the most precise location you know (a square, landmark, or neighbourhood with the city). Also give approximate lat/lon when you are confident of them — especially for well-known landmarks that may not geocode cleanly from a name alone. Use null for any field you genuinely cannot provide.`,
    `Propose up to ${AI_SUGGESTIONS_PER_CALL} activities not already listed above. Write each reason as two or three sentences in the reply language.`,
  ].filter(Boolean).join('\n');
}

// Statuses worth retrying: rate limit, transient server errors, and
// Anthropic's 529 "overloaded". A 4xx like 400/401/403 is a real problem
// and retrying it just wastes time.
const AI_RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 529]);
const AI_RETRY_BACKOFF_MS = [800, 2200]; // one entry per retry after the first attempt

function aiRetryDelay(res, attempt) {
  const ra = Number(res?.headers?.get?.('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 10000);
  const base = AI_RETRY_BACKOFF_MS[attempt] ?? 3000;
  return Math.round(base * (0.75 + Math.random() * 0.5)); // ±25% jitter
}

// Returns an array of raw suggestion objects, or null on any failure
// (non-200, timeout, refusal, no tool_use block) so the caller can tell
// "the request didn't work" apart from "the model returned nothing".
// Retries transient failures (429 / 5xx / 529) with backoff before giving up.
async function aiCallModel(ctx) {
  return aiFetchLimit(async () => {
    const attempts = 1 + AI_RETRY_BACKOFF_MS.length;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await aiCallModelOnce(ctx);
      if (result.ok) return result.suggestions;
      if (result.retryable && attempt < attempts - 1) {
        const delay = aiRetryDelay(result.res, attempt);
        console.warn(`[ai-suggestions] retry ${attempt + 1}/${attempts - 1} after ${result.reason} — waiting ${delay}ms`);
        await sleep(delay);
        continue;
      }
      console.error(`[ai-suggestions] giving up after ${attempt + 1} attempt(s): ${result.reason}`);
      return null;
    }
    return null;
  });
}

// One request/response. Returns { ok: true, suggestions } or
// { ok: false, retryable, reason, res }.
async function aiCallModelOnce(ctx) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: AI_SUGGESTIONS_MODEL,
      max_tokens: 1700,
      system:
        'You are a local travel guide. Suggest real, well-known places or activities ' +
        'in the given city, appropriate for the date and season. Never repeat anything ' +
        'already planned. Prefer a variety of categories unless asked to focus. Each ' +
        'reason is two or three sentences: what it is, why it fits this day, one ' +
        'practical tip.',
      // Forced tool_choice already guarantees the call; aiSanitize() is
      // the real guarantee of a safe payload, so no `strict: true` here.
      tool_choice: { type: 'tool', name: 'propose_activities' },
      tools: [{
        name: 'propose_activities',
        description: `Return up to ${AI_SUGGESTIONS_PER_CALL} suggested activities for the day.`,
        input_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['suggestions'],
          properties: {
            suggestions: {
              type: 'array', maxItems: AI_SUGGESTIONS_PER_CALL,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'category', 'reason'],
                properties: {
                  name: { type: 'string' },
                  category: { type: 'string', enum: AI_CATEGORIES },
                  reason: { type: 'string' },
                  address: {
                    type: ['string', 'null'],
                    description: 'Street address (street + number + city) when known, else the most precise place (square/landmark/neighbourhood + city). null only if truly unplaceable.',
                  },
                  lat: { type: ['number', 'null'], description: 'Approximate WGS84 latitude of the place, when confidently known.' },
                  lon: { type: ['number', 'null'], description: 'Approximate WGS84 longitude of the place, when confidently known.' },
                  suggestedStartTime: { type: ['string', 'null'] },
                  durationHours: { type: ['number', 'null'] },
                },
              },
            },
          },
        },
      }],
      messages: [{ role: 'user', content: aiBuildPrompt(ctx) }],
    }),
  });
  } catch (err) {
    // AbortError (timeout) and network errors are worth one retry.
    return { ok: false, retryable: true, reason: `network/timeout: ${err.message}`, res: null };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const retryable = AI_RETRYABLE_STATUS.has(res.status);
    console.error(`[ai-suggestions] API ${res.status} for model "${AI_SUGGESTIONS_MODEL}": ${detail.slice(0, 500)}`);
    return { ok: false, retryable, reason: `API ${res.status}`, res };
  }
  let json;
  try { json = await res.json(); } catch (err) {
    return { ok: false, retryable: false, reason: `unparseable response: ${err.message}`, res };
  }
  if (json.stop_reason === 'refusal') {
    return { ok: false, retryable: false, reason: `model refused: ${JSON.stringify(json.stop_details || {})}`, res };
  }
  const tool = (json.content || []).find(b => b.type === 'tool_use');
  if (!Array.isArray(tool?.input?.suggestions)) {
    return { ok: false, retryable: false, reason: `no propose_activities tool_use block; stop_reason=${json.stop_reason}`, res };
  }
  return { ok: true, suggestions: tool.input.suggestions };
}

// Never trust the model's JSON — rebuild each item from a field whitelist
// with length / enum / format caps, drop anything invalid.
function aiSanitize(raw) {
  const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const name = clip(item.name, 80);
    if (!name) continue;
    const category = AI_CATEGORIES.includes(item.category) ? item.category : 'sightseeing';
    const reason = clip(item.reason, 400);
    const address = clip(item.address, 160) || null;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(item.suggestedStartTime) ? item.suggestedStartTime : null;
    const dur = (typeof item.durationHours === 'number' && Number.isFinite(item.durationHours)
      && item.durationHours > 0 && item.durationHours <= 12) ? item.durationHours : null;
    // Model-supplied coordinates — a fallback for places the address won't
    // geocode. Kept only when both are sane; otherwise both drop to null.
    const lat = (typeof item.lat === 'number' && Number.isFinite(item.lat) && Math.abs(item.lat) <= 90) ? item.lat : null;
    const lon = (typeof item.lon === 'number' && Number.isFinite(item.lon) && Math.abs(item.lon) <= 180) ? item.lon : null;
    const hasCoords = lat !== null && lon !== null;
    out.push({
      name, category, reason, address,
      lat: hasCoords ? lat : null, lon: hasCoords ? lon : null,
      suggestedStartTime: time, durationHours: dur,
    });
    if (out.length === AI_SUGGESTIONS_PER_CALL) break;
  }
  return out;
}

// Keep only well-formed combo entries. With `planHash` given, also drop
// combos from a stale day-plan — used on a Refresh write so an explicit
// Refresh after the plan changed genuinely resets the day; a plain
// (non-refresh) write keeps every combo regardless of plan, since opening
// the panel must never silently spend a model call.
function aiCleanDay(dayObj, planHash) {
  const out = {};
  for (const [k, v] of Object.entries(dayObj || {})) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.suggestions)) continue;
    if (planHash && v.planHash !== planHash) continue;
    out[k] = v;
  }
  return out;
}

// Union of every cached combo's suggestions for `date`, newest combo
// first, de-duped by name, capped. The client filters this pool by the
// selected categories locally; it only re-calls the model on an explicit
// Refresh or "get more".
function aiPoolForDay(cache, date) {
  const combos = Object.values((cache || {})[date] || {})
    .filter(c => c && typeof c === 'object' && Array.isArray(c.suggestions))
    .sort((a, b) => String(b.fetchedAt || '').localeCompare(String(a.fetchedAt || '')));
  const seen = new Set();
  const pool = [];
  for (const combo of combos) {
    for (const s of combo.suggestions) {
      const k = s.name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      pool.push(s);
      if (pool.length === AI_POOL_MAX) return pool;
    }
  }
  return pool;
}

// Roll the global 24h window if it has elapsed; returns the live counter.
function aiGlobalCounter(store) {
  const now = Date.now();
  const g = store.global || (store.global = { windowStart: null, count: 0 });
  if (!g.windowStart || now - Date.parse(g.windowStart) > AI_GLOBAL_WINDOW_MS) {
    g.windowStart = new Date(now).toISOString();
    g.count = 0;
  }
  return g;
}

app.post('/api/ai-suggestions', async (req, res) => {
  if (!AI_SUGGESTIONS_ENABLED) return res.status(404).json({ error: 'Not found' });

  const { date, refresh, more } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return res.status(400).json({ error: 'Invalid date' });
  }
  const trip = readData().trip;
  if (trip && (date < trip.startDate || date > trip.endDate)) {
    return res.status(400).json({ error: 'Date outside trip' });
  }
  const ctx = aiBuildContext(date, req.query.lang, req.body.categories, req.body.brief);
  if (!ctx) return res.status(400).json({ error: 'No city for this date' });
  const catKey = aiComboKey(ctx);

  const store = aiSuggestionsStore.read();
  store.cache ||= {}; store.refreshes ||= {};
  const dayCache = store.cache[date] || {};
  const briefsLeftFor = d => Math.max(0, AI_MAX_BRIEFS_PER_DAY - (store.refreshes[d]?.briefCount || 0));

  const respondCached = () => res.json({
    pool: aiPoolForDay(store.cache, date),
    refreshesLeft: (() => {
      const rec = store.refreshes[date];
      return rec ? Math.max(0, AI_MAX_REFRESHES_PER_DAY - rec.count) : AI_MAX_REFRESHES_PER_DAY;
    })(),
    briefsLeft: briefsLeftFor(date),
    pinned: aiPinnedNamesForDay(store, date),
    locked: false, lockedUntil: null,
  });

  // Fast path — never spend a model call unless the user explicitly asked:
  //  - a plain open: any cached combo for the day is enough (the client
  //    filters the pool locally, and a changed plan / category selection
  //    must not trigger a fetch);
  //  - a "get more" for a specific category combo, or a repeat of the same
  //    brief: only skip the call if that exact combo is already cached.
  if (!refresh) {
    const enough = (more || ctx.brief) ? dayCache[catKey] : Object.keys(dayCache).length > 0;
    if (enough) return respondCached();
  }

  // Global backstop — every real API call counts, success or failure.
  const g = aiGlobalCounter(store);
  if (g.count >= AI_GLOBAL_LIMIT) {
    aiSuggestionsStore.write(store);
    return res.status(429).json({
      error: 'Daily suggestion limit reached', scope: 'global',
      lockedUntil: new Date(Date.parse(g.windowStart) + AI_GLOBAL_WINDOW_MS).toISOString(),
    });
  }

  // Per-day gate. A free-text brief has its own small daily quota, kept
  // apart from the Refresh button's — reached here only on a cache miss.
  const rec = store.refreshes[date] || (store.refreshes[date] = { count: 0, lockedUntil: null });
  if (ctx.brief) {
    if ((rec.briefCount || 0) >= AI_MAX_BRIEFS_PER_DAY) {
      aiSuggestionsStore.write(store);
      return res.status(429).json({ error: 'Advanced search limit reached', scope: 'brief' });
    }
  } else if (refresh) {
    if (rec.lockedUntil && Date.parse(rec.lockedUntil) > Date.now()) {
      aiSuggestionsStore.write(store);
      return res.status(429).json({ error: 'Refresh limit reached', scope: 'day', lockedUntil: rec.lockedUntil });
    }
    if (rec.count >= AI_MAX_REFRESHES_PER_DAY) {
      rec.lockedUntil = new Date(Date.now() + AI_LOCK_MS).toISOString();
      aiSuggestionsStore.write(store);
      return res.status(429).json({ error: 'Refresh limit reached', scope: 'day', lockedUntil: rec.lockedUntil });
    }
  }

  g.count += 1;
  aiSuggestionsStore.write(store); // reserve the global slot before the call

  const raw = await aiCallModel(ctx);
  if (raw === null) {
    return res.status(502).json({ error: 'Suggestion request failed' });
  }
  const suggestions = aiSanitize(raw);

  const after = aiSuggestionsStore.read();
  after.cache ||= {}; after.refreshes ||= {};
  const recAfter = after.refreshes[date] || (after.refreshes[date] = { count: 0, lockedUntil: null });
  if (ctx.brief) recAfter.briefCount = (recAfter.briefCount || 0) + 1;
  else if (refresh) recAfter.count += 1;
  // A Refresh resets the day to the current plan; a plain fetch / "get
  // more" / brief merges into whatever is already cached, plan unchanged.
  const dayObj = aiCleanDay(after.cache[date], refresh ? ctx.planHash : null);
  dayObj[catKey] = { planHash: ctx.planHash, suggestions, fetchedAt: new Date().toISOString() };
  after.cache[date] = dayObj;
  aiSuggestionsStore.write(after);

  res.json({
    pool: aiPoolForDay(after.cache, date),
    refreshesLeft: Math.max(0, AI_MAX_REFRESHES_PER_DAY - recAfter.count),
    briefsLeft: Math.max(0, AI_MAX_BRIEFS_PER_DAY - (recAfter.briefCount || 0)),
    pinned: aiPinnedNamesForDay(after, date),
    locked: false, lockedUntil: null,
  });
});

app.post('/api/ai-suggestions/reset-limits', (req, res) => {
  if (!AI_SUGGESTIONS_ENABLED) return res.status(404).json({ error: 'Not found' });
  const store = aiSuggestionsStore.read();
  store.refreshes = {};
  store.global = { windowStart: null, count: 0 };
  store.geo = {};
  store.pinned = [];
  aiSuggestionsStore.write(store);
  res.json({ ok: true });
});

// ── Map "AI ideas" layer ───────────────────────
// Unlike the day panel (which works off the whole cached pool), the map
// shows only suggestions the traveller explicitly pinned with "Add to
// map". Pins live in store.pinned. A pin is placed from the model's own
// lat/lon when it gave them, otherwise by geocoding its address once
// (lazily, at Nominatim's ~1 req/sec) into the shared store.geo cache,
// which aiCleanDay never touches. A pinned suggestion is dropped
// automatically once a matching activity lands on the itinerary — the
// real activity pin then covers that spot.

const _aiGeoKey = a => String(a || '').trim().toLowerCase().slice(0, 160);
const _aiPinKey = (date, name) => `${date}|${String(name || '').trim().toLowerCase()}`;
const _aiIsNum = v => typeof v === 'number' && Number.isFinite(v);

// Coordinates for a pin: a successful address geocode wins (street-level),
// then the model's own lat/lon, else null (unplaceable).
function _aiResolvedCoords(store, p) {
  const addr = String(p.address || '').trim();
  if (addr) {
    const g = (store.geo || {})[_aiGeoKey(addr)];
    if (g && g.status === 'ok') return { lat: g.lat, lon: g.lon };
  }
  if (_aiIsNum(p.lat) && _aiIsNum(p.lon)) return { lat: p.lat, lon: p.lon };
  return null;
}

// Geocode one address into store.geo. `retryFailed` re-attempts a prior
// 'failed' entry — used on an explicit "Add to map" so the user's click
// is a real retry, but not on every map open.
async function _aiGeocodeOne(store, address, retryFailed) {
  const addr = String(address || '').trim();
  if (!addr) return;
  const gk = _aiGeoKey(addr);
  const existing = store.geo[gk];
  if (existing && (existing.status === 'ok' || !retryFailed)) return;
  const hit = await geocodeAddress(addr);
  store.geo[gk] = hit
    ? { lat: hit.lat, lon: hit.lon, status: 'ok', at: new Date().toISOString() }
    : { status: 'failed', at: new Date().toISOString() };
}

// Fuzzy title match, mirroring the client's _aiAlreadyAdded: equal, or
// either title contained in the other ("Louvre" ~ "Louvre Museum").
function _aiTitlesMatch(a, b) {
  a = String(a || '').trim().toLowerCase();
  b = String(b || '').trim().toLowerCase();
  return Boolean(a) && Boolean(b) && (a === b || a.includes(b) || b.includes(a));
}

function _aiSuggestionOnCalendar(name, calendar) {
  return (calendar || []).some(e => e.type !== 'accommodation' && _aiTitlesMatch(e.title, name));
}

// Lowercased names pinned to the map for a day — echoed back in the
// /api/ai-suggestions responses so the panel can show "On map" state.
function aiPinnedNamesForDay(store, date) {
  return (store.pinned || []).filter(p => p.date === date).map(p => String(p.name || '').toLowerCase());
}

// Locate a cached suggestion for a day by exact (case-insensitive) name.
function aiFindSuggestion(store, date, name) {
  const want = String(name || '').trim().toLowerCase();
  for (const combo of Object.values((store.cache || {})[date] || {})) {
    for (const s of (combo && Array.isArray(combo.suggestions) ? combo.suggestions : [])) {
      if (String(s.name || '').trim().toLowerCase() === want) return s;
    }
  }
  return null;
}

app.get('/api/ai-suggestions/pins', async (req, res) => {
  if (!AI_SUGGESTIONS_ENABLED) return res.status(404).json({ error: 'Not found' });
  const store = aiSuggestionsStore.read();
  store.geo ||= {};
  store.pinned ||= [];

  // Drop pins already committed to the itinerary.
  const calendar = readData().calendar || [];
  const kept = store.pinned.filter(p => !_aiSuggestionOnCalendar(p.name, calendar));
  let dirty = kept.length !== store.pinned.length;
  store.pinned = kept;

  // Resolve any address that still needs it (bounded per request; a prior
  // 'failed' is left alone — an explicit re-pin is what retries it).
  let budget = AI_PINS_GEOCODE_PER_REQUEST;
  for (const p of store.pinned) {
    if (budget <= 0) break;
    if (_aiResolvedCoords(store, p)) continue;
    if (!String(p.address || '').trim()) continue;
    budget--; dirty = true;
    await _aiGeocodeOne(store, p.address, false);
  }
  if (dirty) aiSuggestionsStore.write(store);

  const pins = [];
  let pending = 0;
  for (const p of store.pinned) {
    const c = _aiResolvedCoords(store, p);
    if (c) {
      pins.push({
        name: p.name, category: p.category, address: p.address || '',
        reason: p.reason || '', date: p.date, city: p.city || '',
        lat: c.lat, lon: c.lon,
      });
    } else {
      pending++;
    }
  }
  res.json({ pins, pending });
});

// "Add to map" — pin a cached suggestion for later. `placed` is false
// when neither the model's coordinates nor a geocode could locate it, so
// the client can warn instead of leaving a phantom pin.
app.post('/api/ai-suggestions/pins', async (req, res) => {
  if (!AI_SUGGESTIONS_ENABLED) return res.status(404).json({ error: 'Not found' });
  const { date, name } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !name) {
    return res.status(400).json({ error: 'Invalid date or name' });
  }
  const store = aiSuggestionsStore.read();
  store.geo ||= {};
  store.pinned ||= [];

  const s = aiFindSuggestion(store, date, name);
  if (!s) return res.status(404).json({ error: 'Suggestion not found' });

  const key = _aiPinKey(date, s.name);
  const existing = store.pinned.find(p => _aiPinKey(p.date, p.name) === key);
  const stay = aiActiveStay(date);
  const entry = existing || {
    date, name: s.name, category: s.category,
    address: String(s.address || '').trim(),
    reason: s.reason || '', city: stay ? stay.city : '',
    lat: _aiIsNum(s.lat) ? s.lat : null,
    lon: _aiIsNum(s.lon) ? s.lon : null,
    pinnedAt: new Date().toISOString(),
  };
  if (!existing) store.pinned.push(entry);

  await _aiGeocodeOne(store, entry.address, true);
  const placed = Boolean(_aiResolvedCoords(store, entry));

  // A brand-new pin that can't be located anywhere is not worth keeping.
  if (!placed && !existing) {
    store.pinned = store.pinned.filter(p => _aiPinKey(p.date, p.name) !== key);
  }
  aiSuggestionsStore.write(store);

  res.json({ ok: true, placed, pinned: aiPinnedNamesForDay(store, date) });
});

// "Remove from map" — unpin.
app.delete('/api/ai-suggestions/pins', (req, res) => {
  if (!AI_SUGGESTIONS_ENABLED) return res.status(404).json({ error: 'Not found' });
  const { date, name } = req.body || {};
  if (!date || !name) return res.status(400).json({ error: 'Invalid date or name' });
  const store = aiSuggestionsStore.read();
  store.pinned ||= [];
  const key = _aiPinKey(date, name);
  store.pinned = store.pinned.filter(p => _aiPinKey(p.date, p.name) !== key);
  aiSuggestionsStore.write(store);
  res.json({ ok: true, pinned: aiPinnedNamesForDay(store, date) });
});

// Update trip info
app.put('/api/trip', (req, res) => {
  const data = readData();
  data.trip = { ...data.trip, ...req.body };
  writeData(data);
  res.json(data.trip);
});

// Add a calendar entry
app.post('/api/calendar', async (req, res) => {
  const data = readData();
  const entry = {
    id: 'c' + Date.now(),
    ...req.body
  };
  const trimmed = (entry.address || '').trim();
  if (trimmed) {
    const geocoded = await geocodeAddress(trimmed);
    if (geocoded) {
      entry.lat = geocoded.lat;
      entry.lon = geocoded.lon;
      entry.geocode_status = 'ok';
    } else {
      entry.geocode_status = 'failed';
    }
  }
  data.calendar.push(entry);
  writeData(data);
  res.status(201).json(entry);
});

// Update a calendar entry
app.put('/api/calendar/:id', async (req, res) => {
  const data = readData();
  const idx = data.calendar.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Entry not found' });
  const merged = { ...data.calendar[idx], ...req.body, id: req.params.id };

  // Re-geocode whenever the address text actually changes — matches the
  // accommodations pattern, and avoids showing a pin at a stale location
  // (the hidden lat/lon fields in the edit modal carry over the previous
  // value regardless of address edits, so they can't be trusted here).
  if (merged.address !== data.calendar[idx].address) {
    const trimmed = (merged.address || '').trim();
    if (!trimmed) {
      merged.lat = null;
      merged.lon = null;
      merged.geocode_status = null;
    } else {
      const geocoded = await geocodeAddress(trimmed);
      if (geocoded) {
        merged.lat = geocoded.lat;
        merged.lon = geocoded.lon;
        merged.geocode_status = 'ok';
      } else {
        merged.lat = null;
        merged.lon = null;
        merged.geocode_status = 'failed';
      }
    }
  }

  data.calendar[idx] = merged;
  writeData(data);
  res.json(merged);
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
  const list = readFlights();
  const updated = mergeById(list, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Flight not found' });
  writeFlights(list);
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

const budgetStore = jsonStore(BUDGET_FILE, () => ({ initialBudget: 0, initialBudgetCurrency: 'EUR', entries: [] }));

// Backfills the per-entry `currency` field and the `initialBudgetCurrency`
// field (both new) from the old single global `currency` field, once, on
// first read of a pre-existing budget.json. Persists the backfill so it
// only ever runs once.
function readBudget() {
  const b = budgetStore.read();
  let dirty = false;
  if (!b.initialBudgetCurrency) {
    b.initialBudgetCurrency = b.currency || 'EUR';
    dirty = true;
  }
  if (b.currency !== undefined) {
    delete b.currency;
    dirty = true;
  }
  if (!Array.isArray(b.entries)) b.entries = [];
  for (const e of b.entries) {
    if (!e.currency) {
      e.currency = b.initialBudgetCurrency;
      dirty = true;
    }
  }
  if (dirty) writeBudget(b);
  return b;
}
function writeBudget(data)  { budgetStore.write(data); }

app.get('/api/budget', (req, res) => {
  res.json(readBudget());
});

app.put('/api/budget/settings', (req, res) => {
  const b = readBudget();
  if (req.body.initialBudget !== undefined) b.initialBudget = Number(req.body.initialBudget);
  if (req.body.initialBudgetCurrency)       b.initialBudgetCurrency = req.body.initialBudgetCurrency;
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
  if (!validRate(req.body.rate)) {
    return res.status(400).json({ error: 'rate must be a positive number or null' });
  }
  const b = readBudget();
  const currency = req.body.currency || b.initialBudgetCurrency;
  const manualRate = req.body.rate != null ? Number(req.body.rate) : null;
  const entry = {
    id:          'b' + Date.now(),
    date:        req.body.date,
    amount:      Number(req.body.amount),
    currency,
    // A manually-set rate always wins; otherwise, pin whatever override
    // is active right now for this currency (see activeOverrideRate) — this
    // is what makes an admin-panel override apply only to entries created
    // while it's enabled, never retroactively to existing entries.
    rate:        manualRate ?? activeOverrideRate(currency),
    category:    req.body.category || 'other',
    description: req.body.description || '',
    city:        req.body.city || '',
  };
  b.entries.push(entry);
  writeBudget(b);
  res.json(entry);
});

app.put('/api/budget/entries/:id', (req, res) => {
  if (!validRate(req.body.rate)) {
    return res.status(400).json({ error: 'rate must be a positive number or null' });
  }
  const b = readBudget();
  const updated = mergeById(b.entries, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'not found' });
  if (req.body.amount !== undefined) updated.amount = Number(req.body.amount);
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

// Backfills the per-item `currency` field (new), once, on first read of a
// pre-existing wishlist.json. Persists the backfill so it only runs once.
function readWishlist() {
  const w = wishlistStore.read();
  let dirty = false;
  if (!Array.isArray(w.items)) w.items = [];
  for (const i of w.items) {
    if (!i.currency) { i.currency = 'EUR'; dirty = true; }
  }
  if (dirty) writeWishlist(w);
  return w;
}
function writeWishlist(data) { wishlistStore.write(data); }

app.get('/api/wishlist', (req, res) => res.json(readWishlist()));

app.post('/api/wishlist', (req, res) => {
  const w = readWishlist();
  const item = {
    id:       'w' + Date.now(),
    name:     req.body.name || '',
    price:    Number(req.body.price) || 0,
    currency: req.body.currency || 'EUR',
    url:      req.body.url || '',
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

// ── Exchange rates ──────────────────────────────

const RATES_API_URL = 'https://open.er-api.com/v6/latest/USD';
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

const ratesStore = jsonStore(RATES_FILE, () => ({ base: 'USD', fetchedAt: null, rates: {}, overrideRules: {} }));

function readRates() {
  const r = ratesStore.read();
  if (!r.rates) r.rates = {};
  if (!r.overrideRules) r.overrideRules = {};
  return r;
}
function writeRates(data) { ratesStore.write(data); }

// An override rule affects two things: (1) it's the default suggested rate
// for a brand-new budget entry's own locked `rate` field (see
// POST /api/budget/entries), and (2) it's this currency's live `effective`
// rate everywhere else (effectiveRatesPayload → every _effectiveRate()-based
// conversion in currency.js: budget/wishlist/budget-insights totals, the
// currency calculator). A budget entry that already has its own locked
// `rate` is unaffected either way — toUSD's per-entry `rate` argument
// always takes priority over the currency-level effective rate, so
// enabling/disabling an override never retroactively changes an entry that
// was pinned to its own rate.
function activeOverrideRate(currency) {
  const rule = readRates().overrideRules[currency];
  return (rule && rule.enabled) ? rule.rate : null;
}

// Fetches fresh USD-base rates, or null on any failure. Callers must never
// overwrite an existing cache with a null result — a bad fetch (or, in this
// sandbox, this app's fetch()-doesn't-respect-the-proxy limitation) must
// never clobber good data, the same lesson already learned the hard way
// with data/weather.json.
async function fetchRatesFromApi() {
  try {
    const res = await fetch(RATES_API_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || json.result !== 'success' || typeof json.rates !== 'object') return null;
    return json.rates;
  } catch {
    return null;
  }
}

async function refreshRatesIfStale(force) {
  const r = readRates();
  const stale = force || !r.fetchedAt || (Date.now() - new Date(r.fetchedAt).getTime()) > RATES_TTL_MS;
  if (!stale) return r;
  const fetched = await fetchRatesFromApi();
  if (!fetched) return r;
  r.rates = fetched;
  r.fetchedAt = new Date().toISOString();
  writeRates(r);
  return r;
}

function effectiveRatesPayload(r) {
  const out = { base: 'USD', fetchedAt: r.fetchedAt, rates: {} };
  for (const code of Object.keys(r.rates)) {
    const rule = r.overrideRules[code];
    const effective = (rule && rule.enabled) ? rule.rate : r.rates[code];
    out.rates[code] = { fetched: r.rates[code], effective };
  }
  return out;
}

app.get('/api/rates', async (req, res) => {
  const r = await refreshRatesIfStale(false);
  res.json(effectiveRatesPayload(r));
});

app.put('/api/rates/override-rules/:currency', (req, res) => {
  const currency = req.params.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ error: 'currency must be a 3-letter code' });
  }
  const r = readRates();
  const existing = r.overrideRules[currency];
  const rate = req.body.rate !== undefined ? Number(req.body.rate) : existing?.rate;
  if (!(typeof rate === 'number' && Number.isFinite(rate) && rate > 0)) {
    return res.status(400).json({ error: 'rate must be a positive number' });
  }
  const enabled = req.body.enabled !== undefined ? Boolean(req.body.enabled) : (existing?.enabled ?? true);
  r.overrideRules[currency] = { rate, enabled };
  writeRates(r);
  res.json(r.overrideRules);
});

app.delete('/api/rates/override-rules/:currency', (req, res) => {
  const currency = req.params.currency.toUpperCase();
  const r = readRates();
  delete r.overrideRules[currency];
  writeRates(r);
  res.json(r.overrideRules);
});

app.post('/api/rates/refresh', async (req, res) => {
  const r = await refreshRatesIfStale(true);
  res.json(effectiveRatesPayload(r));
});

// ── Admin status ────────────────────────────────
// Read-only rollup for the hidden /admin page — every external data
// source the app depends on, in one place. Accommodations (accommodations.json)
// and calendar activities (trip.json's data.calendar, rendered as "place"
// pins by map.js) are geocoded independently, each with their own
// geocode_status, so they're tracked as separate collections here.
function geocodingSummary(items) {
  return {
    total: items.length,
    ok: items.filter(i => i.geocode_status === 'ok').length,
    failed: items.filter(i => i.geocode_status === 'failed').length,
    notAttempted: items.filter(i => !i.geocode_status).length,
  };
}

app.get('/api/admin/status', (req, res) => {
  const weather = weatherStore.read();
  const rates = readRates();
  const flights = readFlights();
  const airports = airportsStore.read();
  const accommodations = readAccommodations();
  const activities = readData().calendar || [];

  res.json({
    weather: {
      lastUpdated: weather.computedAt,
      staysTracked: Object.keys(weather.byStay || {}).length,
    },
    currency: {
      lastUpdated: rates.fetchedAt,
      currencyCount: Object.keys(rates.rates || {}).length,
      currencyCodes: Object.keys(rates.rates || {}).sort(),
      overrideCount: Object.keys(rates.overrideRules || {}).length,
      overrideRules: rates.overrideRules || {},
    },
    flights: {
      count: flights.length,
      lastSyncedAt: serverBootTime,
    },
    airports: {
      cachedCount: Object.keys(airports).length,
    },
    geocoding: {
      accommodations: geocodingSummary(accommodations),
      activities: geocodingSummary(activities),
    },
    aiSuggestions: aiStatusSummary(),
  });
});

// Rollup for the admin panel's "AI Suggestions" section.
function aiStatusSummary() {
  if (!AI_SUGGESTIONS_ENABLED) return { enabled: false };
  const store = aiSuggestionsStore.read();
  const g = store.global || {};
  const windowLive = g.windowStart && Date.now() - Date.parse(g.windowStart) <= AI_GLOBAL_WINDOW_MS;
  const now = Date.now();
  return {
    enabled: true,
    callsLast24h: windowLive ? (g.count || 0) : 0,
    callLimit: AI_GLOBAL_LIMIT,
    daysCached: Object.keys(store.cache || {}).length,
    lockedDays: Object.values(store.refreshes || {})
      .filter(r => r.lockedUntil && Date.parse(r.lockedUntil) > now).length,
  };
}

// Retries geocoding only for entries that don't already have a successful
// geocode — an address that's already 'ok' is left alone (matches the
// weather/currency refresh pattern of only refetching what's stale).
// Accommodations and calendar activities are separate collections with
// separate address fields, so both get retried here.
app.post('/api/geocode/refresh', async (req, res) => {
  const accommodations = readAccommodations();
  const accomCandidates = accommodations.filter(a => a.geocode_status !== 'ok' && (a.address || '').trim());
  await Promise.all(accomCandidates.map(async stay => {
    const geocoded = await geocodeAddress(stay.address.trim());
    if (geocoded) {
      stay.exact_lat = geocoded.lat;
      stay.exact_lon = geocoded.lon;
      stay.geocode_status = 'ok';
    } else {
      stay.exact_lat = null;
      stay.exact_lon = null;
      stay.geocode_status = 'failed';
    }
  }));
  writeAccommodations(accommodations);

  const data = readData();
  const activities = data.calendar || [];
  const activityCandidates = activities.filter(e => e.geocode_status !== 'ok' && (e.address || '').trim());
  await Promise.all(activityCandidates.map(async entry => {
    const geocoded = await geocodeAddress(entry.address.trim());
    if (geocoded) {
      entry.lat = geocoded.lat;
      entry.lon = geocoded.lon;
      entry.geocode_status = 'ok';
    } else {
      entry.lat = null;
      entry.lon = null;
      entry.geocode_status = 'failed';
    }
  }));
  writeData(data);

  res.json({
    accommodations: geocodingSummary(accommodations),
    activities: geocodingSummary(activities),
  });
});

// ── Travel documents ───────────────────────────
// Generic store for any URL-sourced document (rail passes, insurance,
// visas, ...) that needs to be opened from the app, including offline.
// The server downloads the source once at add-time and keeps its own
// copy — see docs/superpowers/specs/2026-07-10-travel-documents-design.md
// for why (the source PDFs force a download and block iframing).

if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

const documentsStore = jsonStore(DOCUMENTS_FILE, () => []);
function readDocuments()      { return documentsStore.read(); }
function writeDocuments(list) { documentsStore.write(list); }

function validDocumentDates(valid_from, valid_to) {
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  return ok(valid_from) && ok(valid_to) && valid_from <= valid_to;
}

app.get('/api/documents', (req, res) => res.json(readDocuments()));

app.post('/api/documents', async (req, res) => {
  const { title, source_url, valid_from, valid_to } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required' });
  if (!source_url || !/^https?:\/\//.test(source_url)) return res.status(400).json({ error: 'Invalid URL' });
  if (!validDocumentDates(valid_from, valid_to)) return res.status(400).json({ error: 'Invalid dates' });

  try {
    const { hostname } = new URL(source_url);
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (addresses.some(a => isPrivateAddress(a.address))) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    const resp = await fetch(source_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!resp.ok) return res.status(502).json({ error: `HTTP ${resp.status}` });
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.slice(0, 4).toString('ascii') !== '%PDF') {
      return res.status(502).json({ error: 'Not a PDF' });
    }

    const id = 'd' + Date.now();
    const filename = `${id}.pdf`;
    fs.writeFileSync(path.join(DOCUMENTS_DIR, filename), buf);

    const entry = {
      id, title: String(title).trim(), source_url, valid_from, valid_to,
      filename, added_at: new Date().toISOString(),
    };
    const list = readDocuments();
    list.push(entry);
    writeDocuments(list);
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Download failed' });
  }
});

app.put('/api/documents/:id', (req, res) => {
  const list = readDocuments();
  const existing = list.find(d => d.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Document not found' });

  const { title, valid_from, valid_to } = req.body;
  if (title !== undefined && !String(title).trim()) return res.status(400).json({ error: 'Title required' });
  const nextFrom = valid_from !== undefined ? valid_from : existing.valid_from;
  const nextTo   = valid_to   !== undefined ? valid_to   : existing.valid_to;
  if (!validDocumentDates(nextFrom, nextTo)) return res.status(400).json({ error: 'Invalid dates' });

  const patch = { valid_from: nextFrom, valid_to: nextTo };
  if (title !== undefined) patch.title = String(title).trim();
  const updated = mergeById(list, req.params.id, patch);
  writeDocuments(list);
  res.json(updated);
});

app.delete('/api/documents/:id', (req, res) => {
  const list = readDocuments();
  const doc = list.find(d => d.id === req.params.id);
  if (!doc || !removeById(list, req.params.id)) return res.status(404).json({ error: 'Document not found' });
  writeDocuments(list);
  try { fs.unlinkSync(path.join(DOCUMENTS_DIR, doc.filename)); } catch {}
  res.sendStatus(204);
});

app.get('/api/documents/:id/file', (req, res) => {
  const doc = readDocuments().find(d => d.id === req.params.id);
  if (!doc) return res.sendStatus(404);
  const filePath = path.join(DOCUMENTS_DIR, doc.filename);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  res.set('Content-Type', 'application/pdf');
  fs.createReadStream(filePath).pipe(res);
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

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') ||
      lower.startsWith('fe80') || lower.startsWith('::ffff:127.');
  }
  return true;
}

app.post('/api/wishlist/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const { hostname } = new URL(url);
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (addresses.some(a => isPrivateAddress(a.address))) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
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
    flights:        readFlights(),
    documents:      readDocuments(),
    flighty:        fs.readFileSync(FLIGHTY_FILE, 'utf8'),
  };
  res.setHeader('Content-Disposition', `attachment; filename="trip-export-${date}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload, null, 2));
});

app.get('/api/version', (req, res) => res.json({ commit: COMMIT, commitMessage: COMMIT_MESSAGE }));

app.get('/api/config', (req, res) => res.json({
  recommendationsEnabled: RECOMMENDATIONS_ENABLED,
  aiSuggestionsEnabled: AI_SUGGESTIONS_ENABLED,
}));

// Catch-all error handler — keeps error responses JSON instead of Express's
// default HTML/stack-trace page (data/*.json can be hand-edited concurrently
// and produce malformed JSON that throws on read).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Trip Planner running at http://localhost:${PORT}`);
});
