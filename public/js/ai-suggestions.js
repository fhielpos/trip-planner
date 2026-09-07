/* =============================================
   AI Activity Suggestions — a small panel that asks the model for a few
   things to do on one trip day. Shared by the Today view (desktop +
   mobile) and the planner's day-card expand view.

   These are draft ideas: cards are drawn with a dashed edge (vs. the
   solid hairline of committed entries) and only enter the calendar once
   the user accepts one through the normal add-activity modal.

   The panel holds a per-day "pool" of suggestions (union of every
   category combo fetched so far). Toggling the category chips filters the
   pool locally — no network — and only an explicit "get more" or
   "refresh" hits the model again.
   ============================================= */

const AI_CATS = ['sightseeing', 'culture', 'outdoors', 'food', 'nightlife', 'shopping', 'daytrip'];
const AI_CATS_LS_KEY = 'tp_ai_categories';
const AI_ADV_LS_KEY = 'tp_ai_advanced_open';

// Category → dot colour token for the redesigned (5e) result cards.
const AI_CAT_DOT = {
  culture: '--cat-culture', sightseeing: '--cat-culture', outdoors: '--cat-culture',
  food: '--cat-food', nightlife: '--cat-shopping', shopping: '--cat-shopping',
  daytrip: '--cat-transport',
};

function _aiEscHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Selected categories — persisted globally (not per-date), same pattern as
// the app's `lang` / `theme`. Always returns a clean whitelisted array.
function _aiSelectedCats() {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_CATS_LS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(c => AI_CATS.includes(c)) : [];
  } catch { return []; }
}
function _aiSetSelectedCats(cats) {
  try { localStorage.setItem(AI_CATS_LS_KEY, JSON.stringify(cats)); } catch { /* private mode */ }
}

// Dismissed suggestions, per date — session-only, never persisted.
const _aiDismissed = new Map(); // dateStr -> Set<name>
function _aiDismissedSet(date) {
  if (!_aiDismissed.has(date)) _aiDismissed.set(date, new Set());
  return _aiDismissed.get(date);
}

// Active free-text "advanced" brief, per date — session-only. When set it
// replaces the category chips: the model is steered by the text and no
// local category filter is applied. One brief per day (server-enforced).
const _aiBrief = new Map(); // dateStr -> string

// Whether the collapsible Advanced row is expanded — remembered globally,
// same pattern as the category / lang / theme prefs.
function _aiAdvOpen() {
  try { return localStorage.getItem(AI_ADV_LS_KEY) === '1'; } catch { return false; }
}
function _aiSetAdvOpen(v) {
  try { localStorage.setItem(AI_ADV_LS_KEY, v ? '1' : '0'); } catch { /* private mode */ }
}

// Per-date suggestion state, kept for the whole session. Survives closing
// the panel, switching days, adding an event, and any DOM re-render — so
// re-opening a day's panel shows the same pool with zero network. The
// only writes are a successful fetch (first open, Refresh, or "get
// more"); nothing else touches it.
const _aiCache = new Map(); // dateStr -> { pool: [] | null, refreshesLeft }
function _aiEntry(date) {
  if (!_aiCache.has(date)) {
    _aiCache.set(date, { pool: null, refreshesLeft: undefined, briefsLeft: undefined, error: null, locked: false, lockedUntil: null });
  }
  return _aiCache.get(date);
}

function _aiLang() {
  return getDateLocale().slice(0, 2) === 'es' ? 'es' : 'en';
}

// No coordinates come back from the model, so "already on the calendar"
// is a title match against that day's entries (case-insensitive, either
// direction so "Louvre" matches "Louvre Museum").
function _aiAlreadyAdded(name, date) {
  const n = name.toLowerCase();
  return (tripData?.calendar || []).some(e => {
    if (e.date !== date || !e.title) return false;
    const t = e.title.toLowerCase();
    return t === n || t.includes(n) || n.includes(t);
  });
}

function _aiFmtDuration(h) {
  if (!h) return '';
  if (h === 1.5) return '1½h';
  if (h === Math.round(h)) return `${h}h`;
  return `${h}h`;
}

