'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Room } = require('../src/room');
const game = require('../src/game');
const ai = require('../src/ai');

function lobby(names, opts = {}) {
  const room = new Room('TEST', { turnSeconds: 0, botDelayMs: 1, ...opts });
  const players = names.map((n) => room.join(n));
  room.updateSettings(players[0].id, { gridSize: 3 });
  return { room, players };
}

const H = (r, c) => ({ type: 'h', r, c });
const V = (r, c) => ({ type: 'v', r, c });

test('powers are on by default and each can be used once per game, only on your turn', () => {
  const { room, players: [a, b] } = lobby(['Ann', 'Ben']);
  room.start(a.id);
  assert.deepEqual(room.publicState().game.players[0].powers, { freeze: true, double: true, bomb: true });

  assert.throws(() => room.usePower(b.id, 'double'), /on your turn/);
  assert.throws(() => room.usePower(a.id, 'teleport'), /Unknown power/);
  room.usePower(a.id, 'double');
  assert.throws(() => room.usePower(a.id, 'double'), /already used/);
  assert.equal(room.publicState().game.players[0].powers.double, false);
  assert.equal(room.lastPower.power, 'double');
});

test('powers can be switched off by the host', () => {
  const { room, players: [a] } = lobby(['Ann', 'Ben']);
  room.updateSettings(a.id, { powers: false });
  room.start(a.id);
  assert.throws(() => room.usePower(a.id, 'double'), /turned off/);
  assert.equal(room.publicState().game.players[0].powers, null);
});

test('Double: the next non-scoring line keeps your turn, then it is spent', () => {
  const { room, players: [a, b] } = lobby(['Ann', 'Ben']);
  room.start(a.id);
  room.usePower(a.id, 'double');
  room.move(a.id, H(0, 0));
  assert.equal(room.currentPlayerId(), a.id, 'still Ann after the doubled line');
  assert.equal(room.lastMove.doubled, true);
  room.move(a.id, H(0, 1));
  assert.equal(room.currentPlayerId(), b.id, 'second line passes the turn as usual');
});

test('Double lets you set a trap and collect it yourself', () => {
  const { room, players: [a] } = lobby(['Ann', 'Ben']);
  room.start(a.id);
  // Give box (0,0) two sides over a couple of turns.
  room.move(a.id, H(0, 0));
  room.move(room.currentPlayerId(), H(1, 0));
  // Back to Ann: she draws the 3rd side with Double armed, then takes the box.
  assert.equal(room.currentPlayerId(), a.id);
  room.usePower(a.id, 'double');
  room.move(a.id, V(0, 0));
  assert.equal(room.currentPlayerId(), a.id);
  assert.equal(room.move(a.id, V(0, 1)).length, 1);
  assert.equal(room.board.boxes[0][0], a.id);
});

test('Freeze: the next player misses exactly one turn (2 and 3 players)', () => {
  const two = lobby(['Ann', 'Ben']);
  two.room.start(two.players[0].id);
  two.room.usePower(two.players[0].id, 'freeze');
  assert.equal(two.room.frozenId, two.players[1].id);
  assert.throws(() => two.room.usePower(two.players[0].id, 'freeze'), /already used/);
  two.room.move(two.players[0].id, H(0, 0));
  assert.equal(two.room.currentPlayerId(), two.players[0].id, 'Ben skipped, back to Ann');
  assert.equal(two.room.lastSkip.playerId, two.players[1].id);
  two.room.move(two.players[0].id, H(0, 1));
  assert.equal(two.room.currentPlayerId(), two.players[1].id, 'freeze only lasts one turn');

  const three = lobby(['Ann', 'Ben', 'Cat']);
  const [a, b, c] = three.players;
  three.room.start(a.id);
  three.room.usePower(a.id, 'freeze');
  assert.equal(three.room.frozenId, b.id);
  three.room.move(a.id, H(0, 0));
  assert.equal(three.room.currentPlayerId(), c.id, 'Ben frozen, Cat plays');
  three.room.move(c.id, H(0, 1));
  assert.equal(three.room.currentPlayerId(), a.id);
  three.room.move(a.id, H(0, 2));
  assert.equal(three.room.currentPlayerId(), b.id, 'Ben is back');
});

