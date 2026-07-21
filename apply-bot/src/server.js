import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { ROOT, SERVER, CAPS, PATHS } from './config.js';
import { boardSnapshot, recentEvents, db, getSetting, setSetting, parkedQueue, releaseAnswered } from './db.js';
import { bus, emit, emitBoard } from './bus.js';
import { saveAnswer, allAnswers } from './answer/bank.js';
import { loadProfile, unconfirmed, profileExists, editableGaps, setProfileValue } from './profile.js';

const DASH = path.join(ROOT, 'dashboard');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const routes = {
  '/api/board': (req, res) => json(res, {
    ...boardSnapshot(),
    caps: CAPS,
    mode: getSetting('mode', 'observe'),
    stopped: fs.existsSync(PATHS.stop),
  }),

  '/api/events': (req, res) => json(res, recentEvents(200)),

  '/api/parked': (req, res) => json(res, {
    queue: parkedQueue().map(q => ({ ...q, options: q.options_json ? JSON.parse(q.options_json) : null })),
    profileGaps: profileExists() ? unconfirmed(loadProfile({ fresh: true })) : ['no profile — copy profile.example.json to profile/master-profile.json'],
    profileFields: editableGaps(),
  }),

  '/api/answers': (req, res) => json(res, allAnswers()),

  '/api/job': (req, res, url) => {
    const id = Number(url.searchParams.get('id'));
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!job) return json(res, { error: 'not found' }, 404);
    const events = db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id').all(id);
    const apps = db.prepare('SELECT * FROM applications WHERE job_id = ?').all(id);
    json(res, { job, events, applications: apps });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${SERVER.port}`);

  // Server-sent events — board updates and log lines.
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');

    const sent = new Set();
    const push = e => {
      if (e.id != null) { if (sent.has(e.id)) return; sent.add(e.id); }
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    };

    // In-process bus — instant, used when the pipeline and server share a process
    // (`npm run run`).
    bus.on('event', push);

    // Table tail — covers the split-process case (`npm run serve` in one terminal,
    // `npm run discover` in another). Without this the dashboard would sit silent
    // while the bot worked. Deduped against the bus by event id.
    let lastId = db.prepare('SELECT MAX(id) m FROM events').get().m || 0;
    const poll = setInterval(() => {
      const rows = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(lastId);
      for (const r of rows) {
        lastId = r.id;
        push({ type: 'event', id: r.id, jobId: r.job_id, ts: r.ts, stage: r.stage, level: r.level, message: r.message });
      }
      if (rows.length) push({ type: 'board' });
    }, 1000);

    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { bus.off('event', push); clearInterval(poll); clearInterval(ping); });
    return;
  }

  if (url.pathname === '/api/mode' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { mode } = JSON.parse(body || '{}');
    setSetting('mode', mode);
    return json(res, { mode });
  }

  // Answering one parked question releases every job that was only waiting on it.
  if (url.pathname === '/api/answer' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { question, value, fieldType = 'text', scope = 'global' } = JSON.parse(body || '{}');
    if (!question || value == null || value === '') return json(res, { error: 'question and value required' }, 400);

    const norm = saveAnswer({ question, value, fieldType, scope, source: 'human', humanVerified: 1 });
    const freed = releaseAnswered(norm);
    emit({ stage: 'answer', message: `Answered "${question.slice(0, 60)}" — released ${freed.length} application(s)` });
    emitBoard();
    return json(res, { normalised: norm, released: freed.length });
  }

  // Confirm a profile field from the dashboard. Confirming is what makes the
  // value usable — unconfirmed values are invisible to the resolver.
  if (url.pathname === '/api/profile' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { path: dotPath, value } = JSON.parse(body || '{}');
    if (!dotPath || value === '' || value == null) return json(res, { error: 'path and value required' }, 400);
    try {
      const out = setProfileValue(dotPath, value);
      emit({ stage: 'profile', message: `Confirmed ${dotPath} = ${out.value} (${out.remaining} field(s) still unconfirmed)` });
      emitBoard();
      return json(res, out);
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  if (routes[url.pathname]) return routes[url.pathname](req, res, url);

  // Tailored resume PDFs, so the drawer can preview exactly what would be sent.
  if (url.pathname === '/api/resume') {
    const job = db.prepare('SELECT resume_path FROM jobs WHERE id = ?').get(Number(url.searchParams.get('id')));
    const p = job?.resume_path && path.resolve(job.resume_path);
    if (!p || !p.startsWith(path.resolve(PATHS.artifacts)) || !fs.existsSync(p)) {
      res.writeHead(404); return res.end('No resume for this job');
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${path.basename(p)}"` });
    return fs.createReadStream(p).pipe(res);
  }

  // Static dashboard
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(DASH, file);
  if (!full.startsWith(DASH) || !fs.existsSync(full)) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'text/plain' });
  fs.createReadStream(full).pipe(res);
});

// Live browser frames — separate channel from SSE because they're big and
// lossy-by-design: a dropped frame should never back up the event log.
const wss = new WebSocketServer({ server, path: '/live' });
bus.on('frame', data => {
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.bufferedAmount < 1_000_000) client.send(data);
  }
});

export function startServer() {
  return new Promise(resolve => {
    server.listen(SERVER.port, () => {
      console.log(`\n  Dashboard → http://localhost:${SERVER.port}\n`);
      resolve(server);
    });
  });
}
