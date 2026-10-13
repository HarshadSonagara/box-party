'use strict';

/**
 * Pure Dots & Boxes rules — no networking, no timers.
 *
 * A board of `size` x `size` boxes has (size + 1) x (size + 1) dots.
 *   h[r][c]  horizontal line from dot (r, c) to dot (r, c + 1)   r: 0..size    c: 0..size-1
 *   v[r][c]  vertical line   from dot (r, c) to dot (r + 1, c)   r: 0..size-1  c: 0..size
 *   boxes[r][c]  box whose top-left dot is (r, c)
 *   stars[r][c]  true for bonus boxes worth 2 points
 * Line and box slots hold the id of the player who drew / claimed them, or null.
 */

function grid(rows, cols, fill = null) {
  return Array.from({ length: rows }, () => Array(cols).fill(fill));
}

/** `stars` is a list of [r, c] bonus boxes. */
function createBoard(size, { stars = [] } = {}) {
  const board = {
    size,
    h: grid(size + 1, size),
    v: grid(size, size + 1),
    boxes: grid(size, size),
    stars: grid(size, size, false),
  };
  for (const [r, c] of stars) board.stars[r][c] = true;
  return board;
}

/** Picks `count` distinct random boxes, using `rand` (0 <= x < 1). */
function randomStars(size, count, rand = Math.random) {
  const all = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) all.push([r, c]);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, Math.min(count, all.length));
}

function cloneBoard(board) {
  return {
    size: board.size,
    h: board.h.map((row) => row.slice()),
    v: board.v.map((row) => row.slice()),
    boxes: board.boxes.map((row) => row.slice()),
    stars: board.stars,
  };
}

function linesFor(board, type) {
  if (type === 'h') return board.h;
  if (type === 'v') return board.v;
  return null;
}

/** True if `line` is a well-formed { type, r, c } that lies on the board. */
function isOnBoard(board, line) {
  if (!line || typeof line !== 'object') return false;
  const { type, r, c } = line;
  const lines = linesFor(board, type);
  if (!lines || !Number.isInteger(r) || !Number.isInteger(c)) return false;
  return r >= 0 && r < lines.length && c >= 0 && c < lines[0].length;
}

/** True if `line` is on the board and not drawn yet. */
function isValidLine(board, line) {
  return isOnBoard(board, line) && linesFor(board, line.type)[line.r][line.c] === null;
}

/** Bomb power: a drawn line can be erased only if it isn't a side of any claimed box. */
function isBombable(board, line) {
  return (
    isOnBoard(board, line) &&
    linesFor(board, line.type)[line.r][line.c] !== null &&
    adjacentBoxes(board, line).every(([r, c]) => board.boxes[r][c] === null)
  );
}

function eraseLine(board, line) {
  linesFor(board, line.type)[line.r][line.c] = null;
}

/** Every line the Bomb power could erase right now. */
function bombableLines(board) {
  const out = [];
  for (const type of ['h', 'v']) {
    linesFor(board, type).forEach((row, r) =>
      row.forEach((owner, c) => {
        if (owner !== null && isBombable(board, { type, r, c })) out.push({ type, r, c });
      })
    );
  }
  return out;
}

/** Number of drawn sides (0-4) around box (r, c). */
function sidesDrawn(board, r, c) {
  return (
    (board.h[r][c] !== null) +
    (board.h[r + 1][c] !== null) +
    (board.v[r][c] !== null) +
    (board.v[r][c + 1] !== null)
  );
}

/** The (up to two) boxes that share an edge with `line`, as [r, c] pairs. */
function adjacentBoxes(board, { type, r, c }) {
  const n = board.size;
  const out = [];
  if (type === 'h') {
    if (r > 0) out.push([r - 1, c]);
    if (r < n) out.push([r, c]);
  } else {
    if (c > 0) out.push([r, c - 1]);
    if (c < n) out.push([r, c]);
  }
  return out;
}

function boxValue(board, r, c) {
  return board.stars[r][c] ? 2 : 1;
}

/**
 * Draws `line` for `playerId` and claims every box it closes.
 * Caller must check isValidLine first. Returns the claimed boxes as [{ r, c }].
 */
function drawLine(board, line, playerId) {
  linesFor(board, line.type)[line.r][line.c] = playerId;
  const claimed = [];
  for (const [r, c] of adjacentBoxes(board, line)) {
    if (board.boxes[r][c] === null && sidesDrawn(board, r, c) === 4) {
      board.boxes[r][c] = playerId;
      claimed.push({ r, c });
    }
  }
  return claimed;
}

function isFull(board) {
  return board.boxes.every((row) => row.every((owner) => owner !== null));
}

/** Map of playerId -> points (1 per box, 2 per star box). */
function scores(board) {
  const out = {};
  board.boxes.forEach((row, r) =>
    row.forEach((owner, c) => {
      if (owner !== null) out[owner] = (out[owner] || 0) + boxValue(board, r, c);
    })
  );
  return out;
}

/** Every line not yet drawn, as [{ type, r, c }]. */
function freeLines(board) {
  const out = [];
  for (const type of ['h', 'v']) {
    linesFor(board, type).forEach((row, r) =>
      row.forEach((owner, c) => {
        if (owner === null) out.push({ type, r, c });
      })
    );
  }
  return out;
}

module.exports = {
  createBoard,
  randomStars,
  cloneBoard,
  isValidLine,
  isBombable,
  eraseLine,
  bombableLines,
  sidesDrawn,
  adjacentBoxes,
  boxValue,
  drawLine,
  isFull,
  scores,
  freeLines,
};
