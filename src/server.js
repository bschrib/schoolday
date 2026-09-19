import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db, { kvGet, kvSet } from './db.js';
import bus from './bus.js';
import queue from './queue.js';
import { providerFor, parentsquare, subjectColorKey, dayKey, psStudentSchools } from './providers.js';
import { computeLoad } from './load.js';

const PORT = Number(process.env.PORT || 4180);
const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const STUDENT = process.env.STUDENT_NAME || 'Avery';
const SCHOOL = process.env.SCHOOL_NAME || 'Riverside Middle School';
const PROVIDER_NAME = process.env.PROVIDER || 'demo';
const provider = providerFor(PROVIDER_NAME);
const ps = parentsquare();
const MSG_TTL_MS = 5 * 60 * 1000;

// ------------------------------------------------------------- helpers

function hashId(source, externalId) {
  return crypto.createHash('sha256').update(`${source}:${externalId}`).digest('hex').slice(0, 24);
}

function studentName(s) {
  return `${s.firstName || ''} ${s.lastName || ''}`.trim();
}

function activeStudentId() {
  return kvGet('ic_active_student_id') || process.env.IC_STUDENT_ID || '';
}

// The student the sync actually uses: the explicit selection, or the
// account's first student when nothing has been chosen yet.
function effectiveActiveStudentId() {
  const explicit = activeStudentId();
  if (explicit) return explicit;
  const students = cachedStudents();
  return students.length > 0 ? String(students[0].personID) : '';
}

function cachedStudents() {
  const raw = kvGet('ic_students_cache');
  if (!raw) return [];
  try {
    return JSON.parse(raw).students || [];
  } catch {
    return [];
  }
}

function activeStudentName() {
  if (!provider.students) return '';
  const id = effectiveActiveStudentId();
  const hit = cachedStudents().find((s) => String(s.personID) === String(id));
  return hit ? studentName(hit) : '';
}

