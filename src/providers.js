import crypto from 'node:crypto';

/**
 * Providers — pluggable assignment sources + the ParentSquare message source.
 *
 * Every assignment provider implements `listAssignments(now)` and returns
 * normalized rows:
 *   { externalId, subject, course, title, due (ISO), estMinutes, status, notes }
 *
 * - demo:          deterministic seeded data so the site is alive with no config
 * - powerschool:   PowerSchool REST API (district.psapi.com)
 * - infinitecampus: Infinite Campus parent portal — session login (JSESSIONID)
 *                   + /campus/api/portal/* JSON endpoints, one student at a time
 *
 * The active assignment provider is chosen by PROVIDER env (default: demo).
 *
 * ParentSquare (PS) is a separate source: it supplies the messages section
 * (school feed posts + direct-message threads), not assignments.
 */

const SUBJECTS = ['Math', 'Science', 'English', 'History', 'PE'];

function hash(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function at(date, hour, minute = 0) {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// ------------------------------------------------------- cookie plumbing

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function mergeSetCookie(jar, headers) {
  const list = headers.getSetCookie ? headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1);
  }
}

async function jarFetch(jar, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Cookie: cookieHeader(jar) },
  });
  mergeSetCookie(jar, res.headers);
  return res;
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&bull;/g, '·');
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ---------------------------------------------------------------- demo

const WEEKLY = [
  // [weekday 0=Sun..6=Sat, subject, course, title, est, hour]
  [1, 'Math', 'Algebra 2 — Mr. Okafor', 'Problem set 4.2: factoring', 45, 17],
  [1, 'History', 'World History — Mr. Park', 'Document analysis: primary sources', 30, 17],
  [2, 'Science', 'Biology — Ms. Vega', 'Lab write-up: osmosis', 40, 17],
  [2, 'English', 'English 9 — Ms. Aldridge', 'Close reading: "The Lottery"', 25, 17],
  [3, 'Math', 'Algebra 2 — Mr. Okafor', 'Quiz prep: polynomial division', 30, 17],
  [3, 'PE', 'PE — Coach Bell', 'Fitness report: weekly log', 20, 17],
  [4, 'Science', 'Biology — Ms. Vega', 'Data table: enzyme kinetics', 35, 17],
  [4, 'History', 'World History — Mr. Park', 'Essay draft: Cold War origins', 60, 20],
  [5, 'Math', 'Algebra 2 — Mr. Okafor', 'Spiral review: mixed practice', 20, 17],
  [5, 'English', 'English 9 — Ms. Aldridge', 'Poetry response: free verse', 25, 17],
];

const ONE_OFFS = [
  // [weekday, subject, course, title, est, hour]
  [2, 'Math', 'Algebra 2 — Mr. Okafor', 'Unit test: polynomials', 50, 15],
  [4, 'Science', 'Biology — Ms. Vega', 'Science fair proposal', 60, 20],
  [5, 'History', 'World History — Mr. Park', 'Cold War essay (final)', 90, 20],
  [6, 'Science', 'Biology — Ms. Vega', 'Lab notebook check-in', 15, 12],
];

function seededDone(key, salt) {
  // deterministic: ~1/3 of past items are already done
  return Number(hash(key + salt).slice(0, 8), 16) % 3 === 0;
}

function demoList(now) {
  const rows = [];
  const today = new Date(now);
  for (let offset = -2; offset <= 6; offset++) {
    const d = new Date(now);
    d.setDate(now.getDate() + offset);
    const wd = d.getDay();
    const dk = dayKey(d);
    const items = [
      ...WEEKLY.filter((w) => w[0] === wd),
      ...ONE_OFFS.filter((o) => o[0] === wd),
    ];
    for (const [wd2, subject, course, title, est, hour] of items) {
      const ext = hash(`${dk}:${title}`);
      const due = at(d, hour);
      const past = due.getTime() < now.getTime();
      const status = past ? (seededDone(ext, 'done') ? 'done' : 'open') : 'open';
      rows.push({
        externalId: ext,
        subject,
        course,
        title,
        due: due.toISOString(),
        estMinutes: est,
        status,
        notes: '',
      });
    }
  }
  return rows;
}

// ------------------------------------------------------- powerschool

