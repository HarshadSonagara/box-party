'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../src/game');

test('board has the right number of lines and boxes', () => {
  const board = game.createBoard(3);
  assert.equal(board.h.length, 4);
  assert.equal(board.h[0].length, 3);
  assert.equal(board.v.length, 3);
  assert.equal(board.v[0].length, 4);
  assert.equal(game.freeLines(board).length, 2 * 3 * 4);
});

test('rejects malformed, out-of-range and already drawn lines', () => {
  const board = game.createBoard(2);
  assert.equal(game.isValidLine(board, null), false);
  assert.equal(game.isValidLine(board, { type: 'x', r: 0, c: 0 }), false);
  assert.equal(game.isValidLine(board, { type: 'h', r: '0', c: 0 }), false);
  assert.equal(game.isValidLine(board, { type: 'h', r: 0, c: 2 }), false);
  assert.equal(game.isValidLine(board, { type: 'v', r: 2, c: 0 }), false);
  assert.equal(game.isValidLine(board, { type: 'h', r: -1, c: 0 }), false);
  assert.equal(game.isValidLine(board, { type: 'h', r: 2, c: 1 }), true);
  game.drawLine(board, { type: 'h', r: 2, c: 1 }, 'a');
  assert.equal(game.isValidLine(board, { type: 'h', r: 2, c: 1 }), false);
});

test('closing the fourth side claims the box', () => {
  const board = game.createBoard(2);
  assert.deepEqual(game.drawLine(board, { type: 'h', r: 0, c: 0 }, 'a'), []);
  assert.deepEqual(game.drawLine(board, { type: 'h', r: 1, c: 0 }, 'b'), []);
  assert.deepEqual(game.drawLine(board, { type: 'v', r: 0, c: 0 }, 'a'), []);
  assert.deepEqual(game.drawLine(board, { type: 'v', r: 0, c: 1 }, 'b'), [{ r: 0, c: 0 }]);
  assert.equal(board.boxes[0][0], 'b');
  assert.deepEqual(game.scores(board), { b: 1 });
});

test('one line can close two boxes at once', () => {
  const board = game.createBoard(2);
  for (const line of [
    { type: 'h', r: 0, c: 0 }, { type: 'h', r: 1, c: 0 }, { type: 'v', r: 0, c: 0 },
    { type: 'h', r: 0, c: 1 }, { type: 'h', r: 1, c: 1 }, { type: 'v', r: 0, c: 2 },
  ]) {
    game.drawLine(board, line, 'a');
  }
  const claimed = game.drawLine(board, { type: 'v', r: 0, c: 1 }, 'b');
  assert.deepEqual(claimed, [{ r: 0, c: 0 }, { r: 0, c: 1 }]);
  assert.deepEqual(game.scores(board), { b: 2 });
});

test('board is full once every line is drawn', () => {
  const board = game.createBoard(3);
  for (const line of game.freeLines(board)) {
    assert.equal(game.isFull(board), false);
    game.drawLine(board, line, 'a');
  }
  assert.equal(game.isFull(board), true);
  assert.deepEqual(game.scores(board), { a: 9 });
});