// The always-present "Suggest things to do" trigger row (handoff §13 / 5e).
// One markup for both mobile surfaces — the Day sheet and the Today tab.
// `idPrefix` namespaces the toggle/panel ids; `enabled` picks the keyed row
// vs. the quiet unkeyed card; `context` is the Mono basis line.
function aiTriggerHtml({ idPrefix, enabled, context }) {
  if (enabled) {
    return `
    <div class="ai-trigger-wrap">
      <button type="button" class="ai-trigger" id="${idPrefix}-ai-toggle">
        <span class="ai-trigger-glyph">✦</span>
        <span class="ai-trigger-text">
          <span class="label ai-trigger-title">${t('aiSuggestions.triggerTitle')}</span>
          <span class="mono ai-trigger-ctx">${_aiEscHtml(context || '')}</span>
        </span>
        <span class="ai-trigger-chev">›</span>
      </button>
      <div class="ai-panel ai-panel--m" id="${idPrefix}-ai-panel" hidden></div>
    </div>`;
  }
  return `
    <div class="ai-trigger-wrap">
      <div class="ai-trigger ai-trigger--off">
        <span class="ai-trigger-glyph ai-trigger-glyph--off">✦</span>
        <span class="ai-trigger-text">
          <span class="label ai-trigger-title ai-trigger-title--off">${t('aiSuggestions.triggerTitle')}</span>
          <span class="ai-trigger-ctx ai-trigger-ctx--off">${t('daySheet.aiUnkeyed')}</span>
        </span>
      </div>
      <button type="button" class="label ai-trigger-settings" data-ai-open-settings>${t('daySheet.goToSettings')} ›</button>
    </div>`;
}

function _aiMsgEl(text) {
  const el = document.createElement('div');
  el.className = 'ai-panel-msg';
  el.textContent = text;
  return el;
}

// "Working" state while a fetch is in flight — the label plus a couple of
// pulsing dashed placeholders shaped like the cards that are coming.
function _aiLoadingEl() {
  const wrap = document.createElement('div');
  wrap.className = 'ai-loading';
  wrap.appendChild(_aiEyebrow());
  wrap.appendChild(_aiMsgEl(t('aiSuggestions.loading')));
  for (let i = 0; i < 3; i++) {
    const sk = document.createElement('div');
    sk.className = 'ai-skel';
    sk.innerHTML = '<div class="ai-skel-bar"></div><div class="ai-skel-bar"></div><div class="ai-skel-bar"></div>';
    wrap.appendChild(sk);
  }
  return wrap;
}

function _aiEyebrow() {
  const el = document.createElement('div');
  el.className = 'today-block-title ai-panel-eyebrow';
  el.textContent = t('aiSuggestions.eyebrow');
  return el;
}

// ---- redesigned (5e) results surface: header, basis line, cards ----

// Header row: ✦ Sugerir cosas que hacer  +  Otra vez › (refresh, when a
// refresh is still available for the day).
function _aiResultsHead(container, date) {
  const el = document.createElement('div');
  el.className = 'ai-results-head';
  const left = document.createElement('span');
  left.className = 'label ai-results-title';
  left.textContent = '✦ ' + t('aiSuggestions.triggerTitle');
  el.appendChild(left);
  // "Otra vez" belongs to the chip view — a brief is a one-shot for the day.
  if (!_aiBrief.get(date) && typeof _aiEntry(date).refreshesLeft === 'number' && _aiEntry(date).refreshesLeft > 0) {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'label ai-again';
    again.textContent = t('aiSuggestions.again') + ' ›';
    again.addEventListener('click', e => { e.stopPropagation(); _aiFetch(container, date, { refresh: true }); });
    el.appendChild(again);
  }
  return el;
}

// Mono line stating what the suggestions are based on — the same city ·
// temp · plan-count string the trigger row shows, handed in via the
// panel's data-ai-ctx (only the mobile surfaces set it).
function _aiBasisEl(text) {
  const el = document.createElement('div');
  el.className = 'mono ai-basis';
  el.textContent = text;
  return el;
}

function _aiDisclaimerEl() {
  const el = document.createElement('div');
  el.className = 'label ai-disclaimer';
  el.textContent = t('aiSuggestions.disclaimer');
  return el;
}