function powerschoolList() {
  const base = process.env.PS_BASE_URL || 'https://district.psapi.com';
  const token = process.env.PS_API_TOKEN;
  const schoolId = process.env.PS_SCHOOL_ID;
  if (!token || !schoolId) throw new Error('powerschool provider needs PS_API_TOKEN and PS_SCHOOL_ID');
  const year = new Date().getFullYear();
  const url = `${base}/api/v1/${schoolId}/assignments?year=${year}&limit=200`;
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => {
      if (!r.ok) throw new Error(`powerschool ${r.status}`);
      return r.json();
    })
    .then((data) =>
      (data.assignments || data).map((a) => ({
        externalId: String(a.assignmentId || a.id),
        subject: a.category || 'Other',
        course: a.courseTitle || '',
        title: a.title || a.name || 'Assignment',
        due: a.dueDate || a.due || new Date().toISOString(),
        estMinutes: Number(a.estimatedMinutes || 30),
        status: a.status === 'completed' ? 'done' : 'open',
        notes: a.description || '',
      }))
    );
}

// --------------------------------------------------- infinitecampus
//
// No public REST API: log in through the JSP portal (POST /campus/verify.jsp),
// keep the JSESSIONID + context cookies, then call the portal's JSON
// endpoints under /campus/api/portal/*. Student switching is a personID
// query param — the account's students come from /api/portal/students.

function icConfig() {
  const base = process.env.IC_BASE_URL; // e.g. https://dublincityoh.infinitecampus.org
  const app = process.env.IC_APP_NAME || 'dublincity';
  const username = process.env.IC_USERNAME;
  const password = process.env.IC_PASSWORD;
  if (!base || !username || !password) {
    throw new Error('infinitecampus provider needs IC_BASE_URL, IC_USERNAME, IC_PASSWORD');
  }
  return { base, app };
}

