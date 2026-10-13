'use strict';

const game = require('./game');

const LEVELS = ['easy', 'medium', 'hard'];

/** Points a line would win right now (boxes it closes, stars count double). */
function captureValue(board, line) {
  let value = 0;
  for (const [r, c] of game.adjacentBoxes(board, line)) {
    if (board.boxes[r][c] === null && game.sidesDrawn(board, r, c) === 3) {
      value += game.boxValue(board, r, c);
    }
  }
  return value;
}

/** True if the line gives some box its 3rd side, handing it to the next player. */
function isRisky(board, line) {
  return game
    .adjacentBoxes(board, line)
    .some(([r, c]) => board.boxes[r][c] === null && game.sidesDrawn(board, r, c) === 2);
}

/** Points the opponent can grab, by greedily closing boxes, after we play `line`. */
function giveaway(board, line) {
  const b = game.cloneBoard(board);
  game.drawLine(b, line, '_me');
  let total = 0;
  for (;;) {
    const take = game.freeLines(b).find((l) => captureValue(b, l) > 0);
    if (!take) return total;
    for (const { r, c } of game.drawLine(b, take, '_them')) total += game.boxValue(b, r, c);
  }
}

/**
 * Picks a line for a bot.
 *   easy   – grabs a free box half the time, otherwise plays anywhere
 *   medium – always grabs boxes, avoids drawing 3rd sides when it can
 *   hard   – like medium, but when forced to give boxes away it gives the fewest points
 */
function chooseMove(board, level = 'medium', rand = Math.random) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const free = game.freeLines(board);
  if (free.length === 0) return null;

  const captures = free.filter((l) => captureValue(board, l) > 0);
  if (level === 'easy') {
    return captures.length > 0 && rand() < 0.5 ? pick(captures) : pick(free);
  }

  if (captures.length > 0) {
    if (level !== 'hard') return pick(captures);
    const best = Math.max(...captures.map((l) => captureValue(board, l)));
    return pick(captures.filter((l) => captureValue(board, l) === best));
  }

  const safe = free.filter((l) => !isRisky(board, l));
  if (safe.length > 0) return pick(safe);
  if (level !== 'hard') return pick(free);

  let fewest = Infinity;
  let options = [];
  for (const line of free) {
    const cost = giveaway(board, line);
    if (cost < fewest) {
      fewest = cost;
      options = [line];
    } else if (cost === fewest) {
      options.push(line);
    }
  }
  return pick(options);
}

/**
 * Decides whether a bot should use a power-up before its move. Returns
 * { power, line? } or null. `available` is { freeze, double, bomb } (true = unused).
 *   easy          – now and then fires a random power, just for chaos
 *   medium / hard – save powers until every line would gift a box, then use one
 *                   to turn the sacrifice around (Double / Freeze let the bot
 *                   collect its own gift; Bomb erases a line to create a safe move)
 */
function choosePower(board, level, available, { canFreeze = true } = {}, rand = Math.random) {
  if (!available) return null;
  const free = game.freeLines(board);
  if (free.length === 0) return null;
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const has = (power) => available[power] && (power !== 'freeze' || canFreeze);

  if (level === 'easy') {
    if (rand() >= 0.08) return null;
    const options = ['freeze', 'double'].filter(has);
    const bombs = has('bomb') ? game.bombableLines(board) : [];
    if (bombs.length) options.push('bomb');
    if (options.length === 0) return null;
    const power = pick(options);
    return power === 'bomb' ? { power, line: pick(bombs) } : { power };
  }

  if (free.some((l) => captureValue(board, l) > 0)) return null; // take the boxes first
  if (free.some((l) => !isRisky(board, l))) return null; // no pressure: save powers

  if (has('double')) return { power: 'double' };
  if (has('freeze')) return { power: 'freeze' };
  if (has('bomb')) {
    const rescues = game.bombableLines(board).filter((line) => {
      const b = game.cloneBoard(board);
      game.eraseLine(b, line);
      return game.freeLines(b).some((l) => !isRisky(b, l));
    });
    if (rescues.length) return { power: 'bomb', line: pick(rescues) };
  }
  return null;
}

module.exports = { chooseMove, choosePower, captureValue, isRisky, giveaway, LEVELS };