function cachedMessages(schoolId) {
  const raw = kvGet(`ps_messages_cache_${schoolId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// The ParentSquare school the active student's page shows: the per-student
// mapping (PS_STUDENT_SCHOOLS) wins, then the default PS_SCHOOL_ID.
function studentPSchoolId() {
  const mapped = psStudentSchools()[String(effectiveActiveStudentId())];
  return mapped || process.env.PS_SCHOOL_ID || '';
}

function allPSchoolIds() {
  const ids = new Set(Object.values(psStudentSchools()));
  if (process.env.PS_SCHOOL_ID) ids.add(process.env.PS_SCHOOL_ID);
  return [...ids];
}

// ------------------------------------------------------------- workers

queue.register('sync', async () => {
  const runId = crypto.randomUUID();
  db.prepare('INSERT INTO sync_runs (id, source, started_at) VALUES (?, ?, ?)')
    .run(runId, provider.name, new Date().toISOString());
  let rows;
  let student = '';
  if (provider.students && provider.listFor) {
    const students = await provider.students();
    kvSet('ic_students_cache', JSON.stringify({ at: Date.now(), students }));
    const id = effectiveActiveStudentId();
    const target = students.find((s) => String(s.personID) === String(id)) || students[0];
    if (!target) throw new Error('ic: no student found in account');
    student = studentName(target);
    rows = await provider.listFor(target.personID);
  } else {
    rows = await provider.list(new Date());
  }
  const upsert = db.prepare(
    `INSERT INTO assignments (id, source, external_id, student, subject, course, title, due, est_minutes, status, score, notes, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, external_id) DO UPDATE SET
       student = excluded.student,
       subject = excluded.subject,
       course = excluded.course,
       title = excluded.title,
       due = excluded.due,
       est_minutes = excluded.est_minutes,
       status = CASE WHEN assignments.status = 'done' THEN 'done' ELSE excluded.status END,
       score = excluded.score,
       notes = excluded.notes,
       fetched_at = excluded.fetched_at`
  );
  const nowIso = new Date().toISOString();
  for (const r of rows) {
    const id = hashId(provider.name, r.externalId);
    upsert.run(
      id, provider.name, r.externalId, student,
      subjectColorKey(r.subject), r.course || '', r.title,
      r.due, r.estMinutes || 0, r.status || 'open', r.score || '', r.notes || '', nowIso
    );
  }
  db.prepare('UPDATE sync_runs SET finished_at = ?, status = ?, count = ? WHERE id = ?')
    .run(nowIso, 'ok', rows.length, runId);
  bus.publish('sync.completed', { source: provider.name, count: rows.length });
  const load = computeLoad(undefined, activeStudentName());
  // Best-effort: refresh each school's ParentSquare cache in the same pass,
  // so switching students never shows the other kid's school.
  for (const sid of allPSchoolIds()) {
    try {
      const [feeds, threads] = await Promise.all([ps.feeds(sid), ps.inbox(sid)]);
      kvSet(`ps_messages_cache_${sid}`, JSON.stringify({ at: Date.now(), school: feeds.school, feeds: feeds.posts, threads, error: null }));
    } catch (err) {
      kvSet(`ps_messages_cache_${sid}`, JSON.stringify({ at: Date.now(), school: '', feeds: [], threads: [], error: err.message }));
      bus.publish('messages.error', { error: err.message });
    }
  }
  bus.publish('messages.refreshed', { schools: allPSchoolIds().length });
  return { count: rows.length };
});

queue.register('recompute', async () => {
  const load = computeLoad(undefined, activeStudentName());
  bus.publish('load.recomputed', { minutes: load.minutesToday, index: load.index });
});

// ------------------------------------------------------------- api

function dayLabelFor(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(date, today)) return 'Today';
  if (same(date, tomorrow)) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function aheadGroups(load) {
  const groups = new Map();
  const push = (row) => {
    if (!groups.has(row.dueKey)) groups.set(row.dueKey, []);
    groups.get(row.dueKey).push(row);
  };
  for (const r of load.tomorrow) push(r);
  for (const r of load.week) push(r);
  return [...groups.keys()]
    .sort()
    .map((day) => ({ day, label: dayLabelFor(day), rows: groups.get(day) }));
}

function studentView(s) {
  return {
    personID: s.personID,
    name: studentName(s),
    school: (s.enrollments && s.enrollments[0] && s.enrollments[0].schoolName) || '',
    grade: (s.enrollments && s.enrollments[0] && s.enrollments[0].grade) || '',
  };
}

function state() {
  const now = new Date();
  const student = activeStudentName();
  const load = computeLoad(now, student);
  const lastRun = queue.lastSync();
  const lastSyncAt = kvGet('last_sync_at');
  const events = bus.recent(8);
  const students = cachedStudents();
  const recentHref = provider.assignmentListUrl
    ? provider.assignmentListUrl(effectiveActiveStudentId())
    : null;
  return {
    student: student || STUDENT,
    school: SCHOOL,
    generatedAt: now.toISOString(),
    day: {
      date: dayKey(now),
      loadIndex: load.index,
      loadLabel: load.label,
      minutesToday: load.minutesToday,
      target: load.target,
      blocks: load.today.map((r) => ({
        id: r.id,
        title: r.title,
        subject: r.subject,
        course: r.course,
        due: r.due,
        dueLabel: r.dueLabel,
        estMinutes: r.estMinutes,
        done: r.done,
        overdue: !r.done && new Date(r.due) < now,
      })),
    },
    ledger: {
      today: load.today,
      overdue: load.overdue,
      ahead: aheadGroups(load),
    },
    updates: {
      recent: recentHref
        ? load.recent.map((r) => ({ ...r, href: recentHref }))
        : load.recent,
    },
    week: {
      subjects: load.subjects,
      heaviestDay: load.heaviestDay
        ? { ...load.heaviestDay, label: dayLabelFor(load.heaviestDay.date) }
        : null,
    },
    students: {
      available: Boolean(provider.students),
      list: students.map(studentView),
      active: effectiveActiveStudentId(),
    },
    messages: cachedMessages(studentPSchoolId()),
    portal: provider.portal ? { label: provider.label, url: provider.portal } : null,
    psBase: process.env.PS_BASE_URL || '',
    quickLinks: [
      ...(provider.quickLinks || []),
      ...(process.env.PS_BASE_URL && studentPSchoolId() && process.env.PS_USER_ID
        ? [{ label: 'Message a teacher', url: `${process.env.PS_BASE_URL}/schools/${studentPSchoolId()}/users/${process.env.PS_USER_ID}/chats/new?private=true` }]
        : []),
    ],
    sync: {
      source: provider.label,
      provider: provider.name,
      lastPull: lastRun ? lastRun.finished_at : null,
      lastStatus: lastRun ? lastRun.status : null,
      nextPollInSec: lastSyncAt
        ? Math.max(0, Math.round((Number(lastSyncAt) + 10 * 60 * 1000 - Date.now()) / 1000))
        : 0,
      queueDepth: queue.depth(),
    },
    events,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, state());
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, uptime: process.uptime() });
    }
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      const id = queue.enqueue('sync');
      return json(res, 202, { jobId: id });
    }
    if (url.pathname === '/api/students') {
      if (req.method === 'GET') {
        if (!provider.students) return json(res, 200, { list: [], active: '' });
        if (cachedStudents().length === 0) {
          const students = await provider.students();
          kvSet('ic_students_cache', JSON.stringify({ at: Date.now(), students }));
        }
        return json(res, 200, {
          list: cachedStudents().map(studentView),
          active: effectiveActiveStudentId(),
        });
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const personID = String(body.personID || '');
        if (!/^\d+$/.test(personID)) return json(res, 400, { error: 'personID must be numeric' });
        kvSet('ic_active_student_id', personID);
        queue.enqueue('sync');
        return json(res, 200, { ok: true, active: personID });
      }
      return json(res, 405, { error: 'method not allowed' });
    }
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const sid = studentPSchoolId();
      const cached = cachedMessages(sid);
      if (cached && Date.now() - cached.at < MSG_TTL_MS) return json(res, 200, cached);
      try {
        const [feeds, threads] = await Promise.all([ps.feeds(sid), ps.inbox(sid)]);
        const data = { at: Date.now(), school: feeds.school, feeds: feeds.posts, threads, error: null };
        kvSet(`ps_messages_cache_${sid}`, JSON.stringify(data));
        return json(res, 200, data);
      } catch (err) {
        return json(res, 200, { at: Date.now(), school: '', feeds: [], threads: [], error: err.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/messages/refresh') {
      for (const sid of allPSchoolIds()) {
        kvSet(`ps_messages_cache_${sid}`, JSON.stringify({ at: 0, school: '', feeds: [], threads: [], error: null }));
      }
      queue.enqueue('sync');
      return json(res, 202, { ok: true });
    }
    const m = url.pathname.match(/^\/api\/assignments\/([^/]+)\/complete$/);
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]);
      const r = db.prepare('UPDATE assignments SET status = ? WHERE id = ?').run('done', id);
      if (r.changes > 0) {
        bus.publish('assignment.done', { id });
        const load = computeLoad(undefined, activeStudentName());
        bus.publish('load.recomputed', { minutes: load.minutesToday, index: load.index });
      }
      return json(res, 200, { ok: r.changes > 0 });
    }
    if (req.method === 'GET') {
      return serveStatic(url.pathname, res);
    }
    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

function serveStatic(pathname, res) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(404), res.end('not found');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    const type =
      file.endsWith('.css') ? 'text/css' :
      file.endsWith('.js') ? 'text/javascript' :
      'text/html';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

server.listen(PORT, () => {
  console.log(`schoolday listening on :${PORT} (provider: ${provider.name})`);
  queue.start();
});
