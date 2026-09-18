# Schoolday

A daily ledger of the school load. Pulls assignments from Infinity Campus /
PowerSchool on a schedule, computes the day's load, and serves a designed
website on the LAN — the kind of thing you glance at from the kitchen table.

## Architecture

```
 Infinity Campus / PowerSchool API
        │  poll (every 10 min, or "Pull now")
        ▼
 Collector ──► Bus (in-process event backbone + durable events outbox)
        │        topics: job.enqueued · job.started · job.done ·
        │                sync.completed · load.recomputed · assignment.done
        ▼
 Queue (SQLite-backed, durable) ── workers: sync, recompute
        │   jobs survive restarts; retries with backoff (3 attempts)
        ▼
 SQLite (assignments · sync_runs · jobs · events · kv)
        │
        ▼
 HTTP API + static site  ──►  unRAID Docker container, :4180
```

- **Bus** — every event is appended to a durable `events` table (append-only
  outbox) and fanned out in-process. The UI's system rail reads the last
  events straight from that log.
- **Queue** — jobs live in SQLite, so a container restart never loses
  scheduled work. The scheduler re-enqueues the periodic sync from the last
  successful run (persisted in `kv`); workers claim one pending job at a time.
- **Providers** — pluggable assignment sources behind one interface
  (`listAssignments()`): `demo` (deterministic seeded data, default),
  `powerschool` (REST, `PS_API_TOKEN`/`PS_SCHOOL_ID`), `infinitecampus`
  (parent-portal REST, `IC_BASE_URL`/`IC_API_TOKEN`/`IC_STUDENT_ID`).
- **Load** — "load index" = today's open minutes against a daily target
  (default 180 min): light / steady / heavy / crunch. The weekly view sums
  the next 7 days per subject.

## Run

```bash
docker run -d --name schoolday --restart=unless-stopped \
  -p 4180:4180 \
  -v /opt/schoolday/data:/app/data \
  -e STUDENT_NAME=Avery -e SCHOOL_NAME="Riverside Middle School" \
  -e PROVIDER=demo \
  schoolday
```

Then open `http://192.168.0.4:4180` from anywhere on the LAN.

### Wiring a real portal

```
-e PROVIDER=infinitecampus \
-e IC_BASE_URL=https://dublincityoh.infinitecampus.org \
-e IC_APP_NAME=dublincity \
-e IC_USERNAME=... -e IC_PASSWORD=...
```

The Infinite Campus provider logs in through the parent portal (JSESSIONID
session), lists the account's students, and pulls the active student's
assignments. The active student is chosen in the UI (student chips) or via
`POST /api/students {"personID": ...}`; the first student is the default.

ParentSquare (the "School & family" section — feed posts + direct-message
inbox) is enabled by:

```
-e PS_BASE_URL=https://www.parentsquare.com \
-e PS_SCHOOL_ID=... -e PS_USER_ID=... \
-e PS_EMAIL=... -e PS_PASSWORD=...
```

Until a provider is configured, the demo provider keeps the site alive with
seeded data.

## Env

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4180` | HTTP port |
| `DATA_DIR` | `/app/data` | SQLite location |
| `PROVIDER` | `demo` | `demo` · `powerschool` · `infinitecampus` |
| `STUDENT_NAME` | `Avery` | fallback masthead name (IC provider uses the student's real name) |
| `SCHOOL_NAME` | `Riverside Middle School` | shown in the system rail |
| `POLL_INTERVAL_MS` | `600000` | sync cadence |
| `DAILY_TARGET_MINUTES` | `180` | load-index denominator |
| `IC_BASE_URL` | — | Infinite Campus portal base (e.g. `https://dublincityoh.infinitecampus.org`) |
| `IC_APP_NAME` | `dublincity` | portal app name (login page + verify form) |
| `IC_USERNAME` / `IC_PASSWORD` | — | parent-portal credentials (session login) |
| `IC_JSESSIONID` | — | optional pasted cookie string to skip login |
| `PS_BASE_URL` | — | ParentSquare base (e.g. `https://www.parentsquare.com`) |
| `PS_SCHOOL_ID` / `PS_USER_ID` | — | school + account user id (inbox) |
| `PS_EMAIL` / `PS_PASSWORD` | — | ParentSquare credentials |

## Deploy (unRAID)

```bash
# on unRAID: load the image, then run
gunzip -c deploy/schoolday-image.tar.gz | docker load
docker run -d --name schoolday --restart=unless-stopped \
  -p 4180:4180 -v /opt/schoolday/data:/app/data \
  -e PROVIDER=infinitecampus \
  -e IC_BASE_URL=https://dublincityoh.infinitecampus.org \
  -e IC_APP_NAME=dublincity \
  -e IC_USERNAME=... -e IC_PASSWORD=... \
  -e PS_BASE_URL=https://www.parentsquare.com \
  -e PS_SCHOOL_ID=... -e PS_USER_ID=... \
  -e PS_EMAIL=... -e PS_PASSWORD=... \
  schoolday:latest
```

Or install via the unRAID app store with `schoolday.xpd` (NewURL:
`https://github.com/bschrib/schoolday`).
