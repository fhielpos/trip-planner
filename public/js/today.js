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

// Shared by both Today states (pre-trip and in-trip): a header (title,
// optional stat line, "+" quick-add) plus the last 3 expenses. `statHtml`
// carries whichever stat line each state already shows (remaining vs.
// spent-today/daily-left) so this helper only owns the entries list.
function _renderBudgetPreviewBlock(statHtml) {
  const recent = typeof getRecentBudgetEntries === 'function' ? getRecentBudgetEntries(3) : [];
  return `
    <div class="mtoday-block">
      <div class="mtoday-block-header">
        <h3 class="mtoday-block-title">${t('budget.title')}</h3>
        <div style="display:flex;align-items:center;gap:10px">
          <button type="button" class="mtoday-link" data-goto-tab="budget">${t('budgetInsights.viewInsights')} ›</button>
          <button type="button" class="mbudget-add" id="mtoday-budget-add" aria-label="${t('budget.addEntry')}">+</button>
        </div>
      </div>
      ${statHtml}
      ${recent.length ? `
      <div class="mtoday-wishlist-viewall" style="margin-top:8px">
        ${recent.map(e => `
          <div class="mtoday-wish-row" data-budget-entry-id="${e.id}">
            <span class="mtoday-wish-dot" style="background:${e.color}"></span>
            <span class="mtoday-wish-name">${_escHtml(e.label)}</span>
            <span class="mtoday-wish-price">${e.amountLabel}</span>
          </div>
        `).join('')}
      </div>` : ''}
    </div>`;
}

// Shared by both Today states — always renders (even empty) so the
// wishlist stays discoverable instead of disappearing when it has no items.
function _renderWishlistPreviewBlock() {
  const items = typeof getWishlistItems === 'function' ? getWishlistItems() : [];
  return `
    <div class="mtoday-block">
      <div class="mtoday-block-header">
        <h3 class="mtoday-block-title">${t('wishlist.title')}${items.length ? ` <span class="mtoday-block-count">· ${items.length} ${t('wishlist.itemsCount')}</span>` : ''}</h3>
        <button type="button" class="mbudget-add" id="mtoday-wishlist-add" aria-label="${t('wishlist.addItem')}">+</button>
      </div>
      ${items.length ? `
      <button type="button" class="mtoday-wishlist-viewall" data-goto-tab="wishlist">
        ${items.slice(0, 15).map(w => `
          <div class="mtoday-wish-row">
            <span class="mtoday-wish-dot"></span>
            <span class="mtoday-wish-name">${_escHtml(w.name)}</span>
            <span class="mtoday-wish-price">${formatMoney(w.price, w.currency)}</span>
          </div>
        `).join('')}
      </button>` : `<p class="wishlist-empty">${t('wishlist.empty')}</p>`}
    </div>`;
}

