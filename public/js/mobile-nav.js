/* =============================================
   Mobile Tab Shell — tab bar, bottom sheet, toast
   Active only ≤640px; every export is a no-op-safe
   global other modules call into unconditionally.
   ============================================= */

const MOBILE_BREAKPOINT = 640;

function isMobileViewport() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

const _mobileRerenderFns = [];
function registerMobileRerender(fn) {
  _mobileRerenderFns.push(fn);
}

let _lastMobileState = isMobileViewport();
window.addEventListener('resize', () => {
  const nowMobile = isMobileViewport();
  if (nowMobile !== _lastMobileState) {
    _lastMobileState = nowMobile;
    _mobileRerenderFns.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  }
});

function setMobileTab(tab) {
  document.body.dataset.mobileTab = tab;
  document.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  if (typeof closeAddFab === 'function') closeAddFab();
  window.scrollTo(0, 0);
  // #trip-map is built while hidden behind the default Today tab; Leaflet
  // needs an explicit re-measure + re-fit once it actually becomes visible.
  if (tab === 'map' && typeof refreshMapView === 'function') {
    requestAnimationFrame(() => refreshMapView());
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.body.dataset.mobileTab = 'today';
  document.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.addEventListener('click', () => setMobileTab(btn.dataset.tab));
  });

  document.getElementById('day-sheet-close')?.addEventListener('click', closeSheet);
  document.getElementById('day-sheet-backdrop')?.addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('day-sheet')?.hidden) closeSheet();
  });

  const daySheet = document.getElementById('day-sheet');
  if (daySheet) {
    attachSheetDrag(daySheet, {
      zoneSelector: '.sheet-handle, .sheet-header, .daysheet-titleblock',
      onClose: closeSheet,
      backdrop: document.getElementById('day-sheet-backdrop'),
    });
  }

  // Header ··· → Settings sheet (implemented in settings.js)
  document.getElementById('m-header-menu')?.addEventListener('click', () => {
    if (typeof openSettingsSheet === 'function') openSettingsSheet();
  });

  initAddFab();
});

// ── Add FAB + type-picker fan ───────────────────

function _fabDateLabel() {
  try {
    const d = typeof parseLocal === 'function' && typeof appToday === 'function'
      ? parseLocal(appToday()) : new Date();
    const loc = typeof getDateLocale === 'function' ? getDateLocale() : undefined;
    return d.toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function openAddFab() {
  const menu = document.getElementById('m-fab-menu');
  const fab = document.getElementById('m-fab');
  if (!menu || !fab) return;
  const setCtx = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt || ''; };
  setCtx('m-fab-ctx-activity', _fabDateLabel());
  setCtx('m-fab-ctx-expense', typeof t === 'function' ? t('fab.today') : '');
  menu.hidden = false;
  document.body.classList.add('m-fab-open');
  fab.setAttribute('aria-expanded', 'true');
}

function closeAddFab() {
  const menu = document.getElementById('m-fab-menu');
  const fab = document.getElementById('m-fab');
  if (menu) menu.hidden = true;
  document.body.classList.remove('m-fab-open');
  if (fab) fab.setAttribute('aria-expanded', 'false');
}

function toggleAddFab() {
  document.body.classList.contains('m-fab-open') ? closeAddFab() : openAddFab();
}

function _fabDefaultDate() {
  if (typeof appToday !== 'function' || typeof tripData === 'undefined' || !tripData?.trip) {
    return typeof appToday === 'function' ? appToday() : undefined;
  }
  const today = appToday();
  return (today >= tripData.trip.startDate && today <= tripData.trip.endDate)
    ? today : tripData.trip.startDate;
}

function _fabDispatch(kind) {
  closeAddFab();
  const date = _fabDefaultDate();
  switch (kind) {
    case 'activity':
      if (typeof openAddModal === 'function') openAddModal(date);
      break;
    case 'stay':
      if (typeof openAddModal === 'function') {
        openAddModal(date);
        if (typeof setType === 'function') setType('accommodation');
      }
      break;
    case 'expense':
      if (typeof _openExpenseModal === 'function') _openExpenseModal(null);
      break;
    case 'wishlist':
      if (typeof _openWishlistModal === 'function') _openWishlistModal();
      break;
  }
}

function initAddFab() {
  document.getElementById('m-fab')?.addEventListener('click', toggleAddFab);
  document.getElementById('m-fab-scrim')?.addEventListener('click', closeAddFab);
  document.querySelectorAll('.m-fab-item').forEach(btn => {
    btn.addEventListener('click', () => _fabDispatch(btn.dataset.add));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('m-fab-open')) closeAddFab();
  });
}

