'use strict';
/**
 * OTTv2 Arena – server (Node >= 18, không cần cài thư viện).
 *  - Guest session bằng cookie HttpOnly
 *  - Hàng chờ ghép ngẫu nhiên, mỗi người nộp 1 đoạn code JS
 *  - Server là authority: tự chạy 2 bot luân phiên, kiểm tra luật, phát kết quả qua SSE
 *  - Giới hạn hữu hạn: số trận, độ dài hàng chờ, kích thước code, rate limit
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const game = require('./game');

const CFG = {
  port: +process.env.PORT || 3000,
  host: process.env.HOST || '0.0.0.0',
  maxCodeBytes: 20000,
  maxActiveMatches: +process.env.MAX_MATCHES || 20,
  maxQueue: 200,
  maxPreflight: 4,
  moveDelayMs: +process.env.MOVE_DELAY_MS || 600,   // nhịp xem trận
  botTimeoutMs: 1000,                               // tổng thời gian cho mỗi nước
  vmTimeoutMs: 500,
  queueLeaseMs: 30000,
  joinCooldownMs: 2000,
  finishedTtlMs: 60 * 60 * 1000,
};

// ---------------------------------------------------------------- state
const sessions = new Map();   // sid -> session
const queue = [];             // [{sid, code, name, joinedAt}]
const matches = new Map();    // id -> match
let preflightRunning = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

function getSession(req, res) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).filter((p) => p.length === 2)
  );
  let s = sessions.get(cookies.sid);
  if (!s) {
    s = { id: rid(16), name: 'Guest-' + rid(2), streams: new Set(), lastSeen: Date.now(), matchId: null, lastJoin: 0 };
    sessions.set(s.id, s);
    res.setHeader('Set-Cookie', `sid=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
  }
  s.lastSeen = Date.now();
  return s;
}

// ---------------------------------------------------------------- SSE
function sseOpen(req, res, set) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  set.add(res);
  const hb = setInterval(() => res.write(': hb\n\n'), 15000);
  req.on('close', () => { clearInterval(hb); set.delete(res); });
}
function sseSend(res, event, data) {
  if (res.writableLength > 256 * 1024) { res.destroy(); return; } // client quá chậm -> đóng riêng stream đó
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(set, event, data) { for (const r of set) sseSend(r, event, data); }

// ---------------------------------------------------------------- bot runtime
function runBot(code, view, lang) { 
  return new Promise((resolve) => {
    let done = false;
    const w = new Worker(path.join(__dirname, 'botRunner.js'), {
      // SỬA: Bổ sung lang vào workerData để botRunner.js nhận được ngôn ngữ
      workerData: { code, lang, input: JSON.stringify(view), timeoutMs: CFG.vmTimeoutMs }, 
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    });
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); w.terminate(); resolve(r); };
    const t = setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), CFG.botTimeoutMs);
    w.once('message', finish);
    w.once('error', (e) => finish({ ok: false, error: 'RUNTIME_ERROR: ' + String((e && e.message) || e).slice(0, 200) }));
    w.once('exit', () => finish({ ok: false, error: 'RUNTIME_ERROR: worker exited' }));
  });
}

/** Chạy thử code trên thế cờ ngẫu nhiên cho cả 2 phe trước khi cho vào hàng chờ. */
async function preflight(code, lang) { 
  const st = game.createInitialState();
  for (const side of ['RED', 'BLUE']) {
    const probe = { ...st, turn: side };
    const r = await runBot(code, game.toView(probe, side), lang); 
    if (!r.ok) return r.error;
    const chk = game.applyMove(probe, side, r.move);
    if (!chk.ok) return 'Nước đi thử không hợp lệ (' + chk.error + '). Cần trả về {from:[r,c], to:[r,c]} nằm trong state.legalMoves';
  }
  return null;
}

// ---------------------------------------------------------------- matches
function publicMatch(m, includeMoves = true) {
  return {
    id: m.id,
    red: m.players.RED.name,
    blue: m.players.BLUE.name,
    state: m.state,
    initial: m.initial,
    moves: includeMoves ? m.moves : undefined,
    startedAt: m.createdAt,
  };
}

