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

// Date-matched events for one day, in day order:
// check-outs, then flights/trains by departure time, then check-ins.
function collectTodayEvents(data, today) {
  const events = [];
  for (const a of data.accommodations || []) {
    if (a.check_out === today)
      events.push({ order: 0, time: '', icon: '🧳', label: t('chip.checkout', { city: a.city }), url: a.url || null });
  }
  for (const f of data.flights || []) {
    if (f.departureDate !== today) continue;
    const extras = [f.terminal && `T${f.terminal}`, f.gate && `G${f.gate}`].filter(Boolean).join(' ');
    const label = `${f.flightNumber} · ${f.from}→${f.to} · ${formatTime(f.departureTime)}${extras ? ' · ' + extras : ''}`;
    events.push({ order: 1, time: f.departureTime || '', icon: '✈', label, url: f.flightyUrl || null });
  }
  for (const tr of data.trains || []) {
    if (tr.departureDate !== today) continue;
    const time = tr.departureTime ? ` · ${formatTime(tr.departureTime)}` : '';
    events.push({ order: 1, time: tr.departureTime || '', icon: '🚆', label: `${tr.fromCity} → ${tr.toCity}${time}`, url: tr.url || null });
  }
  for (const a of data.accommodations || []) {
    if (a.check_in === today)
      events.push({ order: 2, time: '', icon: '🛏', label: t('chip.checkin', { city: a.city }), url: a.url || null });
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
  section.hidden = !inTrip;
  if (!inTrip) { section.innerHTML = ''; _renderPassportStamp(null); return; }

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
