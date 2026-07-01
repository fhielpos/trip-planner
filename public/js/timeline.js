/* =============================================
   Stays Timeline — overlap & gap detection
   ============================================= */

// Overlaps: every pair of stays sharing at least one night.
// Gaps: nights inside [rangeStart, rangeEnd) not covered by any stay.
// A stay covers [check_in, check_out), so back-to-back stays are neither.
function computeStayIssues(stays, rangeStart, rangeEnd) {
  const sorted = [...stays].sort((a, b) => a.check_in.localeCompare(b.check_in));

  const overlaps = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      const start = a.check_in > b.check_in ? a.check_in : b.check_in;
      const end   = a.check_out < b.check_out ? a.check_out : b.check_out;
      if (start < end) overlaps.push({ a, b, start, end });
    }
  }

  const gaps = [];
  let cursor = rangeStart;
  for (const s of sorted) {
    if (s.check_in > cursor) gaps.push({ start: cursor, end: s.check_in });
    if (s.check_out > cursor) cursor = s.check_out;
  }
  if (cursor < rangeEnd) gaps.push({ start: cursor, end: rangeEnd });

  return { overlaps, gaps };
}

function _nights(start, end) {
  return Math.round((parseLocal(end) - parseLocal(start)) / 86400000);
}

function _stayColour(stay, index) {
  return stay.color ? hexToColour(stay.color) : PALETTE[index % PALETTE.length];
}

// Greedy lane assignment: a stay drops into the first lane it doesn't overlap.
// Non-overlapping itineraries collapse into a single lane.
function _assignLanes(stays) {
  const laneEnds = [];
  return stays.map(s => {
    let lane = laneEnds.findIndex(end => end <= s.check_in);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(s.check_out); }
    else laneEnds[lane] = s.check_out;
    return { stay: s, lane };
  });
}

function renderStaysTimeline(data) {
  const track  = document.getElementById('stays-timeline');
  const issues = document.getElementById('stays-issues');
  if (!track || !issues || !data) return;

  const stays = [...(data.accommodations || [])].sort((a, b) => a.check_in.localeCompare(b.check_in));
  track.innerHTML = '';
  issues.innerHTML = '';
  if (!stays.length) return;

  const rangeStart = data.trip.startDate < stays[0].check_in ? data.trip.startDate : stays[0].check_in;
  const lastOut    = stays.reduce((m, s) => s.check_out > m ? s.check_out : m, stays[0].check_out);
  const rangeEnd   = data.trip.endDate > lastOut ? data.trip.endDate : lastOut;
  const totalDays  = _nights(rangeStart, rangeEnd);
  const pos = d => (_nights(rangeStart, d) / totalDays) * 100;

  const { overlaps, gaps } = computeStayIssues(stays, rangeStart, rangeEnd);

  // Month ticks
  const axis = document.createElement('div');
  axis.className = 'tl-axis';
  for (let d = rangeStart; d < rangeEnd; d = addDays(d, 1)) {
    if (d !== rangeStart && !d.endsWith('-01')) continue;
    const tick = document.createElement('span');
    tick.className = 'tl-tick';
    tick.style.left = pos(d) + '%';
    tick.textContent = parseLocal(d).toLocaleDateString(getDateLocale(), { month: 'short' });
    axis.appendChild(tick);
  }
  track.appendChild(axis);

  // Issue strip: red where stays overlap, amber where nothing is booked
  const strip = document.createElement('div');
  strip.className = 'tl-issue-strip';
  for (const o of overlaps) {
    const seg = document.createElement('span');
    seg.className = 'tl-issue tl-issue--overlap';
    seg.style.left  = pos(o.start) + '%';
    seg.style.width = (pos(o.end) - pos(o.start)) + '%';
    seg.title = t('stays.overlap', { a: o.a.city, b: o.b.city, start: formatShort(o.start), end: formatShort(o.end), n: _nights(o.start, o.end) });
    strip.appendChild(seg);
  }
  for (const g of gaps) {
    const seg = document.createElement('span');
    seg.className = 'tl-issue tl-issue--gap';
    seg.style.left  = pos(g.start) + '%';
    seg.style.width = (pos(g.end) - pos(g.start)) + '%';
    seg.title = t('stays.gap', { start: formatShort(g.start), end: formatShort(g.end), n: _nights(g.start, g.end) });
    strip.appendChild(seg);
  }
  track.appendChild(strip);

  // Stay bars, one row per lane
  const placed = _assignLanes(stays);
  const laneCount = Math.max(...placed.map(p => p.lane)) + 1;
  const lanes = document.createElement('div');
  lanes.className = 'tl-lanes';
  lanes.style.setProperty('--tl-lane-count', laneCount);
  placed.forEach(({ stay, lane }, i) => {
    const colour = _stayColour(stay, i);
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'tl-bar';
    bar.style.left  = pos(stay.check_in) + '%';
    bar.style.width = (pos(stay.check_out) - pos(stay.check_in)) + '%';
    bar.style.top   = (lane * 2.1) + 'rem';
    bar.style.setProperty('--tl-bg',     colour.bg);
    bar.style.setProperty('--tl-border', colour.border);
    bar.style.setProperty('--tl-accent', colour.accent);
    bar.title = `${stay.city} · ${formatShort(stay.check_in)} – ${formatShort(stay.check_out)} · ${_nights(stay.check_in, stay.check_out)}n`;
    bar.innerHTML = `<span class="tl-bar-city">${stay.city}</span><span class="tl-bar-dates">${formatShort(stay.check_in)}–${formatShort(stay.check_out)}</span>`;
    bar.addEventListener('click', () => openStayModal(stay.id));
    lanes.appendChild(bar);
  });
  track.appendChild(lanes);

  // Issue list
  if (!overlaps.length && !gaps.length) {
    const ok = document.createElement('div');
    ok.className = 'tl-msg tl-msg--ok';
    ok.textContent = t('stays.ok');
    issues.appendChild(ok);
    return;
  }
  for (const o of overlaps) {
    const li = document.createElement('div');
    li.className = 'tl-msg tl-msg--overlap';
    li.textContent = t('stays.overlap', { a: o.a.city, b: o.b.city, start: formatShort(o.start), end: formatShort(o.end), n: _nights(o.start, o.end) });
    issues.appendChild(li);
  }
  for (const g of gaps) {
    const li = document.createElement('div');
    li.className = 'tl-msg tl-msg--gap';
    li.textContent = t('stays.gap', { start: formatShort(g.start), end: formatShort(g.end), n: _nights(g.start, g.end) });
    issues.appendChild(li);
  }
}
