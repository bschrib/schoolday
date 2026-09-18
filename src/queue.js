import crypto from 'node:crypto';
import db, { kvGet, kvSet } from './db.js';
import bus from './bus.js';

const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 10 * 60 * 1000);
const MAX_ATTEMPTS = 3;

/**
 * Queue — a durable, single-node job queue.
 *
 * Jobs live in SQLite, so a restart never loses scheduled work: pending jobs
 * are re-claimed on boot, and the scheduler re-enqueues the periodic sync
 * based on the last successful run (persisted in kv). Workers are registered
 * by name; the loop claims one pending job at a time (single container,
 * single worker pool — no races).
 */
export class Queue {
  constructor() {
    this.workers = new Map();
    this.timer = null;
    this.claimed = null;
  }

  register(name, fn) {
    this.workers.set(name, fn);
  }

  enqueue(name, payload = {}) {
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO jobs (id, name, status, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, 'pending', JSON.stringify(payload), new Date().toISOString());
    bus.publish('job.enqueued', { jobId: id, name });
    return id;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 1500);
    this.tick();
  }

  tick() {
    this.scheduleSync();
    this.claimNext();
  }

  scheduleSync() {
    const last = kvGet('last_sync_at');
    const now = Date.now();
    const due = !last || now - Number(last) >= POLL_MS;
    if (!due) return;
    const open = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE name = 'sync' AND status IN ('pending','running')")
      .get().n;
    if (open === 0) {
      kvSet('last_sync_at', String(now));
      this.enqueue('sync');
    }
  }

  claimNext() {
    if (this.claimed) return;
    const job = db
      .prepare("SELECT id, name, payload, attempts FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1")
      .get();
    if (!job) return;
    this.claimed = job;
    db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?")
      .run(new Date().toISOString(), job.id);
    bus.publish('job.started', { jobId: job.id, name: job.name });

    const worker = this.workers.get(job.name);
    if (!worker) {
      this.finish(job, 'failed', `no worker registered for ${job.name}`);
      return;
    }
    Promise.resolve()
      .then(() => worker(JSON.parse(job.payload || '{}')))
      .then((result) => this.finish(job, 'done', null, result))
      .catch((err) => this.finish(job, 'failed', err.message))
      .finally(() => (this.claimed = null));
  }

  finish(job, status, error, result = {}) {
    const attempts = job.attempts + 1;
    if (status === 'failed' && attempts < MAX_ATTEMPTS) {
      db.prepare(
        'UPDATE jobs SET status = ?, attempts = ?, last_error = ? WHERE id = ?'
      ).run('pending', attempts, error, job.id);
      bus.publish('job.retry', { jobId: job.id, name: job.name, attempt: attempts, error });
      return;
    }
    db.prepare(
      'UPDATE jobs SET status = ?, attempts = ?, last_error = ?, finished_at = ? WHERE id = ?'
    ).run(status, attempts, error ?? null, new Date().toISOString(), job.id);
    bus.publish(status === 'done' ? 'job.done' : 'job.failed', {
      jobId: job.id,
      name: job.name,
      error: error ?? undefined,
      ...result,
    });
  }

  depth() {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')")
      .get();
    return row.n;
  }

  lastSync() {
    const row = db
      .prepare("SELECT finished_at, status FROM sync_runs ORDER BY started_at DESC LIMIT 1")
      .get();
    return row || null;
  }
}

export default new Queue();
