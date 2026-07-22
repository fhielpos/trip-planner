/* =============================================
   Today View — trip-day landing panel
   Visible only while today (or ?today=) falls
   inside the trip dates.
   ============================================= */

const COUNTRY_FLAG_CODES = {
  Argentina: 'AR', Brazil: 'BR', France: 'FR', Greece: 'GR', Austria: 'AT',
  Germany: 'DE', Switzerland: 'CH', Netherlands: 'NL', Belgium: 'BE',
  Spain: 'ES', Italy: 'IT', Portugal: 'PT', 'United Kingdom': 'GB', 'United States': 'US',
};

function countryFlag(country) {
  const cc = COUNTRY_FLAG_CODES[country];
  if (!cc) return '';
  return String.fromCodePoint(...[...cc].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

// Documents attached to a flight/train's document_ids, resolved against the
// full documents list. Never throws on a stale/missing id (see delete flow
// in itinerary.js — leg cleanup on document delete isn't guaranteed atomic
// with every possible edge case, so resolution here stays defensive).
function docsForLeg(documents, document_ids) {
  if (!document_ids || !document_ids.length) return [];
  return document_ids.map(id => (documents || []).find(d => d.id === id)).filter(Boolean);
}

// Date-matched events for one day, in day order:
// check-outs, then flights/trains by departure time, then check-ins.
function collectTodayEvents(data, today) {
  const events = [];
  for (const a of data.accommodations || []) {
    if (a.check_out === today)
      events.push({ order: 0, time: '', icon: '🧳', label: t('chip.checkout', { city: a.city }), url: a.url || null, docs: [] });
  }
  for (const f of data.flights || []) {
    if (f.departureDate !== today) continue;
    const extras = [f.terminal && `T${f.terminal}`, f.gate && `G${f.gate}`].filter(Boolean).join(' ');
    const label = `${f.flightNumber} · ${f.from}→${f.to} · ${formatTime(f.departureTime)}${extras ? ' · ' + extras : ''}`;
    events.push({ order: 1, time: f.departureTime || '', icon: '✈', label, url: f.flightyUrl || null, docs: docsForLeg(data.documents, f.document_ids) });
  }
  for (const tr of data.trains || []) {
    if (tr.departureDate !== today) continue;
    const time = tr.departureTime ? ` · ${formatTime(tr.departureTime)}` : '';
    events.push({ order: 1, time: tr.departureTime || '', icon: '🚆', label: `${tr.fromCity} → ${tr.toCity}${time}`, url: tr.url || null, docs: docsForLeg(data.documents, tr.document_ids) });
  }
  for (const a of data.accommodations || []) {
    if (a.check_in === today)
      events.push({ order: 2, time: '', icon: '🛏', label: t('chip.checkin', { city: a.city }), url: a.url || null, docs: [] });
  }
  events.sort((a, b) => a.order - b.order || a.time.localeCompare(b.time));
  return events;
}

// Split a day's activities into main entries and their backups.
// Backups follow the `<parentId>-bk` id convention from the itinerary data.
function collectTodayActivities(calendar, today) {
  const todays = (calendar || []).filter(e => e.date === today && e.type !== 'accommodation');
  todays.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  const byId = Object.fromEntries(todays.map(e => [e.id, e]));
  const items = [];
  for (const e of todays) {
    if (e.id.endsWith('-bk') && byId[e.id.slice(0, -3)]) continue; // rendered under parent
    const backup = byId[`${e.id}-bk`] || null;
    items.push({ main: e, backup });
  }
  return items;
}

// All of a day's activity: check-ins/outs, flights/trains, activities+backups
// (icon-prefixed), in the same order the Day Sheet and mobile Calendar show
// them. Distinct from collectTodayEvents (which excludes activities) and
// collectTodayActivities (which excludes checkins/flights/trains) — this is
// the union, used wherever a single day needs its full agenda in one list.
function dayEvents(date, data) {
  const rows = [];
  for (const a of data.accommodations || []) {
    if (a.check_out === date) rows.push({ icon: '🧳', title: t('chip.checkout', { city: a.city }) });
  }
  for (const f of data.flights || []) {
    if (f.departureDate === date) rows.push({ icon: '✈', title: `${f.from} → ${f.to} · ${formatTime(f.departureTime)}` });
  }
  for (const tr of data.trains || []) {
    if (tr.departureDate === date) rows.push({ icon: '🚆', title: `${tr.fromCity} → ${tr.toCity}` });
  }
  for (const a of data.accommodations || []) {
    if (a.check_in === date) rows.push({ icon: '🛏', title: t('chip.checkin', { city: a.city }) });
  }
  for (const { main, backup } of collectTodayActivities(data.calendar, date)) {
    rows.push({ icon: '◦', title: main.title });
    if (backup) rows.push({ icon: '↻', title: backup.title });
  }
  return rows;
}

// Documents whose validity window includes `today` (YYYY-MM-DD).
function collectActiveDocuments(documents, today) {
  return (documents || []).filter(d => d.valid_from <= today && today <= d.valid_to);
}

// Dev-only: jump the `?today=` override by `delta` days and reload.
function goToDevDay(delta) {
  const url = new URL(location.href);
  url.searchParams.set('today', addDays(DEV_DATE, delta));
  location.href = url.toString();
}

// Header badge, always visible (even once scrolled past the Today hero)
// showing the country of whichever stay is active right now.
function _renderPassportStamp(stay) {
  const el = document.getElementById('passport-stamp');
  if (!el) return;
  if (!stay || !stay.country) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="passport-stamp-flag">${countryFlag(stay.country)}</span>${stay.country}`;
}

function renderToday(data) {
  const section = document.getElementById('today-section');
  if (!section || !data?.trip) return;

  const today = appToday();
  const inTrip = today >= data.trip.startDate && today <= data.trip.endDate;
  document.body.classList.toggle('today-active', inTrip);
  section.hidden = false;
  if (!inTrip) {
    _renderPassportStamp(null);
    if (typeof renderTodayPreTrip === 'function') renderTodayPreTrip(section, data);
    else section.innerHTML = '';
    return;
  }

  const stay = getActiveStay(data.accommodations || [], today);
  _renderPassportStamp(stay);
  const colour = stay ? (data.colorMap?.[stay.check_in] ?? null) : null;
  section.style.setProperty('--today-accent', colour?.accent || 'var(--accent)');
  section.style.setProperty('--today-bg', colour?.bg || 'var(--accent-dim)');

  // No active stay only happens on a checkout day with no same-day check-in
  // (the final day of the trip) — fall back to the departing stay's image.
  const imageStay = stay || (data.accommodations || []).find(a => a.check_out === today);
  section.style.setProperty('--today-image', imageStay?.image ? `url(/images/${imageStay.image})` : 'none');
  section.classList.toggle('has-image', Boolean(imageStay?.image));

  const dayNum = Math.round((parseLocal(today) - parseLocal(data.trip.startDate)) / 86400000) + 1;
  const totalDays = Math.round((parseLocal(data.trip.endDate) - parseLocal(data.trip.startDate)) / 86400000) + 1;
  const dateLabel = parseLocal(today).toLocaleDateString(getDateLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const lastNight = stay && stay.check_out === addDays(today, 1);

  const flag = stay ? countryFlag(stay.country) : '';
  const heroCity = stay ? `${flag ? flag + ' ' : ''}${stay.city}` : t('today.transit');

  const w = stay ? getWeather(stay.id, today) : null;
  const weatherLine = w
    ? `${w.source === 'historical' ? '~' : ''}${weatherIcon(w.code)} ${w.tempMax}°/${w.tempMin}°`
    : null;
  const sunTimes = (w && w.sunrise && w.sunset)
    ? `<span class="today-suntimes">🌅 ${w.sunrise} · 🌇 ${w.sunset}</span>`
    : '';

  const events = collectTodayEvents(data, today);
  const acts = collectTodayActivities(data.calendar, today);
  const activeDocs = collectActiveDocuments(data.documents, today);

  const eventRow = e => `
    <div class="today-row">
      <span class="today-row-icon">${e.icon}</span>
      <span class="today-row-label">${e.label}</span>
      ${e.url ? `<a class="today-row-link" href="${e.url}" target="_blank" rel="noopener">↗</a>` : ''}
      ${e.docs.map(d => `<a class="today-row-link" href="/api/documents/${d.id}/file" target="_blank" rel="noopener" title="${d.title}">📄</a>`).join('')}
    </div>`;

  const actRow = ({ main, backup }) => {
    const time = main.startTime ? `${formatTime(main.startTime)} · ` : '';
    return `
    <div class="today-row today-row--act" data-id="${main.id}">
      <span class="today-row-icon">◦</span>
      <span class="today-row-label">${time}${main.title}</span>
    </div>
    ${backup ? `
    <div class="today-row today-row--backup" data-id="${backup.id}">
      <span class="today-row-icon">↻</span>
      <span class="today-row-label">${backup.title}</span>
    </div>` : ''}`;
  };

  const budget = typeof getTodayBudget === 'function' ? getTodayBudget() : null;
  const budgetLine = budget
    ? (budget.dailyLeft
        ? t('today.budgetLine', { spent: budget.spent, daily: budget.dailyLeft })
        : t('today.spentToday', { spent: budget.spent }))
    : null;

  if (isMobileViewport()) {
    renderTodayMobileInTrip(section, data, { stay, today, dayNum, totalDays, weatherLine, sunTimes, lastNight, heroCity, acts, activeDocs, budget });
    registerMobileRerender(() => renderToday(data));
    return;
  }

  section.innerHTML = `
    <div class="today-inner">
      ${DEV_DATE ? `
      <div class="today-dev-nav">
        <button type="button" class="today-dev-arrow" id="today-dev-prev" aria-label="previous day">‹</button>
        <span class="today-dev">DEV · ${DEV_DATE}</span>
        <button type="button" class="today-dev-arrow" id="today-dev-next" aria-label="next day">›</button>
      </div>` : ''}
      <div class="today-hero">
        <h2 class="today-city">${heroCity}</h2>
        <div class="today-sub">${t('budget.stats.dayOf', { day: dayNum, total: totalDays })} · ${dateLabel}</div>
        ${weatherLine ? `<div class="today-weather"${w.source === 'historical' ? ` title="${t('weather.historicalTooltip')}"` : ''}>${weatherLine}${sunTimes}</div>` : ''}
        ${lastNight ? `<div class="today-lastnight">${t('today.lastNight')}</div>` : ''}
      </div>
      ${events.length ? `
      <div class="today-block">
        <h3 class="today-block-title">${t('today.events')}</h3>
        ${events.map(eventRow).join('')}
      </div>` : ''}
      ${acts.length ? `
      <div class="today-block">
        <h3 class="today-block-title">${t('today.activities')}</h3>
        ${acts.map(actRow).join('')}
      </div>` : ''}
      ${activeDocs.length ? `
      <div class="today-block">
        <h3 class="today-block-title">${t('documents.title')}</h3>
        ${activeDocs.map(d => `
        <div class="today-row">
          <span class="today-row-icon">📄</span>
          <span class="today-row-label">${d.title}</span>
          <a class="today-row-link" href="/api/documents/${d.id}/file" target="_blank" rel="noopener">↗</a>
        </div>`).join('')}
      </div>` : ''}
      ${imageStay && data.config?.recommendationsEnabled ? `
      <div class="today-block today-recs-block">
        <button type="button" class="today-recs-toggle" id="today-recs-toggle">${t('recommendations.seeLink')}</button>
        <div class="today-recs-panel" id="today-recs-panel" hidden></div>
      </div>` : ''}
      ${budgetLine ? `<button type="button" class="today-budget" id="today-budget">💶 ${budgetLine}</button>` : ''}
      <button type="button" class="today-scroll-hint" id="today-scroll-hint" aria-label="calendar">⌄</button>
    </div>`;

  section.querySelectorAll('.today-row[data-id]').forEach(row =>
    row.addEventListener('click', () => openEditModal(row.dataset.id))
  );
  section.querySelector('#today-budget')?.addEventListener('click', () =>
    document.querySelector('.budget-section')?.scrollIntoView({ behavior: 'smooth' })
  );
  section.querySelector('#today-scroll-hint')?.addEventListener('click', () => {
    const target = document.querySelector('.day-card.is-today') || document.querySelector('.info-bar');
    if (!target) return;
    const headerHeight = document.querySelector('.app-header')?.getBoundingClientRect().height || 0;
    const top = target.getBoundingClientRect().top + window.scrollY - headerHeight - 8;
    window.scrollTo({ top, behavior: 'smooth' });
  });
  section.querySelector('#today-dev-prev')?.addEventListener('click', () => goToDevDay(-1));
  section.querySelector('#today-dev-next')?.addEventListener('click', () => goToDevDay(1));

  const recsToggle = section.querySelector('#today-recs-toggle');
  const recsPanel  = section.querySelector('#today-recs-panel');
  recsToggle?.addEventListener('click', () => {
    const opening = recsPanel.hidden;
    recsPanel.hidden = !opening;
    if (opening && !recsPanel.dataset.loaded) {
      recsPanel.dataset.loaded = '1';
      renderRecommendations(recsPanel, imageStay.id, today);
    }
  });
}

function renderTodayMobileInTrip(section, data, ctx) {
  const { stay, today, dayNum, totalDays, weatherLine, sunTimes, lastNight, heroCity, acts, activeDocs, budget } = ctx;
  const flag = stay ? countryFlag(stay.country) : '';
  const countryLabel = stay ? `${flag} ${stay.country}` : t('today.transit');
  const wishlistItems = typeof getWishlistItems === 'function' ? getWishlistItems() : [];

  const weekDays = _buildTripDays(data).filter(d => d.date >= today).slice(0, 4);

  section.innerHTML = `
    <div class="mtoday-hero">
      <div class="mtoday-hero-top">
        <span class="mtoday-pill">${countryLabel}</span>
        <span class="mtoday-pill mtoday-pill--accent">${t('budget.stats.dayOf', { day: dayNum, total: totalDays })}</span>
      </div>
      <div class="mtoday-hero-bottom">
        <div class="mtoday-city">${heroCity}</div>
        <div class="mtoday-hero-meta">
          ${weatherLine ? `<span class="mtoday-weather">${weatherLine}</span>${sunTimes}` : ''}
          ${lastNight ? `<span class="mtoday-lastnight">${t('today.lastNight')}</span>` : ''}
        </div>
      </div>
    </div>

    ${acts.length ? `
    <div class="mtoday-block">
      <h3 class="mtoday-block-title">${t('today.events')}</h3>
      ${acts.map(({ main, backup }) => `
        <div class="mtoday-row mtoday-row--activity" data-id="${main.id}">
          <span class="mtoday-row-icon">◦</span>
          <div class="mtoday-row-body"><div class="mtoday-row-title">${main.startTime ? formatTime(main.startTime) + ' · ' : ''}${main.title}</div></div>
        </div>
        ${backup ? `
        <div class="mtoday-row mtoday-row--backup" data-id="${backup.id}">
          <span class="mtoday-row-icon">↻</span>
          <div class="mtoday-row-body"><div class="mtoday-row-title">${backup.title}</div></div>
        </div>` : ''}
      `).join('')}
    </div>` : ''}

    ${activeDocs.length ? `
    <div class="mtoday-block">
      <h3 class="mtoday-block-title">${t('documents.title')} <span class="mtoday-block-count">· ${activeDocs.length} ${t('documents.active')}</span></h3>
      ${activeDocs.map(d => `
        <button type="button" class="mtoday-doc-row" data-doc-id="${d.id}">
          <span class="mtoday-doc-badge">📄</span>
          <div class="mtoday-doc-body">
            <div class="mtoday-doc-title">${d.title}</div>
            <div class="mtoday-doc-sub">${t('documents.validRange', { from: fmtDate(d.valid_from, { year: false }), to: fmtDate(d.valid_to, { year: false }) })}</div>
          </div>
          <span class="mtoday-doc-chevron">›</span>
        </button>
      `).join('')}
    </div>` : ''}

    <div class="mtoday-block">
      <div class="mtoday-block-header">
        <h3 class="mtoday-block-title">${t('today.thisWeek')}</h3>
        <button type="button" class="mtoday-link" data-goto-tab="calendar">${t('today.seeFullMonth')}</button>
      </div>
      <div class="mtoday-strip">
        ${weekDays.map(d => `
          <button type="button" class="mtoday-strip-card${d.date === today ? ' is-today' : ''}" data-open-day="${d.date}">
            <span class="mtoday-strip-dow">${d.dow} ${d.num}</span>
            <span class="mtoday-strip-sub">${_escHtml(d.label)}</span>
          </button>
        `).join('')}
      </div>
    </div>

    <div class="mtoday-block">
      <div class="mtoday-block-header">
        <h3 class="mtoday-block-title">${t('map.title')}</h3>
        <button type="button" class="mtoday-link" data-goto-tab="map">${t('map.viewJourney')} ›</button>
      </div>
      <button type="button" class="mtoday-map-preview" id="mtoday-map-preview" data-goto-tab="map">
        <span class="mtoday-map-label">${stay ? stay.city : ''}</span>
      </button>
    </div>

    ${budget ? `
    <div class="mtoday-block">
      <div class="mtoday-block-header">
        <h3 class="mtoday-block-title">${t('budget.title')}</h3>
        <button type="button" class="mtoday-link" data-goto-tab="budget">${t('budgetInsights.viewInsights')} ›</button>
      </div>
      <button type="button" class="mtoday-stat-card" data-goto-tab="budget">
        <div><div class="mtoday-stat-label">${t('today.spentTodayLabel')}</div><div class="mtoday-stat-val">${budget.spent}</div></div>
        ${budget.dailyLeft ? `<div class="mtoday-stat-right"><div class="mtoday-stat-label">${t('today.dailyAvailLabel')}</div><div class="mtoday-stat-val mtoday-stat-val--positive">${budget.dailyLeft}</div></div>` : ''}
      </button>
    </div>` : ''}

    ${wishlistItems.length ? `
    <div class="mtoday-block">
      <div class="mtoday-block-header">
        <h3 class="mtoday-block-title">${t('wishlist.title')} <span class="mtoday-block-count">· ${wishlistItems.length} ${t('wishlist.itemsCount')}</span></h3>
        <button type="button" class="mbudget-add" id="mtoday-wishlist-add">+</button>
      </div>
      <button type="button" class="mtoday-wishlist-viewall" data-goto-tab="wishlist">
        ${wishlistItems.slice(0, 15).map(w => `
          <div class="mtoday-wish-row">
            <span class="mtoday-wish-dot"></span>
            <span class="mtoday-wish-name">${_escHtml(w.name)}</span>
            <span class="mtoday-wish-price">${formatMoney(w.price, w.currency)}</span>
          </div>
        `).join('')}
      </button>
    </div>` : ''}
  `;

  section.querySelectorAll('[data-id]').forEach(row => row.addEventListener('click', () => openEditModal(row.dataset.id)));
  section.querySelectorAll('[data-goto-tab]').forEach(btn => btn.addEventListener('click', () => setMobileTab(btn.dataset.gotoTab)));
  section.querySelectorAll('[data-open-day]').forEach(btn => btn.addEventListener('click', () => {
    const date = btn.dataset.openDay;
    const s = getActiveStay(data.accommodations, date);
    const rows = dayEvents(date, data);
    openSheet({ title: `${s ? s.city : t('today.transit')} · ${fmtDate(date, { year: false })}`, color: s ? 'var(--accent)' : null, rows, empty: rows.length === 0 });
  }));
  section.querySelectorAll('[data-doc-id]').forEach(btn => btn.addEventListener('click', () => {
    window.open(`/api/documents/${btn.dataset.docId}/file`, '_blank', 'noopener');
  }));
  section.querySelector('#mtoday-wishlist-add')?.addEventListener('click', e => { e.stopPropagation(); if (typeof _openWishlistModal === 'function') _openWishlistModal(); });
  // map.js may have built its data before this DOM existed — (re)populate
  // the Ruta preview now that #mtoday-map-preview is actually in the page.
  if (typeof renderMobileRoutePreview === 'function') renderMobileRoutePreview(data.accommodations);
}

// Builds the full list of trip days with a stay/date/dow/label attached —
// shared by the "Esta semana"/"Próximos días" strips and the Calendar tab.
function _buildTripDays(data) {
  const days = [];
  let cur = data.trip.startDate;
  while (cur <= data.trip.endDate) {
    const stay = getActiveStay(data.accommodations, cur);
    const isFirstOfStay = Boolean(stay && stay.check_in === cur);
    const acts = collectTodayActivities(data.calendar, cur);
    const label = isFirstOfStay
      ? t('chip.checkin', { city: stay.city })
      : (acts[0] ? acts[0].main.title : (stay ? stay.city : t('today.transit')));
    const d = parseLocal(cur);
    days.push({ date: cur, num: d.getDate(), dow: d.toLocaleDateString(getDateLocale(), { weekday: 'short' }).toUpperCase(), stay, isFirstOfStay, label });
    cur = addDays(cur, 1);
  }
  return days;
}

// Mobile Today tab, pre-trip state: shown instead of the day-by-day layout
// whenever `today` (or ?today= override) falls before data.trip.startDate.
// Reuses the persistent header countdown (#cd-days/#cd-hours, driven by
// renderInfoBar in app.js) rather than recomputing days/hours a second time.
function renderTodayPreTrip(section, data) {
  const days = _buildTripDays(data);
  const totalNights = (data.accommodations || []).reduce((s, a) =>
    s + Math.round((parseLocal(a.check_out) - parseLocal(a.check_in)) / 86400000), 0);
  const countries = new Set((data.accommodations || []).map(a => a.country)).size;
  const totalStays = (data.accommodations || []).length;

  const cdDays = document.getElementById('cd-days')?.textContent || '--';
  const cdHours = document.getElementById('cd-hours')?.textContent || '--';
  const nextFlight = document.getElementById('info-flight-val')?.textContent || '—';
  const nextStay = document.getElementById('info-stay-val')?.textContent || '—';

  // data/trip.json has no originAirport field — the departure airport is the
  // `from` of the first outbound flight, same source the header countdown's
  // "to flight" subtext already reads (see renderInfoBar in app.js).
  const flights = data.flights || [];
  const outbound = flights.find(f => f.direction === 'outbound') || flights[0];
  const originAirport = outbound?.from || '';

  const stayBar = (data.accommodations || []).map(a => {
    const nights = Math.round((parseLocal(a.check_out) - parseLocal(a.check_in)) / 86400000);
    const colour = data.colorMap?.[a.check_in];
    return `<div style="flex-grow:${nights};flex-basis:0;background:${colour?.accent || 'var(--accent)'}"></div>`;
  }).join('');

  // Budget preview: tripData never carries a `.budget` field (budget.js keeps
  // its own module-level state) — reuse its existing public accessors
  // (already used by wishlist.js) instead of reading a non-existent field.
  const budgetRemaining = typeof getBudgetRemaining === 'function' ? getBudgetRemaining() : null;

  const upcoming = days.slice(0, 4);

  section.innerHTML = `
    <div class="mtoday-block" style="padding-top:16px">
      <h3 class="mtoday-block-title" style="margin-bottom:8px">${t('today.departureFrom', { airport: originAirport })}</h3>
      <div class="mpretrip-countdown">
        <span class="mpretrip-num">${cdDays}</span><span class="mpretrip-unit">${t('info.days')}</span>
        <span class="mpretrip-num" style="margin-left:6px">${cdHours}</span><span class="mpretrip-unit">${t('info.hours')}</span>
      </div>
      <div class="mpretrip-info-row"><span>${t('info.nextFlight')}</span><span class="mpretrip-info-val" style="color:var(--c-flight)">${nextFlight}</span></div>
      <div class="mpretrip-info-row"><span>${t('info.accommodation')}</span><span class="mpretrip-info-val" style="color:var(--c-stay)">${nextStay}</span></div>
    </div>

    <div class="mtoday-block">
      <h3 class="mtoday-block-title">${t('today.tripSummary')}</h3>
      <div class="mpretrip-stats">
        <div class="mpretrip-stat"><div class="mpretrip-stat-num">${totalNights}</div><div class="mpretrip-stat-label">${t('today.nights')}</div></div>
        <div class="mpretrip-stat"><div class="mpretrip-stat-num">${countries}</div><div class="mpretrip-stat-label">${t('today.countries')}</div></div>
        <div class="mpretrip-stat"><div class="mpretrip-stat-num">${totalStays}</div><div class="mpretrip-stat-label">${t('today.stays')}</div></div>
      </div>
    </div>

    <div class="mtoday-block">
      <div class="mtoday-block-header">
        <h3 class="mtoday-block-title">${t('stays.title')}</h3>
        <button type="button" class="mtoday-link" data-goto-tab="calendar">${t('stays.viewDetails')} ›</button>
      </div>
      <div class="mpretrip-staybar-card">
        <div class="mpretrip-staybar">${stayBar}</div>
        <div class="mpretrip-staybar-ticks">
          <span>${fmtDate(data.trip.startDate, { year: false })}</span>
          <span>${fmtDate(data.trip.endDate, { year: false })}</span>
        </div>
      </div>
    </div>

    <div class="mtoday-block">
      <div class="mtoday-block-header">
        <h3 class="mtoday-block-title">${t('map.title')}</h3>
        <button type="button" class="mtoday-link" data-goto-tab="map">${t('map.viewJourney')} ›</button>
      </div>
      <button type="button" class="mtoday-map-preview" id="mtoday-map-preview" data-goto-tab="map"></button>
    </div>

    ${budgetRemaining !== null ? `
    <div class="mtoday-block">
      <h3 class="mtoday-block-title">${t('budget.title')}</h3>
      <button type="button" class="mtoday-stat-card" data-goto-tab="budget">
        <div><div class="mtoday-stat-label">${t('budget.stats.remaining')}</div><div class="mtoday-stat-val mtoday-stat-val--positive">${formatCurrency(budgetRemaining)}</div></div>
      </button>
    </div>` : ''}

    <div class="mtoday-block">
      <div class="mtoday-block-header">
        <h3 class="mtoday-block-title">${t('today.upcomingDays')}</h3>
      </div>
      <div class="mtoday-strip">
        ${upcoming.map(d => `
          <button type="button" class="mtoday-strip-card" data-open-day="${d.date}">
            <span class="mtoday-strip-dow">${d.dow} ${d.num}</span>
            <span class="mtoday-strip-sub">${_escHtml(d.label)}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;

  section.querySelectorAll('[data-goto-tab]').forEach(btn => btn.addEventListener('click', () => setMobileTab(btn.dataset.gotoTab)));
  section.querySelectorAll('[data-open-day]').forEach(btn => btn.addEventListener('click', () => {
    const date = btn.dataset.openDay;
    const s = getActiveStay(data.accommodations, date);
    const rows = dayEvents(date, data);
    openSheet({ title: `${s ? s.city : t('today.transit')} · ${fmtDate(date, { year: false })}`, color: s ? (data.colorMap?.[s.check_in]?.accent || 'var(--accent)') : null, rows, empty: rows.length === 0 });
  }));
  if (typeof renderMobileRoutePreview === 'function') renderMobileRoutePreview(data.accommodations);
}
