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

    // Direction: classify by home airports; ambiguous legs resolved below
    let direction = 'connection';
    if (HOME_AIRPORTS.has(fromCode)) direction = 'outbound';
    else if (HOME_AIRPORTS.has(toCode)) direction = 'return';

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

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Get all trip data
app.get('/api/trip', (req, res) => {
  res.json(readData());
});

// Get accommodations (read from file; edit the JSON directly to change)
app.get('/api/accommodations', (req, res) => {
  res.json(JSON.parse(fs.readFileSync(ACCOM_FILE, 'utf8')));
});

// Get flights parsed from flighty.txt export
app.get('/api/flights', (req, res) => {
  const text = fs.readFileSync(FLIGHTY_FILE, 'utf8');
  res.json(parseFlightyText(text));
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
  const idx = data.calendar.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Entry not found' });
  data.calendar[idx] = { ...data.calendar[idx], ...req.body };
  writeData(data);
  res.json(data.calendar[idx]);
});

// Delete a calendar entry
app.delete('/api/calendar/:id', (req, res) => {
  const data = readData();
  const idx = data.calendar.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Entry not found' });
  data.calendar.splice(idx, 1);
  writeData(data);
  res.status(204).end();
});

// Update a flight
app.put('/api/flights/:id', (req, res) => {
  const data = readData();
  const idx = data.flights.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Flight not found' });
  data.flights[idx] = { ...data.flights[idx], ...req.body };
  writeData(data);
  res.json(data.flights[idx]);
});

// ── Trains ─────────────────────────────────────

app.get('/api/trains', (req, res) => {
  const data = readData();
  res.json(data.trains || []);
});

app.post('/api/trains', (req, res) => {
  const data = readData();
  if (!data.trains) data.trains = [];
  const train = { id: 't' + Date.now(), ...req.body };
  data.trains.push(train);
  writeData(data);
  res.status(201).json(train);
});

app.put('/api/trains/:id', (req, res) => {
  const data = readData();
  if (!data.trains) data.trains = [];
  const idx = data.trains.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Train not found' });
  data.trains[idx] = { ...data.trains[idx], ...req.body };
  writeData(data);
  res.json(data.trains[idx]);
});

app.delete('/api/trains/:id', (req, res) => {
  const data = readData();
  if (!data.trains) data.trains = [];
  const idx = data.trains.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Train not found' });
  data.trains.splice(idx, 1);
  writeData(data);
  res.status(204).end();
});

// ── Budget ─────────────────────────────────────

function readBudget() {
  if (!fs.existsSync(BUDGET_FILE)) return { initialBudget: 0, currency: 'EUR', entries: [] };
  return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
}
function writeBudget(data) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(data, null, 2));
}

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
  const idx = b.entries.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  b.entries[idx] = { ...b.entries[idx], ...req.body, id: req.params.id, amount: Number(req.body.amount) };
  writeBudget(b);
  res.json(b.entries[idx]);
});

app.delete('/api/budget/entries/:id', (req, res) => {
  const b = readBudget();
  b.entries = b.entries.filter(e => e.id !== req.params.id);
  writeBudget(b);
  res.sendStatus(204);
});

// ── Wishlist ────────────────────────────────────

function readWishlist() {
  if (!fs.existsSync(WISHLIST_FILE)) return { items: [] };
  return JSON.parse(fs.readFileSync(WISHLIST_FILE, 'utf8'));
}
function writeWishlist(data) {
  fs.writeFileSync(WISHLIST_FILE, JSON.stringify(data, null, 2));
}

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
  const idx = w.items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  w.items[idx] = { ...w.items[idx], ...req.body, id: req.params.id };
  if (req.body.price !== undefined) w.items[idx].price = Number(req.body.price);
  writeWishlist(w);
  res.json(w.items[idx]);
});

app.delete('/api/wishlist/:id', (req, res) => {
  const w = readWishlist();
  w.items = w.items.filter(i => i.id !== req.params.id);
  writeWishlist(w);
  res.sendStatus(204);
});

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

    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"'<>]+)["']/i)?.[1]
                 || html.match(/<meta[^>]+content=["']([^"'<>]+)["'][^>]+property=["']og:title["']/i)?.[1];
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    let rawName = _decodeHtmlEntities((ogTitle || titleTag || '').trim());
    rawName = rawName.split(/\s+[|\-–—]\s+/)[0].trim().substring(0, 200);

    // 1. Open Graph / meta tags
    let priceStr =
      html.match(/<meta[^>]+property=["']og:price:amount["'][^>]+content=["']([^"'<>]+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"'<>]+)["'][^>]+property=["']og:price:amount["']/i)?.[1]
      || html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"'<>]+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"'<>]+)["'][^>]+property=["']product:price:amount["']/i)?.[1]
      || null;

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

app.get('/api/version', (req, res) => res.json({ commit: COMMIT }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Trip Planner running at http://localhost:${PORT}`);
});