// ── Day Sheet (5c) ──────────────────────────────

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// One agenda row inside the Day sheet: fixed slot column (a Mono time or an
// uppercase part-of-day label — never an empty gutter), title, optional meta.
function _daySheetRow({ id, slot, slotIsTime, title, meta, chevron }) {
  return `
    <div class="daysheet-row"${id ? ` data-id="${_escHtml(id)}"` : ''}>
      <span class="daysheet-slot ${slotIsTime ? 'mono daysheet-slot--time' : 'label daysheet-slot--lbl'}">${_escHtml(slot)}</span>
      <div class="daysheet-row-body">
        <div class="daysheet-row-title">${_escHtml(title)}</div>
        ${meta ? `<div class="daysheet-row-meta">${_escHtml(meta)}</div>` : ''}
      </div>
      ${chevron ? '<span class="daysheet-chev">›</span>' : ''}
    </div>`;
}

function _daySheetSection(titleHtml, rowsHtml, variant) {
  if (!rowsHtml) return '';
  return `
    <div class="daysheet-sec">
      <div class="daysheet-sec-head">${titleHtml}</div>
      <div class="daysheet-sec-rows ${variant || ''}">${rowsHtml}</div>
    </div>`;
}

// Builds the 5c day-detail body for `date` from `data` (tripData). All the
// data helpers it leans on live in today.js / budget.js / app.js.
function _daySheetHtml(date, data) {
  const d = parseLocal(date);
  const loc = getDateLocale();
  const monthName = d.toLocaleDateString(loc, { month: 'long' });
  const dateNumeral = d.toLocaleDateString(loc, { weekday: 'short', day: 'numeric' });
  const isToday = typeof appToday === 'function' && date === appToday();

  const stay = typeof getActiveStay === 'function' ? getActiveStay(data.accommodations || [], date) : null;
  const flag = stay ? countryFlag(stay.country) : '';
  const cityLabel = stay ? stay.city : t('today.transit');

  // día N de M / noche X de Y — both computed
  const tripStart = data.trip ? parseLocal(data.trip.startDate) : d;
  const tripEnd = data.trip ? parseLocal(data.trip.endDate) : d;
  const dayNum = Math.round((d - tripStart) / 86400000) + 1;
  const tripDays = Math.round((tripEnd - tripStart) / 86400000) + 1;
  let subLine;
  if (stay) {
    const nights = Math.round((parseLocal(stay.check_out) - parseLocal(stay.check_in)) / 86400000);
    const nightNum = Math.round((d - parseLocal(stay.check_in)) / 86400000) + 1;
    subLine = t('daySheet.nightDayLine', { n: nightNum, total: nights, d: dayNum, days: tripDays });
  } else {
    subLine = t('daySheet.dayLine', { d: dayNum, days: tripDays });
  }

  // ---- agenda: untimed activities, timed items + events ----
  const acts = typeof collectTodayActivities === 'function' ? collectTodayActivities(data.calendar, date) : [];
  const events = typeof collectTodayEvents === 'function' ? collectTodayEvents(data, date) : [];
  const untimed = acts.filter(a => !a.main.startTime);
  const timedActs = acts.filter(a => a.main.startTime);

  const duringDayRows = untimed.map(({ main, backup }) => {
    let html = _daySheetRow({
      id: main.id, slot: t('today.slotDay'), slotIsTime: false,
      title: main.title, meta: t('today.noTimeTapToSet'), chevron: true,
    });
    if (backup) html += _daySheetRow({
      id: backup.id, slot: t('today.slotDay'), slotIsTime: false,
      title: backup.title, meta: t('today.backup'), chevron: true,
    });
    return html;
  }).join('');

  const scheduled = [
    ...timedActs.map(({ main, backup }) => ({
      sortTime: main.startTime, id: main.id, slot: formatTime24(main.startTime),
      slotIsTime: true, title: main.title, meta: main.address || '', backup,
    })),
    ...events.map(e => ({
      sortTime: e.time || (e.order === 0 ? '00:00' : e.order === 2 ? '23:59' : '99:99'),
      id: null,
      slot: e.time ? formatTime24(e.time) : (e.order === 0 ? t('today.slotOut') : e.order === 2 ? t('today.slotIn') : t('today.slotDay')),
      slotIsTime: Boolean(e.time),
      title: `${e.icon} ${e.label}`, meta: '',
    })),
  ].sort((a, b) => String(a.sortTime).localeCompare(String(b.sortTime)));

  const scheduledRows = scheduled.map(r => {
    let html = _daySheetRow(r);
    if (r.backup) html += _daySheetRow({
      id: r.backup.id, slot: t('today.slotDay'), slotIsTime: false,
      title: r.backup.title, meta: t('today.backup'), chevron: true,
    });
    return html;
  }).join('');

  const hasAgenda = Boolean(duringDayRows || scheduledRows);

  // ---- accommodation ----
  let stayRows;
  if (stay) {
    const metaParts = [
      t('daySheet.stayEntry', {
        in: fmtDate(stay.check_in, { year: false }),
        out: fmtDate(stay.check_out, { year: false }),
      }),
    ];
    if (stay.total_price) metaParts.push(t('daySheet.paid'));
    stayRows = _daySheetRow({
      slot: t('today.slotNight'), slotIsTime: false,
      title: stay.name || stay.city, meta: metaParts.join(' · '),
      chevron: Boolean(stay.url),
    });
  } else {
    stayRows = `
      <button type="button" class="daysheet-row daysheet-row--btn" data-daysheet-add-stay>
        <span class="daysheet-slot label daysheet-slot--lbl">${t('today.slotNight')}</span>
        <div class="daysheet-row-body">
          <div class="daysheet-row-title daysheet-row-title--muted">${t('daySheet.noStay')}</div>
          <div class="daysheet-row-meta">${t('daySheet.noStayMeta')}</div>
        </div>
        <span class="label daysheet-chev daysheet-chev--accent">${t('daySheet.addStay')} ›</span>
      </button>`;
  }

  // ---- day expenses ----
  const dayExp = typeof getDayExpenses === 'function' ? getDayExpenses(date) : { entries: [], count: 0, totalLabel: '' };
  const expenseRows = dayExp.entries.map(e => `
    <div class="daysheet-exp-row" data-budget-entry-id="${_escHtml(e.id)}">
      <span class="daysheet-exp-dot" style="background:${e.color}"></span>
      <span class="daysheet-exp-name">${_escHtml(e.label)}</span>
      <span class="mono daysheet-exp-amt">${_escHtml(e.amountLabel)}</span>
    </div>`).join('');

  // ---- documents ----
  const docs = typeof collectActiveDocuments === 'function' ? collectActiveDocuments(data.documents, date) : [];
  const docTiles = docs.map(doc => `
    <button type="button" class="daysheet-doc" data-doc-id="${_escHtml(doc.id)}">
      <span class="daysheet-doc-glyph">▤</span>
      <span class="daysheet-doc-body">
        <span class="daysheet-doc-title">${_escHtml(doc.title)}</span>
        <span class="mono daysheet-doc-sub">${t('daySheet.docSaved')}</span>
      </span>
    </button>`).join('');

  // ---- AI trigger row (dispatch 04 owns the panel; we place the row) ----
  const aiEnabled = Boolean(data.config && data.config.aiSuggestionsEnabled);
  const planCount = acts.length;
  const w = (stay && typeof getWeather === 'function') ? getWeather(stay.id, date) : null;
  const aiContext = w && typeof w.tempMax === 'number'
    ? t('daySheet.aiContext', { city: cityLabel, temp: w.tempMax, n: planCount })
    : t('daySheet.aiContextNoTemp', { city: cityLabel, n: planCount });
  const aiBlock = `
    <div class="daysheet-sec daysheet-ai">
      ${aiTriggerHtml({ idPrefix: 'daysheet', enabled: aiEnabled, context: aiContext })}
    </div>`;

  const freeDayBlock = hasAgenda ? '' : `
    <div class="daysheet-sec daysheet-freeday">
      <div class="daysheet-freeday-glyph">◇</div>
      <div class="daysheet-freeday-title">${t('today.freeDay')}</div>
      <div class="daysheet-freeday-body">${t('daySheet.freeDayBody')}</div>
    </div>`;

  return `
    <div class="daysheet-titleblock">
      <div class="daysheet-titlerow">
        <span class="mono daysheet-date">${_escHtml(dateNumeral)}</span>
        <span class="label daysheet-month">${_escHtml(monthName)}</span>
        ${isToday ? `<span class="label daysheet-hoy">${t('today.hoyChip')}</span>` : ''}
      </div>
      <div class="daysheet-cityrow">
        ${flag ? `<span class="daysheet-cityflag">${flag}</span>` : ''}
        <span class="label daysheet-city">${_escHtml(cityLabel)}</span>
        <span class="mono daysheet-nightday">${_escHtml(subLine)}</span>
      </div>
    </div>

    ${_daySheetSection(`<span class="label">${t('daySheet.duringDay')}</span>`, duringDayRows, 'daysheet-sec-rows--untimed')}
    ${_daySheetSection(`<span class="label">${t('daySheet.scheduled')}</span>`, scheduledRows, 'daysheet-sec-rows--timed')}
    ${freeDayBlock}
    ${_daySheetSection(`<span class="label">${t('daySheet.accommodation')}</span>`, stayRows, 'daysheet-sec-rows--stay')}
    ${expenseRows ? `
      <div class="daysheet-sec">
        <div class="daysheet-sec-head daysheet-sec-head--split">
          <span class="label">${t('daySheet.dayExpenses')}</span>
          <span class="mono daysheet-exp-sum">${_escHtml(dayExp.totalLabel)} · ${dayExp.count}</span>
        </div>
        <div class="daysheet-exp-list">${expenseRows}</div>
      </div>` : ''}
    ${docTiles ? `
      <div class="daysheet-sec">
        <div class="daysheet-sec-head"><span class="label">${t('documents.title')}</span></div>
        <div class="daysheet-doc-grid">${docTiles}</div>
      </div>` : ''}

    ${aiBlock}

    <div class="daysheet-actions">
      <button type="button" class="label daysheet-act daysheet-act--primary" data-daysheet-add-activity>+ ${t('fab.activity')}</button>
      <button type="button" class="label daysheet-act" data-daysheet-add-expense>+ ${t('fab.expense')}</button>
    </div>`;
}

