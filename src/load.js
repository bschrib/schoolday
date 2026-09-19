import db from './db.js';
import { dayKey } from './providers.js';

const DAILY_TARGET_MINUTES = Number(process.env.DAILY_TARGET_MINUTES || 180);

function loadLabel(index) {
  if (index < 25) return 'light';
  if (index < 60) return 'steady';
  if (index < 85) return 'heavy';
  return 'crunch';
}

function startOfDayIso(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
}

/**
 * Load — the numbers the site is built around.
 *
 * "Load index" = today's open minutes against the daily target (default 180
 * min). The weekly view sums the next 7 days per subject so the family can
 * see where the weight actually lands. All day boundaries are local.
 */
const RECENT_DAYS = 14;

export function computeLoad(now = new Date(), student = '') {
  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(new Date(now.getTime() + 86400000));
  const horizonKey = dayKey(new Date(now.getTime() + 7 * 86400000));
  const recentStartKey = dayKey(new Date(now.getTime() - (RECENT_DAYS - 1) * 86400000));

  // Window: the last two weeks (graded updates + past-due open work) through
  // the next seven days.
  const rows = db
    .prepare(
      `SELECT id, subject, course, title, due, est_minutes, status, score, notes
       FROM assignments
       WHERE due >= ? AND due <= ? AND student = ?
       ORDER BY due ASC`
    )
    .all(startOfDayIso(new Date(now.getTime() - (RECENT_DAYS - 1) * 86400000)), startOfDayIso(new Date(now.getTime() + 7 * 86400000)), student);

  let minutesToday = 0;
  let openWeekCount = 0;
  let nextUp = null;
  const bySubject = new Map();
  const byDay = new Map();
  const byDayCount = new Map();
  const todayRows = [];
  const overdueRows = [];
  const tomorrowRows = [];
  const weekRows = [];
  const recentRows = [];

  for (const r of rows) {
    const dueKey = dayKey(new Date(r.due));
    const done = r.status === 'done';
    const row = {
      id: r.id,
      title: r.title,
      subject: r.subject,
      course: r.course,
      estMinutes: r.est_minutes,
      due: r.due,
      dueKey,
      dueLabel: dueLabel(r.due),
      done,
      score: r.score || '',
      notes: r.notes || '',
    };
    if (dueKey === todayKey) {
      if (!done) minutesToday += r.est_minutes;
      todayRows.push(row);
    } else if (dueKey < todayKey) {
      if (!done) {
        overdueRows.push(row);
        minutesToday += r.est_minutes; // past-due work still lands on today
      }
    } else if (dueKey === tomorrowKey) {
      tomorrowRows.push(row);
    } else if (dueKey > tomorrowKey && dueKey <= horizonKey) {
      weekRows.push(row);
    }
    if (!done && dueKey >= todayKey && dueKey <= horizonKey) {
      bySubject.set(r.subject, (bySubject.get(r.subject) || 0) + r.est_minutes);
      byDay.set(dueKey, (byDay.get(dueKey) || 0) + r.est_minutes);
      byDayCount.set(dueKey, (byDayCount.get(dueKey) || 0) + 1);
      openWeekCount++;
      if (!nextUp || new Date(r.due) < new Date(nextUp.due)) nextUp = row;
    }
    if (done && r.score && dueKey >= recentStartKey && dueKey <= todayKey) {
      recentRows.push(row);
    }
  }

  overdueRows.sort((a, b) => new Date(b.due) - new Date(a.due));
  recentRows.sort((a, b) => new Date(b.due) - new Date(a.due));

  const index = Math.min(100, Math.round((minutesToday / DAILY_TARGET_MINUTES) * 100));
  const subjects = [...bySubject.entries()]
    .map(([name, minutes]) => ({ name, minutes }))
    .sort((a, b) => b.minutes - a.minutes);
  const heaviest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];

  // The 7-day strip: open minutes + urgency level for each of the next seven
  // days, so the week's shape is obvious at a glance.
  const days = [];
  for (let i = 0; i < 7; i++) {
    const key = dayKey(new Date(now.getTime() + i * 86400000));
    const minutes = byDay.get(key) || 0;
    const count = byDayCount.get(key) || 0;
    const levelPct = Math.min(100, Math.round((minutes / DAILY_TARGET_MINUTES) * 100));
    days.push({ key, minutes, count, level: loadLabel(levelPct) });
  }
  const weekMinutes = subjects.reduce((a, s) => a + s.minutes, 0);

  return {
    index,
    label: loadLabel(index),
    minutesToday,
    target: DAILY_TARGET_MINUTES,
    today: todayRows,
    overdue: overdueRows.slice(0, 10),
    tomorrow: tomorrowRows,
    week: weekRows,
    subjects,
    heaviestDay: heaviest ? { date: heaviest[0], minutes: heaviest[1] } : null,
    days,
    weekMinutes,
    weekCount: openWeekCount,
    nextUp: nextUp
      ? { id: nextUp.id, title: nextUp.title, subject: nextUp.subject, course: nextUp.course, due: nextUp.due, dueKey: nextUp.dueKey, dueLabel: nextUp.dueLabel }
      : null,
    recent: recentRows.slice(0, 12),
  };
}

function dueLabel(iso) {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
}

export { DAILY_TARGET_MINUTES };