function icJarFromEnv() {
  // Optional: seed the session from a pasted cookie string (browser capture).
  const jar = {};
  for (const part of (process.env.IC_JSESSIONID || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) jar[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return jar;
}

async function icLogin() {
  const { base, app } = icConfig();
  const jar = icJarFromEnv();
  if (Object.keys(jar).length > 0) return { jar, seeded: true };
  // 1. GET the login page — seeds JSESSIONID + tomcat-cookie
  const p1 = await jarFetch(jar, `${base}/campus/portal/parents/${app}.jsp`);
  if (!p1.ok) throw new Error(`ic login page ${p1.status}`);
  // 2. POST verify.jsp — the actual credential exchange
  const form = new URLSearchParams({
    username: process.env.IC_USERNAME,
    password: process.env.IC_PASSWORD,
    portalUrl: `portal/parents/${app}.jsp?&rID=${Math.floor(Math.random() * 90000) + 1000}`,
    appName: app,
    url: 'nav-wrapper',
    lang: 'en',
    portalLoginPage: 'parents',
  });
  const p2 = await jarFetch(jar, `${base}/campus/verify.jsp`, {
    method: 'POST',
    redirect: 'manual',
    body: form,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${base}/campus/portal/parents/${app}.jsp`,
    },
  });
  if (!p2.ok && p2.status !== 302) throw new Error(`ic verify ${p2.status}`);
  // Follow the redirect manually so the fresh JSESSIONID is sent.
  const loc = p2.headers.get('location');
  if (loc) {
    const p3 = await jarFetch(jar, new URL(loc, `${base}/campus/verify.jsp`).toString());
    if (!p3.ok) throw new Error(`ic post-login ${p3.status}`);
  }
  return { jar, seeded: false };
}

async function icApi(jar, path) {
  const { base } = icConfig();
  const res = await fetch(`${base}/campus${path}`, {
    headers: {
      Cookie: cookieHeader(jar),
      Origin: base,
      Referer: `${base}/campus/apps/portal/`,
    },
  });
  if (!res.ok) throw new Error(`ic api ${path} -> ${res.status}`);
  return res.json();
}

async function icStudents() {
  const { jar } = await icLogin();
  const students = await icApi(jar, '/api/portal/students');
  if (!Array.isArray(students)) throw new Error('ic students: unexpected payload');
  return students;
}
async function icAssignmentsFor(personID) {
  const { jar } = await icLogin();
  const list = await icApi(jar, `/api/portal/assignment/listView?personID=${personID}`);
  if (!Array.isArray(list)) throw new Error('ic assignments: unexpected payload');
  return list.map((a) => {
    const done = Boolean(a.turnedIn) || (a.score != null && String(a.score).trim() !== '');
    let score = '';
    if (done && a.score != null && String(a.score).trim() !== '') {
      score = String(a.score);
      if (a.totalPoints != null) score += `/${a.totalPoints}`;
      if (a.scorePercentage) score += ` (${a.scorePercentage}%)`;
    }
    return {
      externalId: `${personID}:${a.groupActivityID}`,
      subject: subjectColorKey(a.courseName || ''),
      course: a.courseName || '',
      title: a.assignmentName || 'Assignment',
      due: a.dueDate || new Date().toISOString(),
      estMinutes: done ? 0 : 25,
      status: done ? 'done' : 'open',
      score,
      notes: [a.late ? 'Late' : '', a.comments, a.feedback].filter(Boolean).join(' · '),
    };
  });
}

function infiniteCampusList() {
  // Standard contract: assignments for the env-selected student.
  const personID = process.env.IC_STUDENT_ID;
  if (!personID) throw new Error('infinitecampus list() needs IC_STUDENT_ID');
  return icAssignmentsFor(personID);
}
function psConfig() {
  const base = process.env.PS_BASE_URL; // https://www.parentsquare.com
  const email = process.env.PS_EMAIL;
  const password = process.env.PS_PASSWORD;
  if (!base || !email || !password) {
    throw new Error('parentsquare needs PS_BASE_URL, PS_EMAIL, PS_PASSWORD');
  }
  return { base };
}

/**
 * Per-student ParentSquare school mapping (personID -> school id), e.g.
 * {"44621":"52346","90972":"52355"}. Each student's page shows the feeds
 * and direct messages of their own school.
 */
export function psStudentSchools() {
  try {
    const map = JSON.parse(process.env.PS_STUDENT_SCHOOLS || '{}');
    return typeof map === 'object' && map ? map : {};
  } catch {
    return {};
  }
}

async function psLogin() {
  const { base } = psConfig();
  const jar = {};
  const p1 = await jarFetch(jar, `${base}/signin/`);
  if (!p1.ok) throw new Error(`ps signin page ${p1.status}`);
  const html = await p1.text();
  const token = /name="authenticity_token" value="([^"]*)"/.exec(html)?.[1];
  if (!token) throw new Error('ps: no authenticity token on signin page');
  const form = new URLSearchParams({
    'session[email]': process.env.PS_EMAIL,
    'session[password]': process.env.PS_PASSWORD,
    authenticity_token: token,
    commit: 'Sign In',
  });
  const p2 = await jarFetch(jar, `${base}/sessions`, {
    method: 'POST',
    redirect: 'manual',
    body: form,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: base,
      Referer: `${base}/signin/`,
    },
  });
  if (p2.status === 401) throw new Error('ps login: 401 (csrf or credentials)');
  const loc = p2.headers.get('location');
  if (loc) {
    // 302 on success — follow with the rotated session cookies.
    const p3 = await jarFetch(jar, new URL(loc, `${base}/sessions`).toString());
    if (!p3.ok && p3.status !== 302) throw new Error(`ps post-login ${p3.status}`);
  } else if (!p2.ok && p2.status !== 302) {
    throw new Error(`ps login ${p2.status}`);
  }
  return { jar };
}

async function psGet(jar, url) {
  const res = await fetch(url, {
    headers: { Cookie: cookieHeader(jar), 'User-Agent': 'schoolday/1.0' },
  });
  if (!res.ok) throw new Error(`ps ${url} -> ${res.status}`);
  return res.text();
}

/**
 * School feed posts (the "Posts" page). Returns:
 *   { school, posts: [{ id, title, from, when (ISO), excerpt }] }
 */
async function psFeeds(schoolId) {
  const { base } = psConfig();
  const sid = schoolId || process.env.PS_SCHOOL_ID;
  if (!sid) throw new Error('parentsquare needs a school id (PS_SCHOOL_ID or per-student mapping)');
  const { jar } = await psLogin();
  const html = await psGet(jar, `${base}/schools/${sid}/feeds`);
  const school = /<title>[^<]*\|\s*([^<|]+?)\s*\|\s*ParentSquare/.exec(html)?.[1] || '';
  const posts = [];
  for (const block of html.split('<li class="feeds-list-item">').slice(1)) {
    const id = /id="feed_(\d+)"/.exec(block)?.[1];
    if (!id) continue;
    const title = decodeEntities(/id="feed-title-\d+"[^>]*>([^<]*)</.exec(block)?.[1] || '');
    const from = stripTags(/class="feed-metadata-from">([\s\S]*?)<\/li>/.exec(block)?.[1] || '').slice(0, 80);
    const when = /data-timestamp="([^"]+)"/.exec(block)?.[1] || '';
    let excerpt = '';
    const di = block.indexOf('class="description truncated-text');
    if (di > 0) {
      const tagEnd = block.indexOf('>', di);
      const end = block.indexOf('<ul class="nav nav-pills"', tagEnd);
      excerpt = stripTags(block.slice(tagEnd + 1, end > 0 ? end : block.length)).slice(0, 200);
    }
    posts.push({ id, title, from, when, excerpt, href: `/feeds/${id}` });
  }
  return { school, posts };
}

/**
 * Direct-message inbox (the "Messages" page). Returns:
 *   [{ id, recipient, messages, lastMessageAt, preview, href }]
 */
async function psInbox(schoolId) {
  const { base } = psConfig();
  const sid = schoolId || process.env.PS_SCHOOL_ID;
  if (!sid) throw new Error('parentsquare needs a school id (PS_SCHOOL_ID or per-student mapping)');
  const { jar } = await psLogin();
  // Discover the account's own user id from the feed page ("Manage account"
  // link), falling back to PS_USER_ID.
  let userId = process.env.PS_USER_ID;
  if (!userId) {
    const feedsHtml = await psGet(jar, `${base}/schools/${sid}/feeds`);
    userId = /href="\/schools\/\d+\/users\/(\d+)"[^>]*>Manage account/.exec(feedsHtml)?.[1];
  }
  if (!userId) throw new Error('ps: could not resolve account user id (set PS_USER_ID)');
  const html = await psGet(jar, `${base}/schools/${sid}/users/${userId}/chats`);
  const threads = [];
  for (const block of html.split('data-testid="chat-thread-item-').slice(1)) {
    const id = block.slice(0, block.indexOf('"')).trim();
    const href = /href="([^"]+)"/.exec(block)?.[1] || '';
    const recipient = /class="user-thread-chat-name-\d+">\s*([^<]+?)\s*</.exec(block)?.[1] || '';
    const count = /badge badge-warning">\s*(\d+)/.exec(block)?.[1] || '0';
    const lastMessageAt = /data-testid="chat-thread-row-timestamp">\s*([^<]+?)\s*</.exec(block)?.[1] || '';
    let preview = '';
    const pi = block.indexOf('data-testid="chat-thread-row-preview"');
    if (pi > 0) {
      const seg = block.slice(pi, pi + 800);
      const inner = /class="reaction-icons"[^>]*>([\s\S]*?)<\/span>/.exec(seg)?.[1]
        || seg.slice(seg.indexOf('>') + 1);
      preview = stripTags(inner).slice(0, 160);
    }
    threads.push({ id, recipient, messages: Number(count), lastMessageAt, preview, href });
  }
  return threads;
}
export function providerFor(name) {
  switch (name) {
    case 'powerschool':
      return { name: 'powerschool', label: 'PowerSchool API', list: powerschoolList };
    case 'infinitecampus': {
      const { base, app } = icConfig();
      const nav = (tool) => `${base}/campus/nav-wrapper/parent/portal/parent/${tool}?appName=${app}`;
      const absenceUrl = `${base}/campus/nav-wrapper/parent/scanner/absenceRequests/portal/create?backTo=home&appName=${app}`;
      return {
        name: 'infinitecampus',
        label: 'Infinite Campus',
        list: infiniteCampusList,
        students: icStudents,
        listFor: icAssignmentsFor,
        portal: process.env.IC_PORTAL_URL || `${base}/campus/portal/parents/${app}.jsp`,
        quickLinks: [
          { label: 'Mark absent', url: absenceUrl },
        ],
        assignmentListUrl: (personID) => `${nav('assignment-list')}&personID=${personID}`,
      };
    }
    case 'demo':
    default:
      return { name: 'demo', label: 'Demo data (seeded)', list: () => Promise.resolve(demoList(new Date())) };
  }
}

export function parentsquare() {
  return { feeds: psFeeds, inbox: psInbox };
}

export function subjectColorKey(subject) {
  const s = (subject || '').toLowerCase();
  if (s.includes('math')) return 'Math';
  if (s.includes('sci') || s.includes('bio')) return 'Science';
  if (s.includes('eng') || s.includes('liter') || s.includes('lang') || s.includes('art')) return 'English';
  if (s.includes('hist') || s.includes('gov') || s.includes('civics')) return 'History';
  if (s.includes('pe') || s.includes('phys ed') || s.includes('fitness')) return 'PE';
  return 'Other';
}

export { SUBJECTS, dayKey };