// Wires the "+" buttons and entry rows produced by the two preview blocks
// above — called once per render from each Today state after innerHTML is set.
function _wireTodayPreviewBlocks(section) {
  section.querySelector('#mtoday-budget-add')?.addEventListener('click', e => {
    e.stopPropagation();
    if (typeof _openExpenseModal === 'function') _openExpenseModal(null);
  });
  section.querySelector('#mtoday-wishlist-add')?.addEventListener('click', e => {
    e.stopPropagation();
    if (typeof _openWishlistModal === 'function') _openWishlistModal();
  });
  section.querySelectorAll('[data-budget-entry-id]').forEach(row => row.addEventListener('click', () => {
    if (typeof _openExpenseModal === 'function') _openExpenseModal(row.dataset.budgetEntryId);
  }));
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

// Mobile redesign header (≤640px): passport stamp · DÍA n / total ·
// sync line · progress hairline. Runs for every trip phase; the desktop
// header (.header-inner) is untouched.
function _renderMobileHeader(data) {
  const host = document.getElementById('m-header');
  if (!host || !data?.trip) return;

  const today = appToday();
  const inTrip = today >= data.trip.startDate && today <= data.trip.endDate;
  const preTrip = today < data.trip.startDate;
  const start = parseLocal(data.trip.startDate);
  const end = parseLocal(data.trip.endDate);
  const totalDays = Math.round((end - start) / 86400000) + 1;
  const dayNum = Math.round((parseLocal(today) - start) / 86400000) + 1;

  const stay = inTrip ? getActiveStay(data.accommodations || [], today) : null;
  const stampEl = document.getElementById('m-header-stamp');
  if (stampEl) {
    if (stay && stay.country) {
      stampEl.innerHTML = `<span class="m-header-stamp-flag">${countryFlag(stay.country)}</span>${stay.country}`;
    } else {
      stampEl.innerHTML = '';
    }
  }

  const dayEl = document.getElementById('m-header-day');
  if (dayEl) {
    if (inTrip) {
      dayEl.innerHTML = `${t('header.day', { n: dayNum })}<span class="m-header-day-total"> / ${totalDays}</span>`;
    } else if (preTrip) {
      const daysTo = Math.round((start - parseLocal(today)) / 86400000);
      dayEl.textContent = t('header.daysToGo', { n: daysTo });
    } else {
      dayEl.textContent = t('header.tripEnded');
    }
  }

  const pct = inTrip ? Math.round((dayNum / totalDays) * 100) : (preTrip ? 0 : 100);
  host.style.setProperty('--m-header-progress', `${pct}%`);

  _updateHeaderSync();

  // Keep --header-h honest for sticky offsets in later slices.
  if (isMobileViewport()) {
    const h = document.querySelector('.app-header')?.offsetHeight;
    if (h) document.documentElement.style.setProperty('--header-h', `${h}px`);
  }
}

// Sync sub-line — mirrors navigator.onLine. offline.js also calls this on
// the online/offline events.
function _updateHeaderSync() {
  const el = document.getElementById('m-header-sync');
  if (!el) return;
  const online = navigator.onLine;
  el.textContent = online ? t('header.synced') : t('header.offline');
  el.classList.toggle('is-offline', !online);
}

function renderToday(data) {
  const section = document.getElementById('today-section');
  if (!section || !data?.trip) return;

  const today = appToday();
  const inTrip = today >= data.trip.startDate && today <= data.trip.endDate;
  document.body.classList.toggle('today-active', inTrip);
  _renderMobileHeader(data);
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
  // Leave the custom property unset when there's no image so the mobile hero's
  // gradient-placeholder fallback (var(--today-image, <gradient>)) can apply.
  if (imageStay?.image) section.style.setProperty('--today-image', `url(/images/${imageStay.image})`);
  else section.style.removeProperty('--today-image');
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
    renderTodayMobileInTrip(section, data, { stay, today, dayNum, totalDays, w, weatherLine, sunTimes, lastNight, heroCity, acts, activeDocs, budget });
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
      ${stay && data.config?.aiSuggestionsEnabled ? `
      <div class="today-block today-recs-block today-ai-block">
        <button type="button" class="today-recs-toggle today-ai-toggle" id="today-ai-toggle">${t('aiSuggestions.seeLink')}</button>
        <div class="today-recs-panel today-ai-panel" id="today-ai-panel" hidden></div>
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

  _wireAiToggle(section.querySelector('#today-ai-toggle'), section.querySelector('#today-ai-panel'), today);
}

// The next flight or train departing on/after `today`, with its position
// in the whole leg sequence (flights + trains, chronological).
function _nextLeg(data, today) {
  const legs = [
    ...(data.flights || []).map(f => ({
      kind: 'flight', date: f.departureDate, time: f.departureTime || '',
      from: f.from, to: f.to,
      carrier: [f.flightNumber].filter(Boolean).join(' '),
      url: f.flightyUrl || null,
    })),
    ...(data.trains || []).map(tr => ({
      kind: 'train', date: tr.departureDate, time: tr.departureTime || '',
      from: tr.fromCity, to: tr.toCity, carrier: tr.operator || '',
      url: tr.url || null,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99'));

  const total = legs.length;
  const idx = legs.findIndex(l => l.date >= today);
  if (idx === -1) return null;
  return { ...legs[idx], index: idx + 1, total };
}

// Slot column for an agenda row: a real time, or an uppercase part-of-day
// label — never an empty gutter. See the handoff's "Untimed events" rule.
function _slotCell(time, fallbackKey) {
  return time
    ? `<span class="mtoday-slot mono mtoday-slot--time">${formatTime(time)}</span>`
    : `<span class="mtoday-slot label mtoday-slot--lbl">${t(fallbackKey || 'today.slotDay')}</span>`;
}

function renderTodayMobileInTrip(section, data, ctx) {
  const { stay, today, w, lastNight, heroCity, acts, activeDocs, budget } = ctx;

  // ---- hero pill: night N of M ----
  let nightPill = '';
  if (stay) {
    const total = Math.round((parseLocal(stay.check_out) - parseLocal(stay.check_in)) / 86400000);
    const n = Math.round((parseLocal(today) - parseLocal(stay.check_in)) / 86400000) + 1;
    nightPill = t('today.nightOf', { n, total });
  }
  const dateLabel = parseLocal(today).toLocaleDateString(getDateLocale(), { weekday: 'short', day: 'numeric', month: 'short' });

  // ---- itinerary card rows: untimed activities, then timed items, then the night ----
  const events = collectTodayEvents(data, today);            // checkouts / flights / trains / checkins
  const untimed = acts.filter(a => !a.main.startTime);
  const timedActs = acts.filter(a => a.main.startTime);

  const rowsHtml = [];
  for (const { main, backup } of untimed) {
    rowsHtml.push(`
      <div class="mtoday-itin-row" data-id="${main.id}">
        ${_slotCell('', 'today.slotDay')}
        <div class="mtoday-itin-body">
          <div class="mtoday-itin-title">${_escHtml(main.title)}</div>
          <div class="mtoday-itin-meta">${t('today.noTimeTapToSet')}</div>
        </div>
      </div>`);
    if (backup) rowsHtml.push(`
      <div class="mtoday-itin-row mtoday-itin-row--backup" data-id="${backup.id}">
        ${_slotCell('', 'today.slotDay')}
        <div class="mtoday-itin-body"><div class="mtoday-itin-title">${_escHtml(backup.title)}</div>
        <div class="mtoday-itin-meta">${t('today.backup')}</div></div>
      </div>`);
  }
  for (const { main, backup } of timedActs) {
    rowsHtml.push(`
      <div class="mtoday-itin-row" data-id="${main.id}">
        ${_slotCell(main.startTime)}
        <div class="mtoday-itin-body"><div class="mtoday-itin-title">${_escHtml(main.title)}</div>
        ${main.address ? `<div class="mtoday-itin-meta">${_escHtml(main.address)}</div>` : ''}</div>
      </div>`);
    if (backup) rowsHtml.push(`
      <div class="mtoday-itin-row mtoday-itin-row--backup" data-id="${backup.id}">
        ${_slotCell(backup.startTime, 'today.slotDay')}
        <div class="mtoday-itin-body"><div class="mtoday-itin-title">${_escHtml(backup.title)}</div>
        <div class="mtoday-itin-meta">${t('today.backup')}</div></div>
      </div>`);
  }
  for (const e of events) {
    const slotKey = e.order === 0 ? 'today.slotOut' : e.order === 2 ? 'today.slotIn' : 'today.slotDay';
    rowsHtml.push(`
      <div class="mtoday-itin-row">
        ${_slotCell(e.time, slotKey)}
        <div class="mtoday-itin-body"><div class="mtoday-itin-title">${e.icon} ${_escHtml(e.label)}</div></div>
      </div>`);
  }

  const itinCard = `
    <div class="mtoday-card mtoday-itin">
      <div class="mtoday-itin-head">
        <span class="label mtoday-itin-head-lbl">${t('today.itineraryToday')}</span>
        <span class="mono mtoday-itin-head-date">${dateLabel}</span>
      </div>
      <div class="perf-x"></div>
      ${rowsHtml.join('') || `<div class="mtoday-itin-row"><div class="mtoday-itin-body"><div class="mtoday-itin-meta mtoday-freeday">${t('today.freeDay')}</div></div></div>`}
      ${stay ? `
      <div class="mtoday-itin-row mtoday-itin-row--night">
        <span class="mtoday-slot label mtoday-slot--lbl">${t('today.slotNight')}</span>
        <div class="mtoday-itin-body">
          <div class="mtoday-itin-title">${_escHtml(stay.name || stay.city)}</div>
          <div class="mtoday-itin-meta">${t('today.checkoutAt', { date: fmtDate(stay.check_out, { year: false }), time: stay.check_out_time || '' }).trim()}</div>
        </div>
        <span class="mtoday-itin-chev">›</span>
      </div>` : ''}
    </div>`;

  // ---- next leg ----
  const leg = _nextLeg(data, today);
  const legCard = leg ? `
    <div class="mtoday-nextleg-wrap">
      <div class="mtoday-card mtoday-nextleg">
        <span class="mtoday-nextleg-glyph">${leg.kind === 'flight' ? '✈' : '🚆'}</span>
        <div class="mtoday-nextleg-body">
          <div class="label mtoday-nextleg-lbl">${t('today.nextLeg')} · ${fmtDate(leg.date, { year: false })}</div>
          <div class="mono mtoday-nextleg-route">${leg.time ? formatTime(leg.time) + ' ' : ''}${leg.from} → ${leg.to}${leg.carrier ? ' · ' + leg.carrier : ''}</div>
        </div>
        ${leg.url ? `<a class="label mtoday-nextleg-pass" href="${leg.url}" target="_blank" rel="noopener">${t('today.boardingPass')}</a>` : ''}
      </div>
      <div class="mtoday-nextleg-foot">
        <span class="label">${t('today.legOf', { n: leg.index, total: leg.total })}</span>
        <a class="label mtoday-link" href="/journey.html">${t('today.seeFullRoute')} ›</a>
      </div>
    </div>` : '';

  // ---- today's budget ----
  let budgetCard = '';
  if (budget && budget.dayAllowanceUSD) {
    const pct = Math.max(0, Math.min(100, Math.round((budget.spentTodayUSD / budget.dayAllowanceUSD) * 100)));
    budgetCard = `
      <div class="mtoday-card mtoday-budget">
        <div class="mtoday-card-head">
          <span class="label">${t('today.availableToday')}</span>
          <button type="button" class="label mtoday-link" id="mtoday-add-expense">${t('today.addExpense')} ›</button>
        </div>
        <div class="mtoday-budget-figure">
          <span class="mono mtoday-budget-big">${budget.dailyLeft}</span>
          <span class="mono mtoday-budget-of">${t('today.ofAmount', { amount: budget.dayAllowanceLabel })}</span>
        </div>
        <div class="mtoday-budget-bar"><span style="width:${pct}%"></span></div>
        <div class="mono mtoday-budget-row">
          <span>${t('today.spentTodayAmount', { amount: budget.spent })}</span>
          <span>${t('today.remainingAmount', { amount: budget.remainingLabel })}</span>
        </div>
      </div>`;
  }

  // ---- two tiles ----
  const wl = typeof getWishlistItems === 'function' ? getWishlistItems() : [];
  const tiles = `
    <div class="mtoday-tiles">
      <button type="button" class="mtoday-tile" data-goto-tab="map">
        <span class="mtoday-tile-glyph">⊕</span>
        <span class="label mtoday-tile-lbl">${t('map.title')}</span>
        <span class="mtoday-tile-val">${t('today.tileStays', { n: (data.accommodations || []).length })}</span>
      </button>
      <button type="button" class="mtoday-tile" data-goto-tab="wishlist">
        <span class="mtoday-tile-glyph">☰</span>
        <span class="label mtoday-tile-lbl">${t('wishlist.title')}</span>
        <span class="mtoday-tile-val">${t('today.tileWishlist', { n: wl.length })}</span>
      </button>
    </div>`;

  // ---- this week ----
  const weekDays = _buildTripDays(data).filter(d => d.date >= today).slice(0, 6);
  const weekStrip = `
    <div class="mtoday-week-sec">
      <div class="mtoday-card-head">
        <span class="label">${t('today.thisWeek')}</span>
      </div>
      <div class="mtoday-week">
        ${weekDays.map(d => `
          <button type="button" class="mtoday-weekcard${d.date === today ? ' is-today' : ''}" data-open-day="${d.date}">
            <span class="label mono mtoday-weekcard-date">${d.dow} ${d.num}</span>
            <span class="mtoday-weekcard-title">${_escHtml(d.label)}</span>
          </button>`).join('')}
        <button type="button" class="mtoday-weekcard mtoday-weekcard--more" data-goto-tab="calendar" aria-label="${t('today.seeFullMonth')}">›</button>
      </div>
    </div>`;

  // ---- optional: docs + AI (kept from prior work) ----
  const docsBlock = activeDocs.length ? `
    <div class="mtoday-week-sec">
      <div class="mtoday-card-head"><span class="label">${t('documents.title')}</span></div>
      ${activeDocs.map(d => `
        <button type="button" class="mtoday-doc-row" data-doc-id="${d.id}">
          <span class="mtoday-doc-badge">📄</span>
          <div class="mtoday-doc-body">
            <div class="mtoday-doc-title">${_escHtml(d.title)}</div>
            <div class="mtoday-doc-sub">${t('documents.validRange', { from: fmtDate(d.valid_from, { year: false }), to: fmtDate(d.valid_to, { year: false }) })}</div>
          </div>
          <span class="mtoday-doc-chevron">›</span>
        </button>`).join('')}
    </div>` : '';

  const aiBlock = (stay && data.config?.aiSuggestionsEnabled) ? `
    <div class="mtoday-week-sec mtoday-ai-block">
      <button type="button" class="mtoday-ai-toggle" id="mtoday-ai-toggle">${t('aiSuggestions.seeLink')}</button>
      <div class="mtoday-ai-panel" id="mtoday-ai-panel" hidden></div>
    </div>` : '';

  section.innerHTML = `
    <div class="mtoday-hero">
      <div class="mtoday-hero-overlay">
        <span class="mtoday-hero-flag">${stay ? countryFlag(stay.country) : ''}</span>
        <span class="mtoday-city">${_escHtml(heroCity.replace(/^\S+\s/, ''))}</span>
        ${nightPill ? `<span class="label mtoday-hero-pill">${nightPill}</span>` : ''}
      </div>
    </div>

    ${w ? `
    <div class="mtoday-weatherbar mono">
      <span class="mtoday-wx-temp">${w.source === 'historical' ? '~' : ''}${weatherIcon(w.code)} ${w.tempMax}°/${w.tempMin}°</span>
      ${w.sunrise && w.sunset ? `<span class="mtoday-wx-sun">↑${w.sunrise} ↓${w.sunset}</span>` : ''}
    </div>` : ''}

    <div class="mtoday-body">
      ${itinCard}
      ${legCard}
      ${budgetCard}
      ${tiles}
      ${weekStrip}
      ${docsBlock}
      ${aiBlock}
      ${_renderWishlistPreviewBlock()}
    </div>
  `;

  section.querySelectorAll('[data-id]').forEach(row => row.addEventListener('click', () => openEditModal(row.dataset.id)));
  section.querySelectorAll('[data-goto-tab]').forEach(btn => btn.addEventListener('click', () => setMobileTab(btn.dataset.gotoTab)));
  section.querySelector('#mtoday-add-expense')?.addEventListener('click', e => {
    e.stopPropagation();
    if (typeof _openExpenseModal === 'function') _openExpenseModal(null);
  });
  section.querySelectorAll('[data-open-day]').forEach(btn => btn.addEventListener('click', () => {
    const date = btn.dataset.openDay;
    const s = getActiveStay(data.accommodations, date);
    const rows = dayEvents(date, data);
    openSheet({ title: `${s ? s.city : t('today.transit')} · ${fmtDate(date, { year: false })}`, color: s ? 'var(--accent)' : null, rows, empty: rows.length === 0 });
  }));
  _wireTodayPreviewBlocks(section);
  section.querySelectorAll('[data-doc-id]').forEach(btn => btn.addEventListener('click', () => {
    window.open(`/api/documents/${btn.dataset.docId}/file`, '_blank', 'noopener');
  }));
  _wireAiToggle(section.querySelector('#mtoday-ai-toggle'), section.querySelector('#mtoday-ai-panel'), today);
}

// Shared toggle wiring for the "Suggest things to do" panel — desktop
// Today, mobile Today, both call this. Lazy: the API request only fires
// the first time the panel is opened.
function _wireAiToggle(toggle, panel, date) {
  toggle?.addEventListener('click', () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    if (opening && !panel.dataset.loaded) {
      panel.dataset.loaded = '1';
      renderAiSuggestions(panel, date);
    }
  });
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
        <a class="mtoday-link" href="/accommodations.html">${t('stays.viewDetails')} ›</a>
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

    ${budgetRemaining !== null ? _renderBudgetPreviewBlock(`
      <button type="button" class="mtoday-stat-card" data-goto-tab="budget">
        <div><div class="mtoday-stat-label">${t('budget.stats.remaining')}</div><div class="mtoday-stat-val mtoday-stat-val--positive">${formatCurrency(budgetRemaining)}</div></div>
      </button>
    `) : ''}

    ${_renderWishlistPreviewBlock()}

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
  _wireTodayPreviewBlocks(section);
  section.querySelectorAll('[data-open-day]').forEach(btn => btn.addEventListener('click', () => {
    const date = btn.dataset.openDay;
    const s = getActiveStay(data.accommodations, date);
    const rows = dayEvents(date, data);
    openSheet({ title: `${s ? s.city : t('today.transit')} · ${fmtDate(date, { year: false })}`, color: s ? (data.colorMap?.[s.check_in]?.accent || 'var(--accent)') : null, rows, empty: rows.length === 0 });
  }));
  if (typeof renderMobileRoutePreview === 'function') renderMobileRoutePreview(data.accommodations);
}