function createMatch(a, b) {
  const [red, blue] = Math.random() < 0.5 ? [a, b] : [b, a];
  const state = game.createInitialState();
  const m = {
    id: rid(6),
    players: {
      RED: { sid: red.sid, name: red.name, code: red.code, lang: red.lang },
      BLUE: { sid: blue.sid, name: blue.name, code: blue.code, lang: blue.lang },
    },
    state,
    initial: game.clone(state),
    moves: [],
    listeners: new Set(),
    createdAt: Date.now(),
    finishedAt: null,
  };
  matches.set(m.id, m);
  for (const side of ['RED', 'BLUE']) {
    const s = sessions.get(m.players[side].sid);
    if (s) { s.matchId = m.id; broadcast(s.streams, 'status', sessionStatus(s, side)); }
  }
  runMatch(m).catch((e) => console.error('match error', e));
  return m;
}

async function runMatch(m) {
  await sleep(2000); 
  while (m.state.status === 'PLAYING') {
    const side = m.state.turn;
    const view = game.toView(m.state, side);
    const r = await runBot(m.players[side].code, view, m.players[side].lang);
    let move = null, note = null;
    if (!r.ok) {
      m.state = game.forfeit(m.state, side, r.error.startsWith('TIMEOUT') ? 'TIMEOUT' : 'RUNTIME_ERROR');
      note = r.error;
    } else {
      const res = game.applyMove(m.state, side, r.move);
      if (res.ok) { m.state = res.state; move = { side, from: res.move.from, to: res.move.to, capture: res.move.capture }; m.moves.push(move); }
      else { m.state = game.forfeit(m.state, side, 'ILLEGAL_MOVE'); note = res.error; }
    }
    broadcast(m.listeners, 'update', { state: m.state, move, note, ply: m.state.ply });
    if (m.state.status === 'PLAYING') await sleep(CFG.moveDelayMs);
  }
  m.finishedAt = Date.now();
  for (const side of ['RED', 'BLUE']) {
    m.players[side].code = null; // không giữ code sau trận
    const s = sessions.get(m.players[side].sid);
    if (s && s.matchId === m.id) { s.matchId = null; }
  }
}

// ---------------------------------------------------------------- queue
function sessionStatus(s, side) {
  if (s.matchId) return { status: 'IN_MATCH', matchId: s.matchId, side: side || null };
  const pos = queue.findIndex((q) => q.sid === s.id);
  if (pos >= 0) return { status: 'QUEUED', position: pos + 1 };
  return { status: 'IDLE' };
}
function pushStatus(s) { broadcast(s.streams, 'status', sessionStatus(s, sideOf(s))); }
function sideOf(s) {
  const m = s.matchId && matches.get(s.matchId);
  if (!m) return null;
  return m.players.RED.sid === s.id ? 'RED' : 'BLUE';
}

function tryMatch() {
  while (queue.length >= 2 && [...matches.values()].filter((m) => !m.finishedAt).length < CFG.maxActiveMatches) {
    const i = Math.floor(Math.random() * queue.length);        // ghép ngẫu nhiên
    const a = queue.splice(i, 1)[0];
    const j = Math.floor(Math.random() * queue.length);
    const b = queue.splice(j, 1)[0];
    createMatch(a, b);
  }
  queue.forEach((q) => { const s = sessions.get(q.sid); if (s) pushStatus(s); });
}

setInterval(() => { // lease hàng chờ + dọn trận cũ + dọn session
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) {
    const s = sessions.get(queue[i].sid);
    if (!s || (s.streams.size === 0 && now - s.lastSeen > CFG.queueLeaseMs)) queue.splice(i, 1);
  }
  for (const [id, m] of matches) if (m.finishedAt && now - m.finishedAt > CFG.finishedTtlMs) matches.delete(id);
  for (const [id, s] of sessions) if (!s.streams.size && !s.matchId && now - s.lastSeen > 24 * 3600 * 1000) sessions.delete(id);
}, 5000).unref();

