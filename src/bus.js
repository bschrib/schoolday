import db from './db.js';

/**
 * Bus — the event backbone of Schoolday.
 *
 * Every publish is (1) appended to the durable `events` table (an append-only
 * outbox that survives restarts and feeds the UI's system rail) and (2)
 * fanned out in-process to subscribers. Workers and the scheduler talk to
 * each other exclusively through this bus; nothing calls anything directly.
 */
export class Bus {
  constructor() {
    this.subs = new Map();
  }

  on(topic, fn) {
    if (!this.subs.has(topic)) this.subs.set(topic, []);
    this.subs.get(topic).push(fn);
  }

  publish(topic, payload = {}) {
    const at = new Date().toISOString();
    db.prepare('INSERT INTO events (topic, payload, created_at) VALUES (?, ?, ?)')
      .run(topic, JSON.stringify(payload), at);
    for (const fn of this.subs.get(topic) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`bus subscriber for ${topic} failed:`, err);
      }
    }
    return at;
  }

  recent(limit = 12) {
    const rows = db
      .prepare('SELECT topic, payload, created_at FROM events ORDER BY id DESC LIMIT ?')
      .all(limit);
    return rows.map((r) => ({
      topic: r.topic,
      at: r.created_at,
      detail: safeDetail(r.payload),
    }));
  }
}

function safeDetail(payloadJson) {
  try {
    const p = JSON.parse(payloadJson);
    if (p.count != null) return `${p.count} assignments`;
    if (p.jobId) return p.name ? `${p.name} job` : 'job';
    if (p.error) return String(p.error).slice(0, 80);
    if (p.minutes != null) return `${p.minutes} min today`;
    return '';
  } catch {
    return '';
  }
}

export default new Bus();
