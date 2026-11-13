// Clean! Cut! Action! leaderboard server (cca.ohmcodes.com).
//
//   GET  /api/health
//   GET  /api/leaderboard?limit=10&offset=0&player=<browserId>&q=<name search>
//   GET  /api/players/<browserId>
//   PUT  /api/players/<browserId>      { name }
//   POST /api/runs                     { playerId, name, score, timeSeconds, setClean, timeTrial, placed, total, broken, hints }
//   GET  /leaderboard                  the public leaderboard page (public/leaderboard)
//
// No dependencies: node >= 18. Configure with env vars (see README.md).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { Store, cleanName, isValidPlayerId } = require('./store');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'leaderboard.json'));
const PUBLIC_DIR = path.resolve(path.join(__dirname, '..', 'public'));
const TRUST_PROXY = process.env.TRUST_PROXY !== '0'; // behind nginx / Caddy / Cloudflare by default
const WRITE_LIMIT_PER_MIN = Number(process.env.WRITE_LIMIT_PER_MIN || 30);
const MAX_SCORE = Number(process.env.MAX_SCORE || 100000);
const MIN_RUN_SECONDS = Number(process.env.MIN_RUN_SECONDS || 10);

const store = new Store(DATA_FILE);

// ---------------------------------------------------------------- helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

/** The game runs cross-origin isolated on itch.io (COEP require-corp): it needs CORS on every API answer. */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function fail(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '?';
}

// Fixed-window write limit per IP.
const writeHits = new Map();
function allowWrite(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let hit = writeHits.get(ip);
  if (!hit || now - hit.start > 60_000) {
    hit = { start: now, count: 0 };
    writeHits.set(ip, hit);
  }
  hit.count += 1;
  return hit.count <= WRITE_LIMIT_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hit] of writeHits) if (now - hit.start > 60_000) writeHits.delete(ip);
}, 60_000).unref();

function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function intParam(value, def, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function isInt(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

// ---------------------------------------------------------------- API

function getLeaderboard(req, res, url) {
  const limit = intParam(url.searchParams.get('limit'), 10, 1, 100);
  const offset = intParam(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const viewer = url.searchParams.get('player');
  const viewerId = isValidPlayerId(viewer) ? viewer : null;
  const q = cleanName(url.searchParams.get('q') || '').toLowerCase();

  const ranked = store.getRanked();
  const all = ranked.map((p, i) => ({ p, rank: i + 1 }));
  const filtered = q ? all.filter(({ p }) => p.name.toLowerCase().includes(q)) : all;
  const entries = filtered.slice(offset, offset + limit).map(({ p, rank }) => store.view(p, rank, viewerId));

  let you = null;
  if (viewerId) {
    const rank = store.rankOf(viewerId);
    const p = store.players.get(viewerId);
    if (p) you = store.view(p, rank, viewerId); // rank 0 = named but no run yet
  }
  let fastestTime = null;
  for (const p of ranked) if (p.bestTime != null && (fastestTime == null || p.bestTime < fastestTime)) fastestTime = p.bestTime;
  const topScore = ranked.length ? ranked[0].bestScore : null;
  sendJson(res, 200, { ok: true, total: ranked.length, matched: filtered.length, offset, limit, topScore, fastestTime, entries, you });
}

function getPlayer(req, res, id) {
  const p = store.players.get(id);
  if (!p) return fail(res, 404, 'unknown player');
  sendJson(res, 200, { ok: true, player: store.view(p, store.rankOf(id), id), total: store.getRanked().length });
}

async function putPlayer(req, res, id) {
  if (!allowWrite(req)) return fail(res, 429, 'slow down');
  const body = await readJsonBody(req);
  const name = cleanName(body.name);
  if (name.length < 1) return fail(res, 400, 'name required');
  const p = store.setName(id, name);
  sendJson(res, 200, { ok: true, player: store.view(p, store.rankOf(id), id), total: store.getRanked().length });
}

async function postRun(req, res) {
  if (!allowWrite(req)) return fail(res, 429, 'slow down');
  const body = await readJsonBody(req);
  const id = body.playerId;
  if (!isValidPlayerId(id)) return fail(res, 400, 'bad playerId');

  const name = cleanName(body.name) || store.players.get(id)?.name || 'Rookie';
  const score = body.score;
  const timeSeconds = typeof body.timeSeconds === 'number' ? Math.round(body.timeSeconds * 100) / 100 : NaN;
  const placed = body.placed ?? 0;
  const total = body.total ?? 0;
  const broken = body.broken ?? 0;
  const hints = body.hints ?? 0;

  if (!isInt(score, -MAX_SCORE, MAX_SCORE)) return fail(res, 400, 'bad score');
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > 86400) return fail(res, 400, 'bad timeSeconds');
  if (!isInt(placed, 0, 5000) || !isInt(total, 0, 5000) || placed > total) return fail(res, 400, 'bad placed/total');
  if (!isInt(broken, 0, 5000) || !isInt(hints, 0, 100000)) return fail(res, 400, 'bad broken/hints');

  // A "clean" run needs every prop back and a believable time.
  const setClean = body.setClean === true && total > 0 && placed === total && timeSeconds >= MIN_RUN_SECONDS;

  const run = { score, timeSeconds, setClean, timeTrial: body.timeTrial === true, placed, total, broken, hints };
  const { player, newBestScore, newBestTime } = store.submitRun(id, name, run);
  const rank = store.rankOf(id);
  console.log(`[run] ${name} score=${score} time=${timeSeconds}s clean=${setClean} -> #${rank}`);
  sendJson(res, 200, {
    ok: true,
    newBestScore,
    newBestTime,
    player: store.view(player, rank, id),
    total: store.getRanked().length,
  });
}

// ---------------------------------------------------------------- static site

function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '') {
    res.writeHead(302, { Location: '/leaderboard' });
    return res.end();
  }
  if (pathname === '/leaderboard') pathname = '/leaderboard/';
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, 'forbidden');

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- router

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return fail(res, 400, 'bad url');
  }
  const { pathname } = url;

  try {
    if (pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        return res.end();
      }
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, players: store.getRanked().length, time: Date.now() });
      }
      if (pathname === '/api/leaderboard' && req.method === 'GET') return getLeaderboard(req, res, url);
      if (pathname === '/api/runs' && req.method === 'POST') return await postRun(req, res);

      const m = pathname.match(/^\/api\/players\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!isValidPlayerId(id)) return fail(res, 400, 'bad playerId');
        if (req.method === 'GET') return getPlayer(req, res, id);
        if (req.method === 'PUT') return await putPlayer(req, res, id);
      }
      return fail(res, 404, 'not found');
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    return fail(res, 405, 'method not allowed');
  } catch (err) {
    if (!res.headersSent) fail(res, err.status || 500, err.status ? err.message : 'server error');
    if (!err.status) console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[cca-leaderboard] http://${HOST}:${PORT}  data=${DATA_FILE}`);
});

function shutdown() {
  try {
    store.flush();
  } catch (err) {
    console.error('[store] flush failed', err);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, store };