function openDaySheet(date, data) {
  const sheet = document.getElementById('day-sheet');
  const backdrop = document.getElementById('day-sheet-backdrop');
  const body = document.getElementById('day-sheet-body');
  if (!sheet || !backdrop || !body) return;
  data = data || (typeof tripData !== 'undefined' ? tripData : null);
  if (!data || !data.trip) return;

  sheet.classList.remove('sheet--stay');
  sheet.classList.add('sheet--day');
  const titleEl = document.getElementById('day-sheet-title');
  if (titleEl) { titleEl.textContent = ''; titleEl.style.color = ''; }

  body.innerHTML = _daySheetHtml(date, data);

  body.querySelectorAll('.daysheet-row[data-id]').forEach(el =>
    el.addEventListener('click', () => {
      if (typeof openEditModal === 'function') openEditModal(el.dataset.id);
    }));
  body.querySelectorAll('[data-budget-entry-id]').forEach(el =>
    el.addEventListener('click', () => {
      if (typeof _openExpenseModal === 'function') _openExpenseModal(el.dataset.budgetEntryId);
    }));
  body.querySelectorAll('[data-doc-id]').forEach(el =>
    el.addEventListener('click', () => {
      window.open(`/api/documents/${el.dataset.docId}/file`, '_blank', 'noopener');
    }));
  body.querySelector('[data-daysheet-add-activity]')?.addEventListener('click', () => {
    if (typeof openAddModal === 'function') openAddModal(date);
  });
  body.querySelector('[data-daysheet-add-expense]')?.addEventListener('click', () => {
    if (typeof _openExpenseModal === 'function') _openExpenseModal(null);
  });
  body.querySelector('[data-daysheet-add-stay]')?.addEventListener('click', () => {
    if (typeof openAddModal === 'function') {
      openAddModal(date);
      if (typeof setType === 'function') setType('accommodation');
    }
  });
  body.querySelector('[data-ai-open-settings]')?.addEventListener('click', () => {
    closeSheet();
    if (typeof openSettingsSheet === 'function') openSettingsSheet();
  });

  const aiToggle = body.querySelector('#daysheet-ai-toggle');
  const aiPanel = body.querySelector('#daysheet-ai-panel');
  if (aiToggle && aiPanel && typeof _wireAiToggle === 'function') {
    const aiCtx = body.querySelector('.ai-trigger-ctx')?.textContent || '';
    _wireAiToggle(aiToggle, aiPanel, date, aiCtx);
  }

  backdrop.hidden = false;
  sheet.hidden = false;
}

