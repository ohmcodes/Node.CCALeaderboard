// Smoke tests: node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-lb-'));
process.env.DATA_FILE = path.join(dir, 'lb.json');
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
const { server } = require('../src/server');
let base;

before(() => new Promise((r) => server.on('listening', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => server.close());

const post = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(base + p).then((r) => r.json());
const run = (id, name, score, timeSeconds, setClean) =>
  post('/api/runs', { playerId: id, name, score, timeSeconds, setClean, placed: setClean ? 10 : 5, total: 10, broken: 0, hints: 0 });

test('ranks by best score, then best time; keeps bests', async () => {
  await run('aaaaaaaa-1', 'Alice', 500, 300, true);
  await run('bbbbbbbb-2', 'Bob', 700, 0, false);
  await run('cccccccc-3', 'Cara', 500, 200, true);
  const worse = await run('bbbbbbbb-2', 'Bob', 100, 50, true); // lower score, but first clean time
  assert.equal(worse.newBestScore, false);
  assert.equal(worse.newBestTime, true);
  assert.equal(worse.player.bestScore, 700);

  const lb = await get('/api/leaderboard?limit=10&player=aaaaaaaa-1');
  assert.deepEqual(lb.entries.map((e) => e.name), ['Bob', 'Cara', 'Alice']);
  assert.equal(lb.you.rank, 3);
  assert.equal(lb.entries[2].isYou, true);
  assert.equal(lb.fastestTime, 50);
  assert.ok(!('id' in lb.entries[0]), 'never leaks browser ids');
});

test('validates input and renames', async () => {
  assert.equal((await run('bad', 'X', 1, 1, false)).ok, false);
  assert.equal((await post('/api/runs', { playerId: 'dddddddd-4', score: 1.5, timeSeconds: 1 })).ok, false);
  const r = await post('/api/players/aaaaaaaa-1', { name: '  <b>Al\u0000ice</b>  the   Great Barista Supreme ' }, 'PUT');
  assert.equal(r.ok, true);
  assert.equal(r.player.name, 'bAlice/b the Great Baris');
  const q = await get('/api/leaderboard?q=alice');
  assert.equal(q.matched, 1);
});

test('CORS preflight', async () => {
  const res = await fetch(base + '/api/runs', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('serves the page', async () => {
  const res = await fetch(base + '/leaderboard');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /LEADERBOARD/);
});
