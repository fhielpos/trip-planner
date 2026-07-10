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

// Dev override: open the app with ?today=2026-10-06 to preview any trip day.
// Param name matched case-insensitively — browsers/mobile keyboards often
// auto-capitalize the first letter of a manually-typed query string.
const DEV_DATE = (() => {
  let v = null;
  for (const [k, val] of new URLSearchParams(location.search)) {
    if (k.toLowerCase() === 'today') { v = val; break; }
  }
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
})();

function appToday() {
  return DEV_DATE || toDateStr(new Date());
}

// ── Location colour palette ────────────────────
// Fallback pool for stays with no `color` field; existing stays carry an
// explicit color in accommodations.json (the file is sorted by check_in on
// every write, so index-based colours would shift otherwise).

const PALETTE = [
  { bg: 'rgba(212,106,90,0.12)',  border: 'rgba(212,106,90,0.38)',  accent: '#d46a5a' }, // coral
  { bg: 'rgba(200,178,48,0.12)',  border: 'rgba(200,178,48,0.38)',  accent: '#c8b230' }, // golden
  { bg: 'rgba(160,96,192,0.12)',  border: 'rgba(160,96,192,0.38)',  accent: '#a060c0' }, // violet
  { bg: 'rgba(56,160,168,0.12)',  border: 'rgba(56,160,168,0.38)',  accent: '#38a0a8' }, // teal
  { bg: 'rgba(208,80,112,0.12)',  border: 'rgba(208,80,112,0.38)',  accent: '#d05070' }, // rose
  { bg: 'rgba(120,176,56,0.12)',  border: 'rgba(120,176,56,0.38)',  accent: '#78b038' }, // lime
  { bg: 'rgba(80,96,200,0.12)',   border: 'rgba(80,96,200,0.38)',   accent: '#5060c8' }, // periwinkle
  { bg: 'rgba(224,144,64,0.12)',  border: 'rgba(224,144,64,0.38)',  accent: '#e09040' }, // orange
  { bg: 'rgba(192,80,160,0.12)',  border: 'rgba(192,80,160,0.38)',  accent: '#c050a0' }, // fuchsia
  { bg: 'rgba(56,168,112,0.12)',  border: 'rgba(56,168,112,0.38)',  accent: '#38a870' }, // emerald
  { bg: 'rgba(106,174,196,0.12)', border: 'rgba(106,174,196,0.38)', accent: '#6aaec4' }, // glacier
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

// WMO weathercode → emoji, bucketed rather than a full per-code table.
function weatherIcon(code) {
  if (code === 0) return '☀️';
  if (code === 1 || code === 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 95) return '⛈️';
  if (code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82) return '❄️';
  return '🌧️';
}

// Looks up a stay+day's weather entry from tripData.weather (byStay → date map).
function getWeather(stayId, dayStr) {
  return tripData?.weather?.[stayId]?.[dayStr] || null;
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

function renderInfoBar() {
  const { flights, accommodations } = tripData;

  // Countdown to first outbound departure
  const first = flights.find(f => f.direction === 'outbound') || flights[0];
  if (first) {
    const dep = parseDatetime(first.departureDate, first.departureTime || '00:00');
    const segsEl = document.getElementById('cd-segments');
    const subEl  = document.getElementById('cd-sub');
    const daysEl = document.getElementById('cd-days');
    const hrsEl  = document.getElementById('cd-hours');
    const minEl  = document.getElementById('cd-mins');
    const secEl  = document.getElementById('cd-secs');
    function tick() {
      const diff = dep - Date.now();
      if (diff <= 0) {
        if (segsEl) segsEl.hidden = true;
        subEl.textContent = t('info.departed');
        clearInterval(countdownInterval);
        return;
      }
      const s = Math.floor(diff / 1000);
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sc = s % 60;
      daysEl.textContent = d;
      hrsEl.textContent  = pad2(h);
      minEl.textContent  = pad2(m);
      secEl.textContent  = pad2(sc);
      subEl.textContent  = t('info.toFlight', { airport: first.from });
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
  const today = appToday();
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
let chipsByDate = {}; // dayStr → chips[], rebuilt each renderPlanner()

function renderChips(container, chips, max) {
  container.innerHTML = '';
  const shown = chips.slice(0, max);
  for (const c of shown) {
    const el = document.createElement('span');
    el.className = `chip chip--${c.type}`;
    el.textContent = c.label;
    el.title = c.label;
    if (c.id)  el.dataset.id  = c.id;
    if (c.url) el.dataset.url = c.url;
    container.appendChild(el);
  }
  if (chips.length > shown.length) {
    const m = document.createElement('span');
    m.className = 'chip chip--more';
    m.textContent = t('chip.more', { n: chips.length - shown.length });
    container.appendChild(m);
  }
}

// Day-cards are only ~172px wide in the 7-column desktop grid — far too
// narrow for a recommendation card's name/category/link/Add button. The
// panel is appended to <body> instead of the card, positioned to float
// near the triggering button but clamped to stay on-screen, so it isn't
// constrained by the card's own width. (Absolute, not fixed, positioning:
// document-relative coordinates so it scrolls naturally with the page.)
function _positionFloatingPanel(panel, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 24);
  let left = rect.left + window.scrollX;
  const maxLeft = window.scrollX + window.innerWidth - width - 12;
  if (left > maxLeft) left = maxLeft;
  if (left < window.scrollX + 12) left = window.scrollX + 12;
  panel.style.width = `${width}px`;
  panel.style.left = `${left}px`;
  panel.style.top = `${rect.bottom + window.scrollY + 6}px`;
}

function _closeDayRecsPanel(dateStr) {
  document.querySelector(`.day-recs-panel[data-for="${dateStr}"]`)?.remove();
}

function toggleCardExpand(card, expand) {
  const chipsEl = card.querySelector('.day-chips');
  const chips = chipsByDate[card.dataset.date] || [];
  let addBtn  = card.querySelector('.day-add-btn');
  let recsBtn = card.querySelector('.day-recs-btn');

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
    if (stay && tripData.config?.recommendationsEnabled && !recsBtn) {
      recsBtn = document.createElement('button');
      recsBtn.className = 'day-add-btn day-recs-btn';
      recsBtn.textContent = t('recommendations.seeLink');
      recsBtn.addEventListener('click', e => {
        e.stopPropagation();
        const dateStr = card.dataset.date;
        const existing = document.querySelector(`.day-recs-panel[data-for="${dateStr}"]`);
        if (existing) { existing.remove(); return; }

        const panel = document.createElement('div');
        panel.className = 'day-recs-panel';
        panel.dataset.for = dateStr;
        panel.addEventListener('click', ev => ev.stopPropagation());
        document.body.appendChild(panel);
        _positionFloatingPanel(panel, recsBtn);
        renderRecommendations(panel, stay.id, dateStr);

        // Close on an outside click, but not the same click that opened it.
        setTimeout(() => {
          document.addEventListener('click', function onOutside(ev) {
            if (!panel.contains(ev.target) && ev.target !== recsBtn) {
              panel.remove();
              document.removeEventListener('click', onOutside);
            }
          });
        }, 0);
      });
      card.appendChild(recsBtn);
    }
  } else {
    card.classList.remove('expanded');
    renderChips(chipsEl, chips, CHIPS_MAX);
    if (addBtn) addBtn.remove();
    _closeDayRecsPanel(card.dataset.date);
    if (recsBtn) recsBtn.remove();
  }
}

// ── Planner Grid ───────────────────────────────

function renderPlanner() {
  const { trip, flights, calendar, accommodations, colorMap } = tripData;
  chipsByDate = {};

  // Span full weeks containing trip start and end
  const gridStart = mondayOf(trip.startDate);
  const gridEnd   = sundayOf(trip.endDate);
  const today     = appToday();

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
      const time = f.departureTime ? ` ${formatTime(f.departureTime)}` : '';
      chips.push({ type: 'flight', label: `${f.flightNumber} ${f.from}→${f.to}${time}`, id: null, url: f.flightyUrl || null });
    }

    // Trains departing today
    for (const tr of tripData.trains) {
      if (tr.departureDate !== dayStr) continue;
      const time = tr.departureTime ? ` ${formatTime(tr.departureTime)}` : '';
      chips.push({ type: 'train', label: `${tr.fromCity}→${tr.toCity}${time}`, id: null });
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
      const time = e.startTime ? ` ${formatTime(e.startTime)}` : '';
      chips.push({ type: e.type, label: `${e.title}${time}`, id: e.id });
    }

    // Card element
    const card = document.createElement('div');
    const isPast = inTrip && dayStr < today;
    card.className = `day-card${isToday ? ' is-today' : ''}${!inTrip ? ' out-of-trip' : ''}${isPast ? ' is-past' : ''}`;
    card.dataset.date = dayStr;
    chipsByDate[dayStr] = chips;

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
      const cityEl = document.createElement('span');
      cityEl.className = 'day-location-city';
      cityEl.textContent = stay.city;
      loc.appendChild(cityEl);
      const w = getWeather(stay.id, dayStr);
      if (w) {
        const wEl = document.createElement('span');
        wEl.className = 'day-weather';
        wEl.textContent = `${weatherIcon(w.code)} ${w.tempMax}°`;
        if (w.source === 'historical') wEl.title = t('weather.historicalTooltip');
        loc.appendChild(wEl);
      }
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

  if (typeof renderStaysTimeline === 'function') renderStaysTimeline(tripData);
  if (typeof renderToday === 'function') renderToday(tripData);
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
  overlay:    $('modal-overlay'),
  titleEl:    $('modal-title'),
  form:       $('modal-form'),
  id:         $('entry-id'),
  lat:        $('entry-lat'),
  lon:        $('entry-lon'),
  title:      $('entry-title'),
  titleLabel: $('entry-title-label'),
  date:       $('entry-date'),
  startDate:  $('entry-start-date'),
  endDate:    $('entry-end-date'),
  startTime:  $('entry-start-time'),
  endTime:    $('entry-end-time'),
  url:        $('entry-url'),
  address:    $('entry-address'),
  notes:      $('entry-notes'),
  singleRow:  $('single-date-row'),
  multiRow:   $('multi-date-row'),
  timeRow:    $('time-row'),
  urlRow:     $('url-row'),
  addressRow: $('address-row'),
  notesRow:   $('notes-row'),
  deleteBtn:  $('btn-delete-entry'),
  typeSel:    $('type-selector'),
};

function getType() {
  return modal.typeSel.querySelector('.type-btn.active')?.dataset.type || 'activity';
}
function setType(type) {
  const isStay = type === 'accommodation';
  modal.typeSel.querySelectorAll('.type-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type)
  );
  modal.singleRow.hidden  = isStay;
  modal.multiRow.hidden   = !isStay;
  modal.timeRow.hidden    = isStay;
  modal.urlRow.hidden     = !isStay;
  modal.addressRow.hidden = isStay;
  modal.notesRow.hidden   = isStay;
  modal.date.required      = !isStay;
  modal.startDate.required = isStay;
  modal.endDate.required   = isStay;
  modal.titleLabel.textContent = t(isStay ? 'modal.cityLabel' : 'modal.titleLabel');
  modal.title.placeholder      = t(isStay ? 'modal.cityPlaceholder' : 'modal.titlePlaceholder');
}

// Stays live in accommodations.json, calendar entries in trip.json — an
// existing entry cannot change store, so lock the type buttons accordingly.
function lockTypeButtons(kind) {
  modal.typeSel.querySelectorAll('.type-btn').forEach(b => {
    const isStayBtn = b.dataset.type === 'accommodation';
    b.disabled = kind === 'stay' ? !isStayBtn : kind === 'calendar' ? isStayBtn : false;
  });
}

modal.typeSel.addEventListener('click', e => {
  const btn = e.target.closest('.type-btn');
  if (btn) setType(btn.dataset.type);
});

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

function openEditModal(id) {
  const e = tripData.calendar.find(x => x.id === id);
  if (!e) return;
  modal.form.reset();
  modal.id.value = e.id;
  modal.form.dataset.kind = 'calendar';
  modal.titleEl.textContent = t('modal.editTitle');
  modal.deleteBtn.hidden = false;
  lockTypeButtons('calendar');
  setType(e.type);
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
  const a = tripData.accommodations.find(x => x.id === id);
  if (!a) return;
  modal.form.reset();
  modal.id.value = a.id;
  modal.form.dataset.kind = 'stay';
  modal.titleEl.textContent = t('modal.editTitle');
  modal.deleteBtn.hidden = false;
  lockTypeButtons('stay');
  setType('accommodation');
  modal.title.value     = a.city || '';
  modal.startDate.value = a.check_in || '';
  modal.endDate.value   = a.check_out || '';
  modal.url.value       = a.url || '';
  modal.overlay.hidden = false;
  setTimeout(() => modal.title.focus(), 50);
}

// Refetch stays after a write so ordering, colours and derived views stay canonical.
async function reloadAccommodations() {
  const r = await fetch('/api/accommodations');
  tripData.accommodations = await r.json();
  tripData.colorMap = buildColorMap(tripData.accommodations);
  renderPlanner();
  renderInfoBar();
}

function closeModal() { modal.overlay.hidden = true; }

// Wires click-outside-to-close and Escape-to-close for a modal overlay.
// Shared across app.js/budget.js/wishlist.js so every modal behaves the same way.
function wireModal(overlay, closeFn) {
  overlay.addEventListener('click', e => { if (e.target === overlay) closeFn(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) closeFn();
  });
}

$('modal-close').addEventListener('click', closeModal);
$('btn-cancel').addEventListener('click', closeModal);
wireModal(modal.overlay, closeModal);

modal.form.addEventListener('submit', async e => {
  e.preventDefault();
  const type = getType();
  const id = modal.id.value;

  if (type === 'accommodation') {
    const payload = {
      city:      modal.title.value.trim(),
      check_in:  modal.startDate.value,
      check_out: modal.endDate.value,
      url:       modal.url.value.trim() || null,
    };
    try {
      const r = await fetch(id ? `/api/accommodations/${id}` : '/api/accommodations', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error();
      closeModal();
      await reloadAccommodations();
    } catch { alert(t('modal.saveFailed')); }
    return;
  }

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

$('btn-delete-entry').addEventListener('click', async () => {
  const id = modal.id.value;
  if (!id || !confirm(t('modal.confirmDelete'))) return;
  try {
    if (modal.form.dataset.kind === 'stay') {
      const r = await fetch(`/api/accommodations/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error();
      closeModal();
      await reloadAccommodations();
      return;
    }
    await fetch(`/api/calendar/${id}`, { method: 'DELETE' });
    tripData.calendar = tripData.calendar.filter(x => x.id !== id);
    closeModal();
    renderPlanner();
    renderInfoBar();
  } catch { alert(t('modal.deleteFailed')); }
});

$('btn-add-activity').addEventListener('click', () => {
  const today = appToday();
  const def = today >= tripData.trip.startDate && today <= tripData.trip.endDate
    ? today
    : tripData.trip.startDate;
  openAddModal(def);
});

// ── Boot ───────────────────────────────────────

async function init() {
  await initI18n();
  try {
    // /api/trip already includes trains; only accommodations, the
    // freshly-parsed flighty.txt flights, airport coordinates (looked up
    // for whatever codes those flights use), and operator-set config need
    // their own requests.
    const [tripRes, accomRes, flightsRes, airportsRes, configRes, documentsRes] = await Promise.all([
      fetch('/api/trip'),
      fetch('/api/accommodations'),
      fetch('/api/flights'),
      fetch('/api/airports'),
      fetch('/api/config'),
      fetch('/api/documents'),
    ]);
    tripData = await tripRes.json();
    tripData.accommodations = await accomRes.json();
    tripData.flights = await flightsRes.json();
    tripData.airports = await airportsRes.json();
    tripData.config = await configRes.json();
    tripData.documents = await documentsRes.json();
    tripData.colorMap = buildColorMap(tripData.accommodations);
    document.getElementById('trip-name').textContent = tripData.trip.name;
    document.getElementById('trip-destination').textContent = tripData.trip.destination;
    document.title = tripData.trip.name;
    renderRouteStrip(tripData.flights);
    renderInfoBar();
    renderPlanner();
    if (typeof renderMap  === 'function') renderMap(tripData.flights, tripData.trains, tripData.accommodations, tripData.airports, tripData.calendar);
    // initWishlist renders prices via budget.js's formatCurrency, which reads
    // module-level state that initBudget sets up — must await, not fire concurrently.
    if (typeof initBudget    === 'function') await initBudget(tripData);
    if (typeof initWishlist  === 'function') initWishlist();

    // Fetched separately, off the critical path: a cache-miss day can take
    // several seconds to compute server-side (many Open-Meteo calls), and
    // the rest of the app shouldn't wait on it.
    fetch('/api/weather').then(r => r.json()).then(weather => {
      tripData.weather = weather;
      renderPlanner();
      if (typeof renderToday === 'function') renderToday(tripData);
    }).catch(() => {});
  } catch (err) {
    console.error(err);
    document.getElementById('planner-grid').textContent = t('planner.failed');
  }
}

document.addEventListener('langchange', () => {
  if (!tripData) return;
  renderPlanner();
  renderInfoBar();
});

init();