function closeSheet() {
  const sheet = document.getElementById('day-sheet');
  const backdrop = document.getElementById('day-sheet-backdrop');
  if (sheet) { sheet.hidden = true; sheet.classList.remove('sheet--day', 'sheet--stay'); }
  if (backdrop) backdrop.hidden = true;
}

// ── Swipe-down-to-dismiss for bottom sheets ─────────────────────────
// Shared by the day/stay sheet and the settings sheet. A drag must begin
// on a non-scrolling grab zone (handle / header) so the sheet body keeps
// scrolling normally; a downward drag past a threshold — or a quick flick
// — closes it, anything shorter springs back. Bound once to the persistent
// panel element; safe to call on desktop (the sheets only render ≤640px).
function attachSheetDrag(panel, options) {
  if (!panel || typeof panel.addEventListener !== 'function') return;
  const opts = options || {};
  const zoneSelector = opts.zoneSelector || null;
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : function () {};
  const backdrop = opts.backdrop || null;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CLOSE_PX = 90;
  const FLICK_VELOCITY = 0.5; // px/ms, downward

  let state = 'idle'; // idle | pending | dragging | rejected
  let startX = 0, startY = 0, lastY = 0, lastT = 0, dy = 0, vy = 0, pid = null;

  function clearInline() {
    panel.classList.remove('sheet-dragging');
    panel.style.transition = '';
    panel.style.transform = '';
    if (backdrop) { backdrop.style.transition = ''; backdrop.style.opacity = ''; }
  }

  function settle(close) {
    if (reduceMotion) { clearInline(); if (close) onClose(); state = 'idle'; return; }
    const h = panel.offsetHeight || window.innerHeight;
    panel.style.transition = 'transform .18s ease';
    panel.style.transform = close ? `translateY(${h}px)` : 'translateY(0)';
    if (backdrop) {
      backdrop.style.transition = 'opacity .18s ease';
      backdrop.style.opacity = close ? '0' : '';
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      panel.removeEventListener('transitionend', finish);
      clearInline();
      if (close) onClose();
      state = 'idle';
    };
    panel.addEventListener('transitionend', finish);
    setTimeout(finish, 260);
  }

  panel.addEventListener('pointerdown', e => {
    if (state !== 'idle' || !e.isPrimary) return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    if (zoneSelector && !e.target.closest(zoneSelector)) return;
    state = 'pending';
    pid = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    lastY = e.clientY; lastT = e.timeStamp;
    dy = 0; vy = 0;
  });

  panel.addEventListener('pointermove', e => {
    if (e.pointerId !== pid) return;
    if (state === 'pending') {
      const tx = e.clientX - startX, ty = e.clientY - startY;
      if (Math.abs(tx) > 8 && Math.abs(tx) > Math.abs(ty)) { state = 'rejected'; return; }
      if (ty > 5 && ty >= Math.abs(tx)) {
        state = 'dragging';
        panel.classList.add('sheet-dragging');
        try { panel.setPointerCapture(pid); } catch (_) { /* not capturable */ }
      } else {
        return;
      }
    }
    if (state !== 'dragging') return;
    dy = Math.max(0, e.clientY - startY);
    const now = e.timeStamp;
    if (now > lastT) { vy = (e.clientY - lastY) / (now - lastT); lastY = e.clientY; lastT = now; }
    panel.style.transform = `translateY(${dy}px)`;
    if (backdrop) {
      const h = panel.offsetHeight || window.innerHeight;
      backdrop.style.opacity = String(Math.max(0, Math.min(1, 1 - dy / (h * 0.6))));
    }
    e.preventDefault();
  });

  function end(e) {
    if (e.pointerId !== pid) return;
    try { panel.releasePointerCapture(pid); } catch (_) { /* already released */ }
    if (state === 'dragging') settle(dy > CLOSE_PX || vy > FLICK_VELOCITY);
    else state = 'idle';
    pid = null;
  }
  panel.addEventListener('pointerup', end);
  panel.addEventListener('pointercancel', e => {
    if (e.pointerId !== pid) return;
    if (state === 'dragging') clearInline();
    state = 'idle';
    pid = null;
  });
}

// ── Toast ───────────────────────────────────────

let _toastTimer = null;
function showToast(message) {
  const el = document.getElementById('mobile-toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.hidden = true; }, 1600);
}
