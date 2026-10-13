'use strict';
/**
 * OTTv2 – luật chơi (một file duy nhất để dễ chỉnh).
 *
 * Bàn 9x9. Mỗi bên 9 quân: 3 Búa (R), 3 Bao (P), 3 Kéo (S).
 * Quân đi 1 ô theo 8 hướng (như vua cờ vua).
 *  - Ô trống: đi được.
 *  - Ô quân mình: không được.
 *  - Ô quân địch: chỉ được đi vào nếu THẮNG kéo-búa-bao (Búa>Kéo, Kéo>Bao, Bao>Búa);
 *    quân địch bị loại, quân mình chiếm ô. Hòa hoặc thua => nước đi không hợp lệ.
 * Thắng:
 *  - Loại hết quân đối thủ (ELIMINATION)
 *  - Đối thủ đến lượt mà không còn nước đi (NO_LEGAL_MOVES)
 *  - Đưa được quân cờ vào chuồng đối phương (REACHED_BASE)
 *  - Sau MAX_PLIES nước: bên nhiều quân hơn thắng; bằng nhau thì RED thắng (MOVE_LIMIT)
 *  - Đối thủ trả nước sai / lỗi code / quá giờ (ILLEGAL_MOVE / RUNTIME_ERROR / TIMEOUT)
 */
const SIZE = 9;
const MAX_PLIES = 200;
const BEATS = { R: 'S', S: 'P', P: 'R' };
const DIRS = [];
for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) DIRS.push([dr, dc]);

const other = (side) => (side === 'RED' ? 'BLUE' : 'RED');
const inBounds = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const clone = (x) => JSON.parse(JSON.stringify(x));

function shuffle(a, rng = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Thế cờ đầu ngẫu nhiên, đối xứng xoay 180° nên công bằng cho hai bên. */
function createInitialState(rng = Math.random) {
  const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  const cells = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < SIZE; c++) cells.push([r, c]);
  shuffle(cells, rng);
  const types = shuffle(['R', 'R', 'R', 'P', 'P', 'P', 'S', 'S', 'S'], rng);
  cells.slice(0, 9).forEach(([r, c], i) => {
    board[r][c] = { o: 'RED', t: types[i] };
    board[SIZE - 1 - r][SIZE - 1 - c] = { o: 'BLUE', t: types[i] };
  });
  return { board, turn: 'RED', ply: 0, status: 'PLAYING', winner: null, reason: null };
}

function legalMoves(state, side) {
  const moves = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const p = state.board[r][c];
      if (!p || p.o !== side) continue;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const t = state.board[nr][nc];
        if (!t) moves.push({ from: [r, c], to: [nr, nc], capture: false });
        else if (t.o !== side && BEATS[p.t] === t.t) moves.push({ from: [r, c], to: [nr, nc], capture: true });
      }
    }
  }
  return moves;
}

function count(state, side) {
  let n = 0;
  for (const row of state.board) for (const p of row) if (p && p.o === side) n++;
  return n;
}

function finish(state, winner, reason) {
  state.status = 'FINISHED';
  state.winner = winner;
  state.reason = reason;
  return state;
}

/** Bên `side` bị xử thua (lỗi code, quá giờ, nước sai...). Trả state mới. */
function forfeit(state, side, reason) {
  return finish(clone(state), other(side), reason);
}

/** Áp dụng nước đi. Không mutate state cũ. */
function applyMove(state, side, move) {
  if (state.status !== 'PLAYING') return { ok: false, error: 'MATCH_FINISHED' };
  if (state.turn !== side) return { ok: false, error: 'NOT_YOUR_TURN' };
  if (!move || !Array.isArray(move.from) || !Array.isArray(move.to) || move.from.length !== 2 || move.to.length !== 2) {
    return { ok: false, error: 'BAD_MOVE_FORMAT' };
  }
  const [fr, fc] = move.from.map(Number);
  const [tr, tc] = move.to.map(Number);
  const legal = legalMoves(state, side).find(
    (m) => m.from[0] === fr && m.from[1] === fc && m.to[0] === tr && m.to[1] === tc
  );
  if (!legal) return { ok: false, error: 'ILLEGAL_MOVE' };

  const next = clone(state);
  const piece = next.board[fr][fc];
  const captured = next.board[tr][tc];
  next.board[tr][tc] = piece;
  next.board[fr][fc] = null;
  next.ply += 1;

  // --- LUẬT MỚI: Đưa được quân vào chuồng đối phương ---
  // RED đi vào chuồng BLUE (góc trái dưới)
  if (side === 'RED' && tr === SIZE - 1 && tc === 0) {
    return { ok: true, state: finish(next, 'RED', 'REACHED_BASE'), captured, move: legal };
  }
  // BLUE đi vào chuồng RED (góc phải trên)
  if (side === 'BLUE' && tr === 0 && tc === SIZE - 1) {
    return { ok: true, state: finish(next, 'BLUE', 'REACHED_BASE'), captured, move: legal };
  }

  const opp = other(side);
  if (count(next, opp) === 0) return { ok: true, state: finish(next, side, 'ELIMINATION'), captured, move: legal };
  next.turn = opp;
  if (legalMoves(next, opp).length === 0) return { ok: true, state: finish(next, side, 'NO_LEGAL_MOVES'), captured, move: legal };
  if (next.ply >= MAX_PLIES) {
    const a = count(next, 'RED'), b = count(next, 'BLUE');
    return { ok: true, state: finish(next, b > a ? 'BLUE' : 'RED', 'MOVE_LIMIT'), captured, move: legal };
  }
  return { ok: true, state: next, captured, move: legal };
}

/** Góc nhìn dành cho bot: owner = 'me' | 'enemy'. */
function toView(state, side) {
  return {
    you: side,
    turn: state.turn,
    ply: state.ply,
    maxPlies: MAX_PLIES,
    size: SIZE,
    beats: BEATS,
    board: state.board.map((row) => row.map((p) => (p ? { owner: p.o === side ? 'me' : 'enemy', type: p.t } : null))),
    legalMoves: legalMoves(state, side),
  };
}

module.exports = { SIZE, MAX_PLIES, BEATS, other, createInitialState, legalMoves, applyMove, forfeit, toView, count, clone };