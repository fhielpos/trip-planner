/* =============================================
   AI Activity Suggestions — a small panel that asks the model for a few
   things to do on one trip day. Shared by the Today view (desktop +
   mobile) and the planner's day-card expand view.

   These are draft ideas: cards are drawn with a dashed edge (vs. the
   solid hairline of committed entries) and only enter the calendar once
   the user accepts one through the normal add-activity modal.
   ============================================= */

function _aiEscHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Dismissed suggestions, per date — session-only, never persisted. A
// refreshed request that returns the same idea won't resurface it here.
const _aiDismissed = new Map(); // dateStr -> Set<name>

function _aiDismissedSet(date) {
  if (!_aiDismissed.has(date)) _aiDismissed.set(date, new Set());
  return _aiDismissed.get(date);
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
  if (h === Math.round(h)) return `${h}h`;
  if (h === 1.5) return '1½h';
  return `${h}h`;
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
    ${s.reason ? `<div class="ai-card-reason">${_aiEscHtml(s.reason)}</div>` : ''}`;

  const leave = after => {
    card.classList.add('ai-card--leaving');
    setTimeout(() => { card.remove(); if (after) after(); }, 160);
  };

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
      // Leave the card in place — if the user saves, `_aiAlreadyAdded`
      // hides it on the next render; if they cancel, it's still here.
    });
  }
  card.querySelector('.ai-card-dismiss').addEventListener('click', e => {
    e.stopPropagation();
    _aiDismissedSet(date).add(s.name);
    leave();
  });
  return card;
}

function _aiRenderList(container, date, payload) {
  container.textContent = '';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'today-block-title ai-panel-eyebrow';
  eyebrow.textContent = t('aiSuggestions.eyebrow');
  container.appendChild(eyebrow);

  const dismissed = _aiDismissedSet(date);
  const cards = (payload.suggestions || [])
    .filter(s => !dismissed.has(s.name))
    .filter(s => !_aiAlreadyAdded(s.name, date));

  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-panel-msg';
    empty.textContent = t('aiSuggestions.empty');
    container.appendChild(empty);
  } else {
    cards.forEach(s => container.appendChild(_aiCard(s, date)));
  }

  // Footer: refresh + remaining count, unless the daily allowance is spent.
  const left = payload.refreshesLeft;
  if (typeof left === 'number' && left > 0) {
    const foot = document.createElement('div');
    foot.className = 'ai-panel-foot';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-refresh';
    btn.textContent = t('aiSuggestions.refresh');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      renderAiSuggestions(container, date, { refresh: true });
    });
    const count = document.createElement('span');
    count.className = 'ai-refresh-count';
    count.textContent = t('aiSuggestions.refreshesLeft', { n: left });
    foot.append(btn, count);
    container.appendChild(foot);
  }
}

function _aiRenderLocked(container, lockedUntil) {
  container.textContent = '';
  const msg = document.createElement('div');
  msg.className = 'ai-panel-msg';
  const when = lockedUntil ? fmtDate(String(lockedUntil).slice(0, 10), { year: false }) : '';
  msg.textContent = t('aiSuggestions.locked', { date: when });
  container.appendChild(msg);
}

async function renderAiSuggestions(container, date, { refresh = false } = {}) {
  container.classList.add('rec-panel', 'ai-panel');
  // Day cards own a click-to-expand handler; keep panel clicks from reaching it.
  if (!container.dataset.clickTrapped) {
    container.dataset.clickTrapped = '1';
    container.addEventListener('click', e => e.stopPropagation());
  }
  container.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'ai-panel-msg';
  loading.textContent = t('aiSuggestions.loading');
  container.appendChild(loading);

  try {
    const res = await fetch(`/api/ai-suggestions?lang=${_aiLang()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, refresh }),
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      _aiRenderLocked(container, body.lockedUntil);
      return;
    }
    if (!res.ok) {
      container.textContent = '';
      const err = document.createElement('div');
      err.className = 'ai-panel-msg';
      err.textContent = t('aiSuggestions.loadFailed');
      container.appendChild(err);
      return;
    }
    _aiRenderList(container, date, await res.json());
  } catch {
    container.textContent = '';
    const err = document.createElement('div');
    err.className = 'ai-panel-msg';
    err.textContent = t('aiSuggestions.loadFailed');
    container.appendChild(err);
  }
}
