'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../src/game');
const ai = require('../src/ai');

function boardWith(size, lines, opts) {
  const board = game.createBoard(size, opts);
  for (const [type, r, c] of lines) game.drawLine(board, { type, r, c }, 'x');
  return board;
}

const same = (a, b) => a.type === b.type && a.r === b.r && a.c === b.c;

test('medium and hard bots always take a free box', () => {
  // Box (0,0) has three sides; only v(0,1) closes it.
  const board = boardWith(3, [['h', 0, 0], ['h', 1, 0], ['v', 0, 0]]);
  for (const level of ['medium', 'hard']) {
    for (let i = 0; i < 20; i++) {
      assert.ok(same(ai.chooseMove(board, level), { type: 'v', r: 0, c: 1 }));
    }
  }
});

test('hard bot prefers the more valuable capture', () => {
  const board = boardWith(
    2,
    [['h', 0, 0], ['h', 1, 0], ['v', 0, 0], ['h', 0, 1], ['h', 1, 1], ['v', 0, 2]],
    { stars: [[0, 1]] }
  );
  // v(0,1) closes both top boxes (one is a star) — worth 3.
  assert.ok(same(ai.chooseMove(board, 'hard'), { type: 'v', r: 0, c: 1 }));
});

test('medium and hard bots avoid drawing a third side when a safe line exists', () => {
  const board = boardWith(3, [['h', 0, 0], ['v', 0, 0]]); // box (0,0) has two sides
  for (let i = 0; i < 50; i++) {
    const line = ai.chooseMove(board, 'hard');
    assert.equal(ai.isRisky(board, line), false);
    assert.equal(ai.isRisky(board, ai.chooseMove(board, 'medium')), false);
  }
});

test('when forced to give boxes away, hard bot gives away the fewest', () => {
  // 2x2 board with the outer border drawn: every box has two sides, so any move gifts boxes.
  const border = [['h', 0, 0], ['h', 0, 1], ['h', 2, 0], ['h', 2, 1], ['v', 0, 0], ['v', 1, 0], ['v', 0, 2], ['v', 1, 2]];
  const board = boardWith(2, border);
  const costs = game.freeLines(board).map((l) => ai.giveaway(board, l));
  assert.ok(costs.every((cost) => cost > 0));
  const fewest = Math.min(...costs);
  for (let i = 0; i < 20; i++) {
    assert.equal(ai.giveaway(board, ai.chooseMove(board, 'hard')), fewest);
  }
});

test('every level returns a legal line until the board is full', () => {
  for (const level of ai.LEVELS) {
    const board = game.createBoard(4);
    let turn = 0;
    while (!game.isFull(board)) {
      const line = ai.chooseMove(board, level);
      assert.ok(game.isValidLine(board, line));
      if (game.drawLine(board, line, `p${turn % 2}`).length === 0) turn++;
    }
    assert.equal(ai.chooseMove(board, level), null);
  }
});