test('Freeze is cleared if the frozen player leaves', () => {
  const { room, players: [a, b, c] } = lobby(['Ann', 'Ben', 'Cat']);
  room.start(a.id);
  room.usePower(a.id, 'freeze');
  room.leave(b.id);
  assert.equal(room.frozenId, null);
  room.move(a.id, H(0, 0));
  assert.equal(room.currentPlayerId(), c.id);
});

test('Bomb erases a drawn line, but never a side of a claimed box', () => {
  const { room, players: [a, b] } = lobby(['Ann', 'Ben']);
  room.start(a.id);
  room.move(a.id, H(0, 0));
  room.move(b.id, H(1, 0));
  room.move(a.id, V(0, 0));
  room.move(b.id, V(0, 1)); // Ben claims box (0,0) and goes again
  room.move(b.id, H(3, 2)); // a loose line far away; turn passes to Ann

  assert.equal(room.currentPlayerId(), a.id);
  assert.throws(() => room.usePower(a.id, 'bomb', H(0, 0)), /not part of a claimed box/);
  assert.throws(() => room.usePower(a.id, 'bomb', H(2, 2)), /not part of a claimed box/, 'empty line');
  assert.throws(() => room.usePower(a.id, 'bomb', { type: 'h', r: 99, c: 0 }), /not part of a claimed box/);
  room.usePower(a.id, 'bomb', H(3, 2));
  assert.equal(room.board.h[3][2], null);
  assert.deepEqual(room.lastPower.line, H(3, 2));
  assert.equal(room.currentPlayerId(), a.id, 'bombing does not end the turn');
});

test('bots use powers to escape forced sacrifices', () => {
  // 2x2 board with the border drawn: every move gives a box away.
  const board = game.createBoard(2);
  for (const l of [H(0, 0), H(0, 1), H(2, 0), H(2, 1), V(0, 0), V(1, 0), V(0, 2), V(1, 2)]) game.drawLine(board, l, 'x');
  const all = { freeze: true, double: true, bomb: true };
  assert.deepEqual(ai.choosePower(board, 'hard', all), { power: 'double' });
  assert.deepEqual(ai.choosePower(board, 'hard', { ...all, double: false }), { power: 'freeze' });
  assert.equal(
    ai.choosePower(board, 'hard', { ...all, double: false }, { canFreeze: false }).power,
    'bomb',
    'bomb when nothing else is left'
  );
  // With a safe move available, good bots keep their powers.
  assert.equal(ai.choosePower(game.createBoard(3), 'hard', all), null);
});

test('full games with power-up bots always finish with every box scored', async () => {
  for (let round = 0; round < 5; round++) {
    const room = new Room('BOTS', { turnSeconds: 0, botDelayMs: 1 });
    const human = room.join('Ann');
    room.updateSettings(human.id, { gridSize: 4, stars: true });
    for (const level of ['easy', 'medium', 'hard']) room.addBot(human.id, level);
    room.start(human.id);
    const end = Date.now() + 5000;
    while (room.phase === 'playing') {
      if (Date.now() > end) throw new Error('game did not finish');
      if (room.currentPlayerId() === human.id) room.move(human.id, game.freeLines(room.board)[0]);
      await new Promise((r) => setTimeout(r, 2));
    }
    const total = room.publicState().game.players.reduce((sum, p) => sum + p.score, 0);
    const stars = room.board.stars.flat().filter(Boolean).length;
    assert.equal(total, 16 + stars);
    room.dispose();
  }
});

test('timing out forfeits an armed Double, even if a freeze hands the turn straight back', async () => {
  const { room, players: [a, b] } = lobby(['Ann', 'Ben'], { turnSeconds: 0.05 });
  room.start(a.id);
  room.usePower(a.id, 'freeze');
  room.usePower(a.id, 'double');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(room.currentPlayerId(), a.id, 'Ben frozen, so the turn comes back to Ann');
  assert.equal(room.lastSkip.playerId, b.id);
  assert.equal(room.doubleArmed, false, 'the Double was lost with the timed-out turn');
  room.dispose();
});