// Post an untimed activity straight to the calendar (no add modal), the
// way app.js's #modal-form submit does — so it lands under "Durante el
// día". The card confirms inline, then the panel re-renders it away.
async function _aiAddUntimed(s, date, card, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await fetch('/api/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'activity',
        title: s.name,
        address: s.address || '',
        notes: s.reason || '',
        date,
        startTime: '',
        endTime: '',
        lat: null,
        lon: null,
      }),
    });
    if (!r.ok) throw new Error(String(r.status));
    const created = await r.json();
    if (typeof tripData !== 'undefined' && Array.isArray(tripData.calendar)) tripData.calendar.push(created);
    card.classList.add('ai-card--added');
    btn.textContent = t('aiSuggestions.added');
    if (typeof renderPlanner === 'function') renderPlanner();
    if (typeof renderInfoBar === 'function') renderInfoBar();
    if (typeof renderMap === 'function') {
      renderMap(tripData.flights, tripData.trains, tripData.accommodations, tripData.airports, tripData.calendar);
    }
    setTimeout(() => {
      if (typeof renderToday === 'function') renderToday(tripData);
      if (typeof refreshOpenAiPanels === 'function') refreshOpenAiPanels();
    }, 900);
  } catch (e) {
    console.error('[ai-suggestions] add failed:', e);
    btn.disabled = false;
    btn.textContent = t('aiSuggestions.add');
    card.appendChild(_aiMsgEl(t('modal.saveFailed')));
  }
}

// A 5e result card: title 15/600, .label meta line with a category dot,
// a reason tied to trip data, and an Agregar button.
function _aiCard5e(s, date) {
  const added = _aiAlreadyAdded(s.name, date);
  const meta = [
    t('aiSuggestions.cat.' + s.category),
    _aiFmtDuration(s.durationHours),
    s.suggestedStartTime || '',
  ].filter(Boolean).join(' · ');
  const dotVar = AI_CAT_DOT[s.category] || '--accent';

  const card = document.createElement('div');
  card.className = 'ai-card ai-card--5e' + (added ? ' ai-card--added' : '');
  card.innerHTML = `
    <div class="ai-card5e-main">
      <div class="ai-card5e-title">${_aiEscHtml(s.name)}</div>
      ${meta ? `<div class="label ai-card5e-meta"><span class="ai-card5e-dot" style="background:var(${dotVar})"></span>${_aiEscHtml(meta)}</div>` : ''}
      ${s.reason ? `<div class="ai-card5e-reason">${_aiEscHtml(s.reason)}</div>` : ''}
    </div>
    <button type="button" class="label ai-card5e-add"${added ? ' disabled' : ''}>${added ? t('aiSuggestions.added') : t('aiSuggestions.add')}</button>`;

  if (!added) {
    const btn = card.querySelector('.ai-card5e-add');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _aiAddUntimed(s, date, card, btn);
    });
  }
  return card;
}

function _aiCard(s, date) {
  const added = _aiAlreadyAdded(s.name, date);
  const meta = [
    t('aiSuggestions.cat.' + s.category),
    _aiFmtDuration(s.durationHours),
    s.suggestedStartTime || '',
  ].filter(Boolean).join(' · ');

  const card = document.createElement('div');
  card.className = 'ai-card';
  card.innerHTML = `
    <div class="ai-card-top">
      <span class="ai-card-name">${_aiEscHtml(s.name)}</span>
      <div class="ai-card-actions">
        <button type="button" class="rec-card-add"${added ? ' disabled' : ''}>
          ${added ? t('aiSuggestions.added') : t('aiSuggestions.add')}
        </button>
        <button type="button" class="ai-card-dismiss" aria-label="${_aiEscHtml(t('aiSuggestions.dismiss'))}">&times;</button>
      </div>
    </div>
    ${meta ? `<div class="ai-card-meta">${_aiEscHtml(meta)}</div>` : ''}
    ${s.reason ? `<div class="ai-card-reason" title="${_aiEscHtml(s.reason)}">${_aiEscHtml(s.reason)}</div>` : ''}`;

  const reasonEl = card.querySelector('.ai-card-reason');
  reasonEl?.addEventListener('click', e => {
    e.stopPropagation();
    reasonEl.classList.toggle('ai-card-reason--expanded');
  });

  if (!added) {
    card.querySelector('.rec-card-add').addEventListener('click', e => {
      // Day cards have a click-to-expand handler on the card itself —
      // stop the click before it bubbles and toggles the card.
      e.stopPropagation();
      openAddModal(date, {
        title: s.name,
        address: s.address || '',
        notes: s.reason || '',
        startTime: s.suggestedStartTime || '',
      });
      // On save, app.js calls refreshOpenAiPanels() and this card leaves
      // the list (already on the calendar); on cancel nothing changes.
    });
  }
  card.querySelector('.ai-card-dismiss').addEventListener('click', e => {
    e.stopPropagation();
    _aiDismissedSet(date).add(s.name);
    card.classList.add('ai-card--leaving');
    setTimeout(() => _aiRenderPanel(card.closest('.ai-panel'), date), 160);
  });
  return card;
}

