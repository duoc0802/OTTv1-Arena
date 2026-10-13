'use strict';
// Smoke test: luật chơi + chạy bot thật + ghép trận end-to-end qua HTTP/SSE.
const assert = require('assert');
const http = require('http');
process.env.MOVE_DELAY_MS = '1';
const game = require('./game');
const { server } = require('./server');

// 1) luật
let s = game.createInitialState();
assert.strictEqual(game.count(s, 'RED'), 9); assert.strictEqual(game.count(s, 'BLUE'), 9);
assert(game.legalMoves(s, 'RED').length > 0);
const bad = game.applyMove(s, 'RED', { from: [0, 0], to: [5, 5] });
assert.strictEqual(bad.ok, false);
// ván ngẫu nhiên phải kết thúc
let guard = 0;
while (s.status === 'PLAYING' && guard++ < 500) {
  const ms = game.legalMoves(s, s.turn);
  const r = game.applyMove(s, s.turn, ms[Math.floor(Math.random() * ms.length)]);
  assert(r.ok); s = r.state;
}
assert.strictEqual(s.status, 'FINISHED');
console.log('rules OK ->', s.winner, s.reason, 'plies', s.ply);

// 2) end-to-end
const BOT = 'function move(s){const c=s.legalMoves.filter(m=>m.capture);const p=c.length?c:s.legalMoves;return p[Math.floor(Math.random()*p.length)];}';
const BAD = 'function move(s){ while(true){} }';
function req(port, method, path, cookie, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, method, path, headers: { 'X-OTT-Request': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ res, body: d }));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
server.listen(0, async () => {
  const port = server.address().port;
  const ck = async () => (await req(port, 'GET', '/api/me')).res.headers['set-cookie'][0].split(';')[0];
  const [a, b, c] = [await ck(), await ck(), await ck()];
  const bad2 = await req(port, 'POST', '/api/queue', c, { code: BAD });
  assert.strictEqual(bad2.res.statusCode, 400); console.log('infinite-loop bot rejected OK');
  const r1 = await req(port, 'POST', '/api/queue', a, { code: BOT, name: 'A' });
  assert.strictEqual(JSON.parse(r1.body).status, 'QUEUED');
  const r2 = await req(port, 'POST', '/api/queue', b, { code: BOT, name: 'B' });
  assert.strictEqual(JSON.parse(r2.body).status, 'IN_MATCH');
  const me = JSON.parse((await req(port, 'GET', '/api/me', a)).body);
  assert.strictEqual(me.status, 'IN_MATCH');
  // đọc stream tới khi kết thúc
  const done = await new Promise((resolve) => {
    http.get({ port, path: `/api/matches/${me.matchId}/stream`, headers: { Cookie: a } }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; const m = buf.match(/"status":"FINISHED"[^\n]*/); if (m) { res.destroy(); resolve(buf.slice(-300)); } });
    });
  });
  console.log('match finished OK'); 
  server.close(); process.exit(0);
});
