/* =============================================
   Trip Planner — App
   ============================================= */

// ── Theme ──────────────────────────────────────
(function () {
  const saved = localStorage.getItem('theme') ||
    (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
})();

document.getElementById('theme-toggle').addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  document.documentElement.setAttribute('data-theme', isLight ? 'dark' : 'light');
  localStorage.setItem('theme', isLight ? 'dark' : 'light');
});

let tripData = null;
let countdownInterval = null;

// ── Utilities ──────────────────────────────────

function parseLocal(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function parseDatetime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (timeStr) {
    const [h, mi] = timeStr.split(':').map(Number);
    return new Date(y, m - 1, d, h, mi);
  }
  return new Date(y, m - 1, d);
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, n) {
  const d = parseLocal(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function mondayOf(dateStr) {
  const d = parseLocal(dateStr);
  const dow = d.getDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return toDateStr(d);
}

function sundayOf(dateStr) {
  return addDays(mondayOf(dateStr), 6);
}

function formatTime(str) {
  const [h, m] = str.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function formatShort(str) {
  return fmtDate(str, { year: false });
}

function pad2(n) { return String(n).padStart(2, '0'); }

// ── Location colour palette ────────────────────
// Used when an accommodation entry has no `color` field set.

const PALETTE = [
  { bg: 'rgba(212,106,90,0.12)',  border: 'rgba(212,106,90,0.38)',  accent: '#d46a5a' }, // 0  coral       Buenos Aires 1
  { bg: 'rgba(80,136,200,0.12)',  border: 'rgba(80,136,200,0.38)',  accent: '#5088c8' }, // 1  blue        Buenos Aires 2
  { bg: 'rgba(200,178,48,0.12)',  border: 'rgba(200,178,48,0.38)',  accent: '#c8b230' }, // 2  golden      París 1 ← same color as París 2
  { bg: 'rgba(160,96,192,0.12)',  border: 'rgba(160,96,192,0.38)',  accent: '#a060c0' }, // 3  violet      Loutraki
  { bg: 'rgba(56,160,168,0.12)',  border: 'rgba(56,160,168,0.38)',  accent: '#38a0a8' }, // 4  teal        Viena
  { bg: 'rgba(208,80,112,0.12)',  border: 'rgba(208,80,112,0.38)',  accent: '#d05070' }, // 5  rose        Salzburgo
  { bg: 'rgba(120,176,56,0.12)',  border: 'rgba(120,176,56,0.38)',  accent: '#78b038' }, // 6  lime        Múnich
  { bg: 'rgba(80,96,200,0.12)',   border: 'rgba(80,96,200,0.38)',   accent: '#5060c8' }, // 7  periwinkle  Lauterbrunnen
  { bg: 'rgba(224,144,64,0.12)',  border: 'rgba(224,144,64,0.38)',  accent: '#e09040' }, // 8  orange      Zermatt
  { bg: 'rgba(192,80,160,0.12)',  border: 'rgba(192,80,160,0.38)',  accent: '#c050a0' }, // 9  fuchsia     Chamonix
  { bg: 'rgba(56,168,112,0.12)',  border: 'rgba(56,168,112,0.38)',  accent: '#38a870' }, // 10 emerald     Ámsterdam
  { bg: 'rgba(106,174,196,0.12)', border: 'rgba(106,174,196,0.38)', accent: '#6aaec4' }, // 11 glacier     Bruselas
  { bg: 'rgba(200,178,48,0.12)',  border: 'rgba(200,178,48,0.38)',  accent: '#c8b230' }, // 12 golden      París 2 ← same color as París 1
];

function hexToColour(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return {
    accent: hex,
    bg:     `rgba(${r},${g},${b},0.12)`,
    border: `rgba(${r},${g},${b},0.38)`,
  };
}

// Build a map keyed by check_in date → colour object
function buildColorMap(accommodations) {
  const map = {};
  accommodations.forEach((a, i) => {
    map[a.check_in] = a.color ? hexToColour(a.color) : PALETTE[i % PALETTE.length];
  });
  return map;
}

// Returns the active accommodation (if any) on a given day
function getActiveStay(accommodations, dayStr) {
  return accommodations.find(a => a.check_in <= dayStr && a.check_out > dayStr) || null;
}

// City name from accommodation entry
function locationLabel(stay) {
  return stay ? stay.city : '';
}

// ── Route Strip ────────────────────────────────

function renderRouteStrip(flights) {
  const strip = document.getElementById('route-strip');
  if (!strip) return;
  const sorted = [...flights].sort((a, b) => a.departureDate.localeCompare(b.departureDate));
  const airports = [];
  for (const f of sorted) {
    if (!airports.length || airports[airports.length - 1] !== f.from) airports.push(f.from);
    airports.push(f.to);
  }
  strip.innerHTML = airports
    .map((a, i) => i < airports.length - 1
      ? `<span class="route-apt">${a}</span><span class="route-arr">→</span>`
      : `<span class="route-apt">${a}</span>`)
    .join('');
}

// ── Info Bar ───────────────────────────────────

function renderInfoBar(trip, flights, calendar, accommodations) {
  // Countdown to first outbound departure
  const first = flights.find(f => f.direction === 'outbound') || flights[0];
  if (first) {
    const dep = parseDatetime(first.departureDate, first.departureTime || '00:00');
    function tick() {
      const diff = dep - Date.now();
      if (diff <= 0) {
        const segs = document.getElementById('cd-segments');
        if (segs) segs.hidden = true;
        document.getElementById('cd-sub').textContent = t('info.departed');
        clearInterval(countdownInterval);
        return;
      }
      const s = Math.floor(diff / 1000);
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sc = s % 60;
      document.getElementById('cd-days').textContent = d;
      document.getElementById('cd-hours').textContent = pad2(h);
      document.getElementById('cd-mins').textContent = pad2(m);
      document.getElementById('cd-secs').textContent = pad2(sc);
      document.getElementById('cd-sub').textContent =
        t('info.toFlight', { airport: first.from });
    }
    if (countdownInterval) clearInterval(countdownInterval);
    tick();
    countdownInterval = setInterval(tick, 1000);
  }

  // Next upcoming flight
  const now = new Date();
  const next = flights
    .filter(f => parseDatetime(f.departureDate, f.departureTime || '00:00') > now)
    .sort((a, b) =>
      parseDatetime(a.departureDate, a.departureTime || '00:00') -
      parseDatetime(b.departureDate, b.departureTime || '00:00')
    )[0];

  const flightEl = document.getElementById('info-flight-val');
  if (next) {
    const flightTime = next.departureTime ? ` · ${formatTime(next.departureTime)}` : '';
    const label = `${next.flightNumber} · ${next.from}→${next.to} · ${formatShort(next.departureDate)}${flightTime}`;
    if (next.flightyUrl) {
      flightEl.innerHTML = `<a href="${next.flightyUrl}" target="_blank" rel="noopener" class="info-flight-link">${label}</a>`;
    } else {
      flightEl.textContent = label;
    }
  } else {
    flightEl.textContent = t('info.noUpcomingFlights');
  }

  // Active or next accommodation
  const today = toDateStr(new Date());
  const stayEl = document.getElementById('info-stay-val');
  const active = getActiveStay(accommodations, today);
  if (active) {
    stayEl.textContent = t('info.stayUntil', { city: active.city, date: formatShort(active.check_out) });
  } else {
    const nextStay = accommodations
      .filter(a => a.check_in > today)
      .sort((a, b) => a.check_in.localeCompare(b.check_in))[0];
    if (nextStay) {
      const nights = Math.round((parseLocal(nextStay.check_out) - parseLocal(nextStay.check_in)) / 86400000);
      stayEl.textContent = t('info.nextStay', { city: nextStay.city, date: formatShort(nextStay.check_in), nights });
    } else {
      stayEl.textContent = t('info.noUpcomingStays');
    }
  }
}

// ── Planner helpers ────────────────────────────

const CHIPS_MAX = 4;

function renderChips(container, chips, max) {
  container.innerHTML = '';
  const count = max === Infinity ? chips.length : Math.min(chips.length, max);
  for (let i = 0; i < count; i++) {
    const c = chips[i];
    const el = document.createElement('span');
    el.className = `chip chip--${c.type}`;
    el.textContent = c.label;
    el.title = c.label;
    if (c.id)  el.dataset.id  = c.id;
    if (c.url) el.dataset.url = c.url;
    container.appendChild(el);
  }
  if (max !== Infinity && chips.length > max) {
    const m = document.createElement('span');
    m.className = 'chip chip--more';
    m.textContent = t('chip.more', { n: chips.length - max });
    container.appendChild(m);
  }
}

function toggleCardExpand(card, expand) {
  const chipsEl = card.querySelector('.day-chips');
  const chips = JSON.parse(card.dataset.chips || '[]');
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

// ── Planner Grid ───────────────────────────────

function renderPlanner() {
  const { trip, flights, calendar, accommodations } = tripData;
  const colorMap = tripData.colorMap || buildColorMap(accommodations);

  // Span full weeks containing trip start and end
  const gridStart = mondayOf(trip.startDate);
  const gridEnd   = sundayOf(trip.endDate);
  const today     = toDateStr(new Date());

  // Build array of all days
  const days = [];
  let cur = gridStart;
  while (cur <= gridEnd) { days.push(cur); cur = addDays(cur, 1); }

  const grid = document.getElementById('planner-grid');
  grid.innerHTML = '';

  // Sort calendar events by time for consistent display
  const calByDate = {};
  for (const e of calendar) {
    if (e.type === 'accommodation') continue; // handled separately
    const key = e.date;
    if (key) {
      if (!calByDate[key]) calByDate[key] = [];
      calByDate[key].push(e);
    }
  }
  // Sort each day's events by startTime
  for (const k in calByDate) {
    calByDate[k].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  }

  for (const dayStr of days) {
    const inTrip = dayStr >= trip.startDate && dayStr <= trip.endDate;
    const isToday = dayStr === today;
    const date = parseLocal(dayStr);
    const dayNum = date.getDate();
    const isMonthStart = dayNum === 1;

    // Active accommodation → card colour
    const stay = getActiveStay(accommodations, dayStr);
    const colour = stay ? colorMap[stay.check_in] : null;

    // Build chips list
    const chips = [];

    // Flights departing today
    for (const f of flights) {
      if (f.departureDate !== dayStr) continue;
      const t = f.departureTime ? ` ${formatTime(f.departureTime)}` : '';
      chips.push({ type: 'flight', label: `${f.flightNumber} ${f.from}→${f.to}${t}`, id: null, url: f.flightyUrl || null });
    }

    // Trains departing today
    for (const tr of (tripData.trains || [])) {
      if (tr.departureDate !== dayStr) continue;
      const t = tr.departureTime ? ` ${formatTime(tr.departureTime)}` : '';
      chips.push({ type: 'train', label: `${tr.fromCity}→${tr.toCity}${t}`, id: null });
    }

    // Accommodation check-in / check-out (from accommodations.json)
    for (const a of accommodations) {
      if (a.check_in === dayStr) {
        chips.push({ type: 'stay', label: t('chip.checkin', { city: a.city }), id: null, url: a.url || null });
      } else if (a.check_out === dayStr) {
        chips.push({ type: 'stay', label: t('chip.checkout', { city: a.city }), id: null });
      }
    }

    // Events & activities
    for (const e of (calByDate[dayStr] || [])) {
      const t = e.startTime ? ` ${formatTime(e.startTime)}` : '';
      chips.push({ type: e.type, label: `${e.title}${t}`, id: e.id });
    }

    // Card element
    const card = document.createElement('div');
    const isPast = inTrip && dayStr < today;
    card.className = `day-card${isToday ? ' is-today' : ''}${!inTrip ? ' out-of-trip' : ''}${isPast ? ' is-past' : ''}`;
    card.dataset.date = dayStr;
    card.dataset.chips = JSON.stringify(chips);

    if (colour && inTrip) {
      card.style.setProperty('--day-bg',     colour.bg);
      card.style.setProperty('--day-border', colour.border);
      card.style.setProperty('--day-accent', colour.accent);
    }

    // Header
    const head = document.createElement('div');
    head.className = 'day-card-head';
    const numEl = document.createElement('span');
    numEl.className = 'day-num';
    numEl.textContent = dayNum;
    head.appendChild(numEl);
    const dowEl = document.createElement('span');
    dowEl.className = 'day-dow';
    dowEl.textContent = date.toLocaleDateString(getDateLocale(), { weekday: 'short' });
    head.appendChild(dowEl);
    if (isMonthStart || dayStr === trip.startDate) {
      const monEl = document.createElement('span');
      monEl.className = 'day-mon';
      monEl.textContent = date.toLocaleDateString(getDateLocale(), { month: 'short' });
      head.appendChild(monEl);
    }
    card.appendChild(head);

    // Location label (every day of an active stay)
    if (stay && colour) {
      const loc = document.createElement('div');
      loc.className = 'day-location';
      loc.textContent = locationLabel(stay);
      card.appendChild(loc);
    }

    // Chips (initial collapsed view)
    const chipsEl = document.createElement('div');
    chipsEl.className = 'day-chips';
    renderChips(chipsEl, chips, CHIPS_MAX);
    card.appendChild(chipsEl);

    // Click: chip with id → edit; chip with url → open link; card body → expand/collapse
    card.addEventListener('click', e => {
      if (!inTrip) return;
      if (e.target.closest('.day-add-btn')) return;
      const chipEl = e.target.closest('.chip[data-id]');
      if (chipEl) { openEditModal(chipEl.dataset.id); return; }
      const linkChip = e.target.closest('.chip[data-url]');
      if (linkChip) { window.open(linkChip.dataset.url, '_blank', 'noopener'); return; }

      const isExpanded = card.classList.contains('expanded');
      document.querySelectorAll('.day-card.expanded').forEach(c => {
        if (c !== card) toggleCardExpand(c, false);
      });
      toggleCardExpand(card, !isExpanded);
    });

    grid.appendChild(card);
  }

  // Legend
  renderLegend(accommodations, colorMap);
}

// ── Legend ─────────────────────────────────────

function renderLegend(accommodations, colorMap) {
  const existing = document.getElementById('planner-legend');
  if (existing) existing.remove();

  if (!accommodations.length) return;

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.id = 'planner-legend';

  for (const a of accommodations) {
    const colour = colorMap[a.check_in];
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <div class="legend-dot" style="background:${colour.accent};"></div>
      <span>${a.city} <span style="color:var(--text-3)">${formatShort(a.check_in)}–${formatShort(a.check_out)}</span></span>
    `;
    legend.appendChild(item);
  }

  document.querySelector('.app-main').appendChild(legend);
}

// ── Modal ──────────────────────────────────────

const $  = id => document.getElementById(id);
const modal = {
  overlay:   $('modal-overlay'),
  titleEl:   $('modal-title'),
  form:      $('modal-form'),
  id:        $('entry-id'),
  title:     $('entry-title'),
  date:      $('entry-date'),
  startDate: $('entry-start-date'),
  endDate:   $('entry-end-date'),
  startTime: $('entry-start-time'),
  endTime:   $('entry-end-time'),
  address:   $('entry-address'),
  notes:     $('entry-notes'),
  singleRow: $('single-date-row'),
  multiRow:  $('multi-date-row'),
  deleteBtn: $('btn-delete-entry'),
  typeSel:   $('type-selector'),
};

function getType() {
  return modal.typeSel.querySelector('.type-btn.active')?.dataset.type || 'activity';
}
function setType(type) {
  modal.typeSel.querySelectorAll('.type-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type)
  );
  modal.singleRow.hidden = type === 'accommodation';
  modal.multiRow.hidden  = type !== 'accommodation';
}

modal.typeSel.addEventListener('click', e => {
  const btn = e.target.closest('.type-btn');
  if (btn) setType(btn.dataset.type);
});

function openAddModal(defaultDate) {
  modal.form.reset();
  modal.id.value = '';
  modal.titleEl.textContent = t('modal.addTitle');
  modal.deleteBtn.hidden = true;
  setType('activity');
  if (defaultDate) modal.date.value = defaultDate;
  modal.overlay.hidden = false;
  setTimeout(() => modal.title.focus(), 50);
}

function openEditModal(id) {
  const e = tripData.calendar.find(x => x.id === id);
  if (!e) return;
  modal.form.reset();
  modal.id.value = e.id;
  modal.titleEl.textContent = t('modal.editTitle');
  modal.deleteBtn.hidden = false;
  setType(e.type);
  modal.title.value   = e.title || '';
  modal.address.value = e.address || '';
  modal.notes.value   = e.notes || '';
  if (e.type === 'accommodation') {
    modal.startDate.value = e.startDate || '';
    modal.endDate.value   = e.endDate || '';
  } else {
    modal.date.value      = e.date || '';
    modal.startTime.value = e.startTime || '';
    modal.endTime.value   = e.endTime || '';
  }
  modal.overlay.hidden = false;
  setTimeout(() => modal.title.focus(), 50);
}

function closeModal() { modal.overlay.hidden = true; }

$('modal-close').addEventListener('click', closeModal);
$('btn-cancel').addEventListener('click', closeModal);
modal.overlay.addEventListener('click', e => { if (e.target === modal.overlay) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modal.overlay.hidden) closeModal();
});

modal.form.addEventListener('submit', async e => {
  e.preventDefault();
  const type = getType();
  const id = modal.id.value;
  const payload = {
    type,
    title:   modal.title.value.trim(),
    address: modal.address.value.trim(),
    notes:   modal.notes.value.trim(),
  };
  if (type === 'accommodation') {
    payload.startDate = modal.startDate.value;
    payload.endDate   = modal.endDate.value;
  } else {
    payload.date      = modal.date.value;
    payload.startTime = modal.startTime.value;
    payload.endTime   = modal.endTime.value;
  }
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
    renderInfoBar(tripData.trip, tripData.flights, tripData.calendar, tripData.accommodations);
  } catch { alert(t('modal.saveFailed')); }
});

$('btn-delete-entry').addEventListener('click', async () => {
  const id = modal.id.value;
  if (!id || !confirm(t('modal.confirmDelete'))) return;
  try {
    await fetch(`/api/calendar/${id}`, { method: 'DELETE' });
    tripData.calendar = tripData.calendar.filter(x => x.id !== id);
    closeModal();
    renderPlanner();
    renderInfoBar(tripData.trip, tripData.flights, tripData.calendar, tripData.accommodations);
  } catch { alert(t('modal.deleteFailed')); }
});

$('btn-add-activity').addEventListener('click', () => {
  const today = toDateStr(new Date());
  const def = today >= tripData.trip.startDate && today <= tripData.trip.endDate
    ? today
    : tripData.trip.startDate;
  openAddModal(def);
});

// ── Boot ───────────────────────────────────────

async function init() {
  await initI18n();
  try {
    const [tripRes, accomRes, flightsRes, trainsRes] = await Promise.all([
      fetch('/api/trip'),
      fetch('/api/accommodations'),
      fetch('/api/flights'),
      fetch('/api/trains'),
    ]);
    tripData = await tripRes.json();
    tripData.accommodations = await accomRes.json();
    tripData.flights = await flightsRes.json();
    tripData.trains  = await trainsRes.json();
    tripData.colorMap = buildColorMap(tripData.accommodations);
    document.getElementById('trip-name').textContent = tripData.trip.name;
    document.getElementById('trip-destination').textContent = tripData.trip.destination;
    document.title = tripData.trip.name;
    renderRouteStrip(tripData.flights);
    renderInfoBar(tripData.trip, tripData.flights, tripData.calendar, tripData.accommodations);
    renderPlanner();
    if (typeof renderMap  === 'function') renderMap(tripData.flights, tripData.trains);
    if (typeof initBudget === 'function') initBudget(tripData);
  } catch (err) {
    console.error(err);
    document.getElementById('planner-grid').textContent = t('planner.failed');
  }
}

document.addEventListener('langchange', () => {
  if (!tripData) return;
  renderPlanner();
  renderInfoBar(tripData.trip, tripData.flights, tripData.calendar, tripData.accommodations);
});

init();