function _aiCatChips(container, date) {
  const selected = _aiSelectedCats();
  const row = document.createElement('div');
  row.className = 'ai-cat-row';
  AI_CATS.forEach(cat => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ai-cat-chip' + (selected.includes(cat) ? ' is-on' : '');
    chip.textContent = t('aiSuggestions.cat.' + cat);
    chip.setAttribute('aria-pressed', selected.includes(cat) ? 'true' : 'false');
    chip.addEventListener('click', e => {
      e.stopPropagation();
      const cur = _aiSelectedCats();
      _aiSetSelectedCats(cur.includes(cat) ? cur.filter(c => c !== cat) : [...cur, cat]);
      _aiRenderPanel(container, date); // local re-filter only, no network
    });
    row.appendChild(chip);
  });
  return row;
}

// The collapsible "Advanced search" row: a free-text brief that steers the
// model directly, replacing the category chips for that day. One brief per
// day — the server enforces the quota and the input locks once it's spent.
function _aiAdvancedRow(container, date) {
  const brief = _aiBrief.get(date) || '';
  const briefsLeft = _aiEntry(date).briefsLeft;
  const usedUp = !brief && briefsLeft === 0;
  const open = _aiAdvOpen() || Boolean(brief);

  const wrap = document.createElement('div');
  wrap.className = 'ai-adv' + (open ? ' is-open' : '');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ai-adv-toggle';
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.innerHTML = `<span class="ai-adv-chev">›</span> ${_aiEscHtml(t('aiSuggestions.advanced'))}`;
  toggle.addEventListener('click', e => {
    e.stopPropagation();
    _aiSetAdvOpen(!open);
    _aiRenderPanel(container, date);
  });
  wrap.appendChild(toggle);
  if (!open) return wrap;

  const body = document.createElement('div');
  body.className = 'ai-adv-body';

  if (brief) {
    const active = document.createElement('div');
    active.className = 'label ai-adv-active';
    active.textContent = t('aiSuggestions.briefActive', { q: brief });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ai-adv-clear';
    clear.textContent = t('aiSuggestions.briefClear');
    clear.addEventListener('click', e => {
      e.stopPropagation();
      _aiBrief.delete(date);
      _aiRenderPanel(container, date); // back to chips + pooled view, no network
    });
    active.appendChild(clear);
    body.appendChild(active);
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ai-adv-input';
    input.maxLength = 120;
    input.placeholder = t('aiSuggestions.advancedHint');
    input.disabled = usedUp;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'ai-adv-go';
    go.textContent = t('aiSuggestions.briefSearch');
    go.disabled = usedUp;
    const submit = () => {
      const q = input.value.replace(/\s+/g, ' ').trim();
      if (!q) return;
      _aiBrief.set(date, q);
      _aiFetch(container, date, { brief: q });
    };
    go.addEventListener('click', e => { e.stopPropagation(); submit(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
    });
    const field = document.createElement('div');
    field.className = 'ai-adv-field';
    field.append(input, go);
    body.appendChild(field);
    if (usedUp) body.appendChild(_aiMsgEl(t('aiSuggestions.briefUsedUp')));
  }

  wrap.appendChild(body);
  return wrap;
}

// Render the panel from the per-date cached pool, filtered by the
// selected chips (or, with a brief active, the brief's steered results).
// No network here.
function _aiRenderPanel(container, date) {
  if (!container) return;
  const entry = _aiEntry(date);
  const pool = entry.pool || [];
  const brief = _aiBrief.get(date) || '';
  const selected = brief ? [] : _aiSelectedCats();
  const refreshesLeft = entry.refreshesLeft;
  const err = entry.error;
  const locked = entry.locked === true;

  // The mobile surfaces (Day sheet, Today tab) hand in a basis string on
  // the panel and get the redesigned 5e layout: a header, that Mono basis
  // line, the category chips, addable cards, a disclaimer.
  const basis = container.dataset.aiCtx || '';
  const mobile = Boolean(basis);

  container.dataset.aiDate = date; // lets refreshOpenAiPanels() re-render this one
  container.textContent = '';
  if (mobile) {
    container.appendChild(_aiResultsHead(container, date));
    container.appendChild(_aiBasisEl(basis));
  } else {
    container.appendChild(_aiEyebrow());
  }
  if (!brief) container.appendChild(_aiCatChips(container, date));
  container.appendChild(_aiAdvancedRow(container, date));

  // Drop anything dismissed or already on the calendar. app.js calls
  // refreshOpenAiPanels() after a calendar add, so an accepted suggestion
  // leaves the list right away (the greyed "Added" button in _aiCard only
  // shows in the brief window before that re-render).
  const dismissed = _aiDismissedSet(date);
  let shown = pool.filter(s => !dismissed.has(s.name) && !_aiAlreadyAdded(s.name, date));
  if (selected.length) shown = shown.filter(s => selected.includes(s.category));

  if (!shown.length) {
    if (locked) {
      const when = entry.lockedUntil ? fmtDate(String(entry.lockedUntil).slice(0, 10), { year: false }) : '';
      container.appendChild(_aiMsgEl(t('aiSuggestions.locked', { date: when })));
    } else {
      // "empty" covers both "nothing new for this day" and "the fetch failed".
      container.appendChild(_aiMsgEl(t(err || 'aiSuggestions.empty')));
      // A retry button right in the empty state. With a category filter on,
      // the "get more {cats}" button below already serves this purpose.
      // In brief mode only offer a retry when the fetch actually failed —
      // a genuinely empty brief result has already spent the day's search.
      if (brief) {
        if (err) {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'ai-more';
          retry.textContent = t('aiSuggestions.retry');
          retry.addEventListener('click', e => {
            e.stopPropagation();
            _aiFetch(container, date, { brief });
          });
          container.appendChild(retry);
        }
      } else if (!selected.length) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'ai-more';
        retry.textContent = t('aiSuggestions.retry');
        // On a failed fetch, retry plainly (may just succeed now); when the
        // day genuinely has nothing new, force a fresh look (costs a refresh).
        retry.addEventListener('click', e => {
          e.stopPropagation();
          _aiFetch(container, date, { refresh: !err });
        });
        container.appendChild(retry);
      }
    }
  } else if (mobile) {
    const list = document.createElement('div');
    list.className = 'ai-card5e-list';
    shown.slice(0, 6).forEach(s => list.appendChild(_aiCard5e(s, date)));
    container.appendChild(list);
  } else {
    shown.slice(0, 6).forEach(s => container.appendChild(_aiCard(s, date)));
  }

  // "Get more of X" — a thin filtered result with a category filter on.
  // Steered fetch for that combo; the server serves it from cache if it
  // already has it, so this never wastes a call. Doesn't spend a refresh.
  if (selected.length && shown.length < 3) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ai-more';
    more.textContent = t('aiSuggestions.getMore', {
      cats: selected.map(c => t('aiSuggestions.cat.' + c)).join(', '),
    });
    more.addEventListener('click', e => {
      e.stopPropagation();
      _aiFetch(container, date, { more: true });
    });
    container.appendChild(more);
  }

  if (mobile) {
    container.appendChild(_aiDisclaimerEl());
    return;
  }

  if (!brief && shown.length && typeof refreshesLeft === 'number' && refreshesLeft > 0) {
    const foot = document.createElement('div');
    foot.className = 'ai-panel-foot';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-refresh';
    btn.textContent = t('aiSuggestions.refresh');
    btn.addEventListener('click', e => { e.stopPropagation(); _aiFetch(container, date, { refresh: true }); });
    const count = document.createElement('span');
    count.className = 'ai-refresh-count';
    count.textContent = t('aiSuggestions.refreshesLeft', { n: refreshesLeft });
    foot.append(btn, count);
    container.appendChild(foot);
  }
}