// ---------------------------------------------------------------- http
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('TOO_LARGE')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (p === '/api/health') return json(res, 200, { ok: true, queue: queue.length, matches: matches.size });

    const s = getSession(req, res);

    if (req.method !== 'GET' && req.headers['x-ott-request'] !== '1') return json(res, 403, { error: 'CSRF: thiếu header X-OTT-Request' });

    if (req.method === 'GET' && p === '/api/me') return json(res, 200, { name: s.name, ...sessionStatus(s, sideOf(s)) });

    if (req.method === 'GET' && p === '/api/stream') {
      sseOpen(req, res, s.streams);
      return sseSend(res, 'status', { name: s.name, ...sessionStatus(s, sideOf(s)) });
    }

    let mm;
    if (req.method === 'GET' && (mm = p.match(/^\/api\/matches\/([a-f0-9]+)\/stream$/))) {
      const m = matches.get(mm[1]);
      if (!m) return json(res, 404, { error: 'Không tìm thấy trận' });
      sseOpen(req, res, m.listeners);
      const side = m.players.RED.sid === s.id ? 'RED' : m.players.BLUE.sid === s.id ? 'BLUE' : null;
      return sseSend(res, 'snapshot', { ...publicMatch(m), you: side });
    }

    if (req.method === 'POST' && p === '/api/queue') {
      if (s.matchId) return json(res, 409, { error: 'Bạn đang trong một trận' });
      if (queue.some((q) => q.sid === s.id)) return json(res, 409, { error: 'Bạn đã ở trong hàng chờ' });
      if (Date.now() - s.lastJoin < CFG.joinCooldownMs) return json(res, 429, { error: 'Thao tác quá nhanh, thử lại sau vài giây' });
      s.lastJoin = Date.now();
      if (queue.length >= CFG.maxQueue) return json(res, 503, { error: 'Hàng chờ đầy' });
      
      let body;
      try { body = JSON.parse(await readBody(req, CFG.maxCodeBytes + 1000)); } catch { return json(res, 400, { error: 'Body không hợp lệ hoặc quá lớn' }); }
      
      const code = String(body.code || '');
      const lang = String(body.lang || 'javascript'); // <-- DÒNG MỚI: Lấy lang từ body do trình duyệt gửi lên, mặc định là javascript
      
      if (!code.trim() || Buffer.byteLength(code) > CFG.maxCodeBytes) return json(res, 400, { error: `Code rỗng hoặc vượt ${CFG.maxCodeBytes} bytes` });
      if (body.name) s.name = String(body.name).replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 20) || s.name;
      if (preflightRunning >= CFG.maxPreflight) return json(res, 503, { error: 'Máy chủ đang bận kiểm tra code, thử lại' });
      preflightRunning++;
      
      let err;
      // DÒNG SỬA: Truyền thêm 'lang' vào hàm preflight để chạy thử bằng đúng ngôn ngữ người dùng chọn
      try { err = await preflight(code, lang); } finally { preflightRunning--; } 
      
      if (err) return json(res, 400, { error: 'Code không qua kiểm tra: ' + err });
      if (s.matchId || queue.some((q) => q.sid === s.id)) return json(res, 409, { error: 'Trạng thái đã thay đổi' });
      
      // DÒNG SỬA: Bổ sung 'lang' vào object đẩy vào hàng chờ (queue)
      queue.push({ sid: s.id, code, lang, name: s.name, joinedAt: Date.now() }); 
      
      tryMatch();
      pushStatus(s);
      return json(res, 200, { name: s.name, ...sessionStatus(s, sideOf(s)) });
    }

    if (req.method === 'DELETE' && p === '/api/queue') {
      const i = queue.findIndex((q) => q.sid === s.id);
      if (i >= 0) queue.splice(i, 1);
      pushStatus(s);
      tryMatch();
      return json(res, 200, sessionStatus(s, sideOf(s)));  // nếu đã ghép trước đó: trả IN_MATCH (match thắng race)
    }

    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Lỗi máy chủ' });
  }
});

if (require.main === module) {
  server.listen(CFG.port, CFG.host, () => console.log(`OTT Arena chạy tại http://localhost:${CFG.port}`));
}
module.exports = { server, CFG };
