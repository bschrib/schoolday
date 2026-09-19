/* Schoolday — front of house. Fetches /api/state, renders the ledger. */

const $ = (id) => document.getElementById(id);

let state = null;
let lastRenderAt = 0;

const DAY_START = 7;
const DAY_SPAN = 15; // 7:00 -> 22:00

function pct(iso) {
  const d = new Date(iso);
  const h = d.getHours() + d.getMinutes() / 60;
  return Math.max(0, Math.min(100, ((h - DAY_START) / DAY_SPAN) * 100));
}

function fmtMins(m) {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function relTime(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}


/* ------------------------------------------------------------- render */

function render(s) {
  state = s;
  lastRenderAt = Date.now();

  const now = new Date(s.generatedAt);
  $('mastDate').textContent = now.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const load = s.day;
  $('loadNumber').textContent = load.minutesToday;
  $('loadScale').textContent = `of ${load.target} min`;
  const label = $('loadLabel');
  label.textContent = load.loadLabel;
  label.classList.toggle('hot', load.loadLabel === 'heavy' || load.loadLabel === 'crunch');
  $('loadSub').textContent = `${load.loadIndex}% of target`;
  $('loadIndex').dataset.tip =
    `Open minutes today: past-due work plus today's open assignments ` +
    `(${load.minutesToday} min), against the ${load.target}-minute daily target. ` +
    `That is ${load.loadIndex}% of the target.`;
  $('loadMeta').dataset.tip =
    `Load level from the share of the daily target that is open: ` +
    `light < 25% · steady < 60% · heavy < 85% · crunch ≥ 85%. ` +
    `Target is ${load.target} min (DAILY_TARGET_MINUTES).`;

  renderDayband(s);
  renderLedgerToday(s);
  renderOverdue(s);
  renderAhead(s);
  renderWeek(s);
  renderRecent(s);
  renderStudents(s);
  renderQuickLinks(s);
  renderMessages(s);
  renderSync(s);
  renderEvents(s);
}

function renderDayband(s) {
  const band = $('dayband');
  band.innerHTML = '';

  const ruler = document.createElement('div');
  ruler.className = 'ruler';
  for (let h = DAY_START; h <= DAY_START + DAY_SPAN; h++) {
    const tick = document.createElement('span');
    tick.className = 'tick' + (h % 3 === 1 ? ' major' : '');
    tick.style.left = `${((h - DAY_START) / DAY_SPAN) * 100}%`;
    ruler.appendChild(tick);
    if (h % 3 === 1 || h === 22) {
      const lab = document.createElement('span');
      lab.className = 'tick-label';
      lab.style.left = `calc(${((h - DAY_START) / DAY_SPAN) * 100}% + 4px)`;
      lab.textContent = clockLabel(h);
      ruler.appendChild(lab);
    }
  }
  band.appendChild(ruler);

  const sorted = [...s.day.blocks].sort((a, b) => new Date(a.due) - new Date(b.due));
  const laneEnd = [-100, -100];
  for (const b of sorted) {
    const p = pct(b.due);
    let lane = 0;
    if (p < laneEnd[0] + 3) lane = p >= laneEnd[1] + 3 ? 1 : (laneEnd[1] > laneEnd[0] ? 1 : 0);
    laneEnd[lane] = Math.min(100, p + 24);
    const el = document.createElement('div');
    el.className = `block subj-${b.subject}` + (b.done ? ' done' : '') + (b.overdue ? ' overdue' : '');
    el.style.left = `min(calc(${p}% - 6px), calc(100% - 186px))`;
    el.style.top = lane === 0 ? '44px' : '100px';
    el.innerHTML = `
      <div class="b-title"></div>
      <div class="b-meta"></div>`;
    el.querySelector('.b-title').textContent = b.title;
    el.querySelector('.b-meta').textContent = b.dueLabel + ' · ' + fmtMins(b.estMinutes);
    band.appendChild(el);
  }

  const line = document.createElement('div');
  line.className = 'nowline';
  line.id = 'nowline';
  const chip = document.createElement('span');
  chip.className = 'nowline-chip';
  chip.id = 'nowlineChip';
  line.appendChild(chip);
  band.appendChild(line);
  updateNowline();
}

function clockLabel(h) {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${ampm}`;
}

function updateNowline() {
  const line = $('nowline');
  if (!line) return;
  const now = new Date();
  const h = now.getHours() + now.getMinutes() / 60;
  const visible = h >= DAY_START && h <= DAY_START + DAY_SPAN;
  line.style.display = visible ? '' : 'none';
  if (visible) {
    line.style.left = `${((h - DAY_START) / DAY_SPAN) * 100}%`;
    $('nowlineChip').textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
}

function rowEl(row) {
  const el = document.createElement('div');
  el.className = 'row' + (row.done ? ' done' : '');
  el.dataset.id = row.id;

  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.setAttribute('aria-pressed', String(row.done));
  toggle.setAttribute('aria-label', row.done ? 'Mark not done' : 'Mark done');
  toggle.addEventListener('click', () => complete(row.id, toggle));

  const subj = document.createElement('span');
  subj.className = `subj subj-${row.subject}`;
  subj.innerHTML = `<span class="subj-dot"></span>`;
  subj.appendChild(document.createTextNode(row.subject));

  const main = document.createElement('div');
  main.className = 'row-main';
  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = row.title;
  const course = document.createElement('div');
  course.className = 'row-course';
  course.textContent = row.course;
  main.appendChild(title);
  if (row.course) main.appendChild(course);

  const est = document.createElement('span');
  est.className = 'est';
  est.textContent = fmtMins(row.estMinutes);

  const stamp = document.createElement('span');
  const now = new Date();
  const overdue = !row.done && new Date(row.due) < now;
  stamp.className = 'stamp ' + (row.done ? 'done' : overdue ? 'over' : 'due');
  if (row.done) {
    stamp.textContent = 'Done';
  } else if (overdue) {
    const daysLate = Math.floor((now - new Date(row.due)) / 86400000);
    stamp.textContent = daysLate >= 1
      ? `${daysLate}d late · ${whenLabel(row.dueKey)}`
      : `Overdue · ${row.dueLabel}`;
  } else {
    stamp.textContent = row.dueLabel;
  }

  el.append(toggle, subj, main, est, stamp);
  return el;
}

function renderLedgerToday(s) {
  const host = $('ledgerToday');
  host.innerHTML = '';
  if (s.ledger.today.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Nothing due today — a clean ledger.';
    host.appendChild(e);
    return;
  }
  for (const row of s.ledger.today) host.appendChild(rowEl(row));
}

function renderOverdue(s) {
  const host = $('ledgerOverdue');
  host.innerHTML = '';
  const rows = s.ledger.overdue || [];
  if (rows.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Nothing past due.';
    host.appendChild(e);
    return;
  }
  for (const row of rows) host.appendChild(rowEl(row));
}

function renderRecent(s) {
  const host = $('recentUpdates');
  host.innerHTML = '';
  const rows = (s.updates && s.updates.recent) || [];
  if (rows.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No graded updates in the last two weeks.';
    host.appendChild(e);
    return;
  }
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'update-row';

    const main = document.createElement('div');
    main.className = 'update-main';
    const title = document.createElement(row.href ? 'a' : 'div');
    title.className = 'row-title';
    title.textContent = row.title;
    if (row.href) {
      title.href = row.href;
      title.target = '_blank';
      title.rel = 'noopener';
      const ext = document.createElement('span');
      ext.className = 'ext';
      ext.textContent = '\u2197';
      title.appendChild(ext);
    }
    main.appendChild(title);
    if (row.course) {
      const course = document.createElement('div');
      course.className = 'row-course';
      course.textContent = row.course;
      main.appendChild(course);
    }
    if (row.notes) {
      const note = document.createElement('div');
      note.className = 'update-note';
      note.textContent = row.notes;
      main.appendChild(note);
    }

    const score = document.createElement('span');
    score.className = 'score-chip';
    score.textContent = row.score || '';

    const when = document.createElement('span');
    when.className = 'update-when';
    when.textContent = whenLabel(row.dueKey);

    el.append(main, score, when);
    host.appendChild(el);
  }
}

function whenLabel(dueKey) {
  const [y, m, d] = dueKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderAhead(s) {
  const host = $('ledgerNext');
  host.innerHTML = '';
  const groups = s.ledger.ahead;
  if (groups.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Nothing on the horizon. Enjoy the quiet.';
    host.appendChild(e);
    return;
  }
  for (const g of groups) {
    const group = document.createElement('div');
    group.className = 'day-group';
    const label = document.createElement('div');
    label.className = 'day-group-label';
    label.textContent = g.label;
    group.appendChild(label);
    for (const row of g.rows) group.appendChild(rowEl(row));
    host.appendChild(group);
  }
}

function renderWeek(s) {
  const host = $('subjectBars');
  host.innerHTML = '';
  if (s.week.subjects.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No open assignments in the next seven days.';
    host.appendChild(e);
    return;
  }
  const max = s.week.subjects[0].minutes || 1;
  for (const sub of s.week.subjects) {
    const row = document.createElement('div');
    row.className = `bar-row subj-${sub.name}`;
    row.innerHTML = `
      <span class="bar-label"></span>
      <div class="bar-track"><div class="bar-fill"></div></div>
      <span class="bar-value"></span>`;
    row.querySelector('.bar-label').textContent = sub.name;
    row.querySelector('.bar-value').textContent = fmtMins(sub.minutes);
    host.appendChild(row);
    requestAnimationFrame(() => {
      row.querySelector('.bar-fill').style.width = `${(sub.minutes / max) * 100}%`;
    });
  }
  const h = $('heaviest');
  if (s.week.heaviestDay) {
    h.innerHTML = '';
    h.append('Heaviest day: ');
    const strong = document.createElement('strong');
    strong.textContent = `${s.week.heaviestDay.label} — ${fmtMins(s.week.heaviestDay.minutes)}`;
    h.appendChild(strong);
  } else {
    h.textContent = '';
  }
}

function renderStudents(s) {
  const host = $('studentChips');
  host.innerHTML = '';
  const list = s.students && s.students.list || [];
  if (!s.students || !s.students.available || list.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const st of list) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (String(st.personID) === String(s.students.active) ? ' active' : '');
    chip.textContent = st.name;
    chip.title = st.school || '';
    chip.addEventListener('click', () => selectStudent(st.personID));
    host.appendChild(chip);
  }
}

function renderQuickLinks(s) {
  const host = $('quickLinks');
  host.innerHTML = '';
  const links = (s && s.quickLinks) || [];
  if (links.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const l of links) {
    const a = document.createElement('a');
    a.className = 'quick-link';
    a.href = l.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = l.label;
    const ext = document.createElement('span');
    ext.className = 'ext';
    ext.textContent = ' \u2197';
    a.appendChild(ext);
    host.appendChild(a);
  }
}

function renderMessages(s) {
  const feeds = $('msgFeeds');
  const threads = $('msgThreads');
  const status = $('msgStatus');
  feeds.innerHTML = '';
  threads.innerHTML = '';
  status.textContent = '';
  const m = s.messages;
  $('msgSchool').textContent = m && m.school ? m.school : '';
  if (!m) {
    status.textContent = 'Waiting for the first pull…';
    return;
  }
  if (m.error) status.textContent = `ParentSquare: ${m.error}`;
  for (const p of (m.feeds || []).slice(0, 5)) {
    const linked = Boolean(p.href && s.psBase);
    const el = document.createElement(linked ? 'a' : 'div');
    el.className = 'msg-item' + (linked ? ' ext' : '');
    if (linked) {
      el.href = s.psBase + p.href;
      el.target = '_blank';
      el.rel = 'noopener';
    }
    const head = document.createElement('div');
    head.className = 'msg-head';
    const title = document.createElement('span');
    title.className = 'msg-title';
    title.textContent = p.title || '(untitled)';
    const from = document.createElement('span');
    from.className = 'msg-from';
    from.textContent = p.from || '';
    head.append(title, from);
    el.appendChild(head);
    if (p.excerpt) {
      const ex = document.createElement('div');
      ex.className = 'msg-excerpt';
      ex.textContent = p.excerpt;
      el.appendChild(ex);
    }
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = p.when ? new Date(p.when).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    el.appendChild(meta);
    feeds.appendChild(el);
  }
  if ((m.feeds || []).length === 0 && !m.error) status.textContent = 'No feed posts right now.';
  for (const t of (m.threads || [])) {
    const linked = Boolean(t.href && s.psBase);
    const el = document.createElement(linked ? 'a' : 'div');
    el.className = 'msg-item' + (linked ? ' ext' : '');
    if (linked) {
      el.href = s.psBase + t.href;
      el.target = '_blank';
      el.rel = 'noopener';
    }
    const head = document.createElement('div');
    head.className = 'msg-head';
    const who = document.createElement('span');
    who.className = 'msg-title';
    who.textContent = t.recipient || 'Unknown';
    const count = document.createElement('span');
    count.className = 'msg-count';
    count.textContent = `${t.messages} messages`;
    head.append(who, count);
    el.appendChild(head);
    if (t.preview) {
      const ex = document.createElement('div');
      ex.className = 'msg-excerpt';
      ex.textContent = t.preview;
      el.appendChild(ex);
    }
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = t.lastMessageAt || '';
    el.appendChild(meta);
    threads.appendChild(el);
  }
  if ((m.threads || []).length === 0 && !(m.feeds || []).length) status.textContent = 'No direct messages.';
}

async function selectStudent(personID) {
  const res = await fetch('/api/students', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personID }),
  });
  if (res.ok) refresh();
}
function renderSync(s) {
  const src = $('syncSource');
  src.textContent = '';
  if (s.portal && s.portal.url) {
    const a = document.createElement('a');
    a.href = s.portal.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = s.portal.label;
    src.appendChild(a);
  } else {
    src.textContent = s.sync.source;
  }
  $('syncLast').textContent = s.sync.lastPull ? relTime(s.sync.lastPull) : 'never';
  $('syncNext').textContent = s.sync.nextPollInSec > 0
    ? `in ${Math.max(1, Math.round(s.sync.nextPollInSec / 60))}m`
    : 'due';
  $('queueDepth').textContent = s.sync.queueDepth > 0 ? `${s.sync.queueDepth} in flight` : 'clear';
}

function renderEvents(s) {
  const host = $('events');
  host.innerHTML = '';
  for (const ev of s.events) {
    const el = document.createElement('div');
    el.className = 'event';
    const topic = document.createElement('span');
    topic.className = 'ev-topic';
    topic.textContent = ev.topic.replace(/\./g, ' · ');
    const time = document.createElement('span');
    time.className = 'ev-time';
    time.textContent = relTime(ev.at);
    el.append(topic, time);
    host.appendChild(el);
  }
}

/* ---------------------------------------------------------- actions */

async function complete(id, toggle) {
  const row = state && [...document.querySelectorAll(`.row[data-id="${id}"]`)].map((el) => el);
  const res = await fetch(`/api/assignments/${encodeURIComponent(id)}/complete`, { method: 'POST' });
  if (res.ok) refresh();
}

async function pullNow() {
  const btn = $('pullBtn');
  btn.disabled = true;
  btn.textContent = 'Pulling…';
  await fetch('/api/sync', { method: 'POST' });
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Pull now';
    refresh();
  }, 2500);
}

async function refresh() {
  try {
    const res = await fetch('/api/state');
    if (res.ok) render(await res.json());
  } catch {
    /* keep last good render */
  }
}

function tickClock() {
  updateNowline();
  if (!state) return;
  $('syncLast').textContent = state.sync.lastPull ? relTime(state.sync.lastPull) : 'never';
  const evs = document.querySelectorAll('.event .ev-time');
  state.events.forEach((ev, i) => {
    if (evs[i]) evs[i].textContent = relTime(ev.at);
  });
}

$('pullBtn').addEventListener('click', pullNow);
refresh();
setInterval(refresh, 60000);
setInterval(tickClock, 30000);