// The only thing that talks to the server — first open of a date,
// Refresh, or "get more". The server still serves from its own cache
// unless `refresh` (or a `more` for a not-yet-fetched combo), so most
// calls here don't reach the model. Updates the per-date cache.
async function _aiFetch(container, date, { refresh = false, more = false, brief = '' } = {}) {
  const cats = brief ? [] : _aiSelectedCats();
  container.textContent = '';
  container.appendChild(_aiLoadingEl());

  try {
    const res = await fetch(`/api/ai-suggestions?lang=${_aiLang()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `more` lets the server serve a repeat of the same brief from cache.
      body: JSON.stringify({ date, refresh, more: more || Boolean(brief), categories: cats, brief }),
    });

    const entry = _aiEntry(date);
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      if (body.scope === 'brief') {
        // The day's one advanced search is already spent (e.g. used on
        // another device) — drop back to the chip view and mark it used.
        entry.briefsLeft = 0;
        _aiBrief.delete(date);
        _aiRenderPanel(container, date);
        return;
      }
      entry.locked = true;
      entry.lockedUntil = body.lockedUntil || null;
      _aiRenderPanel(container, date);
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error(`[ai-suggestions] ${res.status}:`, body.error || res.statusText);
      entry.error = 'aiSuggestions.loadFailed';
      _aiRenderPanel(container, date);
      return;
    }

    const payload = await res.json();
    entry.pool = Array.isArray(payload.pool) ? payload.pool : [];
    entry.refreshesLeft = payload.refreshesLeft;
    if (typeof payload.briefsLeft === 'number') entry.briefsLeft = payload.briefsLeft;
    entry.error = null;
    entry.locked = false;
    _aiRenderPanel(container, date);
  } catch (e) {
    console.error('[ai-suggestions] request failed:', e);
    _aiEntry(date).error = 'aiSuggestions.loadFailed';
    _aiRenderPanel(container, date);
  }
}

// Entry point — called by the Today toggles and the day-card button
// every time a panel opens. Serves the session cache with no network;
// only the very first open of a date fetches.
function renderAiSuggestions(container, date, context) {
  container.classList.add('rec-panel', 'ai-panel');
  // A basis string means a mobile surface (Day sheet / Today tab) → the
  // redesigned 5e layout; desktop passes nothing and keeps the eyebrow list.
  if (context) container.dataset.aiCtx = context;
  // Day cards own a click-to-expand handler; keep panel clicks from reaching it.
  if (!container.dataset.clickTrapped) {
    container.dataset.clickTrapped = '1';
    container.addEventListener('click', e => e.stopPropagation());
  }
  if (_aiEntry(date).pool !== null) {
    _aiRenderPanel(container, date);
  } else {
    _aiFetch(container, date, { refresh: false });
  }
}

// Re-render any open suggestion panel from its cached pool (no network) —
// called by app.js after a calendar add/edit/delete so a suggestion that
// now matches a calendar entry gets removed from the list at once.
function refreshOpenAiPanels() {
  document.querySelectorAll('.ai-panel').forEach(el => {
    const date = el.dataset.aiDate;
    if (el.hidden || !date || _aiEntry(date).pool === null) return;
    _aiRenderPanel(el, date);
  });
}

// Close every open suggestion panel — called by app.js when the add/edit
// modal opens, so the panel (which floats above the map, z-index 1002)
// can't sit on top of the dialog. The pool stays in _aiCache, so
// re-opening is instant and loses nothing.
function closeOpenAiPanels() {
  document.querySelectorAll('.day-recs-panel[data-ai-for]').forEach(p => p.remove());
  document.querySelectorAll('#today-ai-panel, #mtoday-ai-panel').forEach(p => {
    p.hidden = true;
    delete p.dataset.loaded; // next open re-renders from _aiCache (no fetch), dropping any just-added card
  });
}
