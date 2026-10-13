'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, GameError, MAX_SEATS } = require('../src/room');
const { freeLines } = require('../src/game');

function lobby(names, opts = {}) {
  const room = new Room('TEST', { turnSeconds: 0, botDelayMs: 1, ...opts });
  const players = names.map((n) => room.join(n));
  return { room, players };
}

function startSmall(room, hostId, extra = {}) {
  room.updateSettings(hostId, { gridSize: 3, ...extra });
  room.start(hostId);
}

function playOut(room) {
  while (room.phase === 'playing') room.move(room.currentPlayerId(), freeLines(room.board)[0]);
}

const waitFor = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('first player is host; names are cleaned and made unique', () => {
  const { room, players } = lobby(['  Ann  ', 'ann', '\u0007']);
  assert.equal(room.hostId, players[0].id);
  assert.deepEqual(players.map((p) => p.name), ['Ann', 'ann 2', 'Player']);
  assert.equal(new Set(players.map((p) => p.color)).size, 3);
  assert.ok(players.every((p) => p.avatar));
});

test('public state never leaks reconnect tokens', () => {
  const { room, players } = lobby(['Ann', 'Ben']);
  room.start(players[0].id);
  const json = JSON.stringify(room.publicState());
  for (const p of players) assert.equal(json.includes(p.token), false);
});

test('only the host can start or change settings, and only with 2+ players', () => {
  const { room, players } = lobby(['Ann']);
  assert.throws(() => room.start(players[0].id), /at least 2 players/);
  const ben = room.join('Ben');
  assert.throws(() => room.start(ben.id), GameError);
  assert.throws(() => room.updateSettings(ben.id, { gridSize: 5 }), /Only the host/);
  assert.throws(() => room.updateSettings(players[0].id, { gridSize: 9 }), /board size/);
  assert.throws(() => room.updateSettings(players[0].id, { turnSeconds: 7 }), /timer/);
  room.updateSettings(players[0].id, { gridSize: 5, turnSeconds: 10, stars: 1, isPublic: 0 });
  assert.deepEqual(room.settings, { gridSize: 5, turnSeconds: 10, stars: true, isPublic: false });
  room.start(players[0].id);
  assert.equal(room.phase, 'playing');
  assert.throws(() => room.updateSettings(players[0].id, { gridSize: 3 }), /lobby/);
});

test('turn passes on a plain line but stays after closing a box', () => {
  const { room, players: [a, b] } = lobby(['Ann', 'Ben']);
  startSmall(room, a.id);
  assert.equal(room.currentPlayerId(), a.id);
  assert.throws(() => room.move(b.id, { type: 'h', r: 0, c: 0 }), /not your turn/);

  room.move(a.id, { type: 'h', r: 0, c: 0 });
  room.move(b.id, { type: 'h', r: 1, c: 0 });
  room.move(a.id, { type: 'v', r: 0, c: 0 });
  assert.equal(room.currentPlayerId(), b.id);
  assert.equal(room.move(b.id, { type: 'v', r: 0, c: 1 }).length, 1);
  assert.equal(room.currentPlayerId(), b.id, 'closing a box earns another turn');
  assert.equal(room.lastMove.combo, 1);
  assert.throws(() => room.move(b.id, { type: 'v', r: 0, c: 1 }), /already taken/);
});

test('a full game ends with the right winner, a win tally and awards', () => {
  const { room, players: [a, b] } = lobby(['Ann', 'Ben']);
  startSmall(room, a.id);
  playOut(room);
  assert.equal(room.phase, 'over');
  const { players, awards } = room.publicState().game;
  const best = Math.max(...players.map((p) => p.score));
  assert.equal(players.reduce((sum, p) => sum + p.score, 0), 9);
  assert.deepEqual(room.winnerIds, players.filter((p) => p.score === best).map((p) => p.id));
  for (const id of room.winnerIds) assert.equal(room.getMember(id).wins, 1);
  assert.ok(awards.some((w) => w.title === 'Combo King'), 'someone chained boxes');
  assert.ok(awards.some((w) => w.title === 'Lightning Hands'));

  // Rematch: the other player starts round 2.
  room.start(a.id);
  assert.equal(room.currentPlayerId(), b.id);
});

test('star boxes are worth 2 points', () => {
  const { room, players: [a] } = lobby(['Ann', 'Ben']);
  startSmall(room, a.id, { stars: true });
  const starCount = room.board.stars.flat().filter(Boolean).length;
  assert.ok(starCount >= 2);
  playOut(room);
  const total = room.publicState().game.players.reduce((sum, p) => sum + p.score, 0);
  assert.equal(total, 9 + starCount);
  assert.ok(room.awards.some((w) => w.title === 'Star Hunter'));
});

test('late joiners watch, then get a seat in the rematch', () => {
  const { room, players: [a, b] } = lobby(['Ann', 'Ben']);
  startSmall(room, a.id);
  const cat = room.join('Cat');
  assert.equal(cat.seated, false);
  assert.equal(room.turnOrder.includes(cat.id), false);
  assert.throws(() => room.move(cat.id, { type: 'h', r: 0, c: 0 }), /not your turn/);

  playOut(room);
  room.start(a.id);
  assert.deepEqual(room.turnOrder, [a.id, b.id, cat.id]);
});

test('only MAX_SEATS members are seated', () => {
  const { room } = lobby(Array.from({ length: MAX_SEATS + 2 }, (_, i) => `P${i}`));
  assert.equal(room.members.filter((m) => m.seated).length, MAX_SEATS);
});

test('reconnecting with a token restores the same player', () => {
  const { room, players: [a] } = lobby(['Ann', 'Ben']);
  room.disconnect(a.id);
  assert.equal(room.getMember(a.id).connected, false);
  assert.notEqual(room.hostId, a.id, 'host moves to someone online');
  const again = room.join('Someone else', a.token);
  assert.equal(again.id, a.id);
  assert.equal(again.name, 'Ann');
  assert.equal(again.connected, true);
  assert.equal(room.members.length, 2);
});

test('offline players are skipped and the game ends if only one remains', () => {
  const { room, players: [a, b, c] } = lobby(['Ann', 'Ben', 'Cat']);
  startSmall(room, a.id);
  room.disconnect(b.id);
  room.move(a.id, { type: 'h', r: 0, c: 0 });
  assert.equal(room.currentPlayerId(), c.id, 'Ben is offline, so Cat goes next');

  room.leave(c.id);
  assert.equal(room.phase, 'playing');
  assert.equal(room.currentPlayerId(), a.id);
  room.leave(b.id);
  assert.equal(room.phase, 'over');
  assert.deepEqual(room.winnerIds, [a.id]);
});

test('pruneDisconnected removes players after the grace period', () => {
  let now = 0;
  const { room, players: [a, b] } = lobby(['Ann', 'Ben'], { now: () => now });
  room.disconnect(b.id);
  now = 1000;
  assert.deepEqual(room.pruneDisconnected(5000), []);
  now = 10_000;
  assert.deepEqual(room.pruneDisconnected(5000).map((m) => m.id), [b.id]);
  assert.deepEqual(room.members.map((m) => m.id), [a.id]);
});

test('turn timer skips a slow player', async () => {
  const events = [];
  const { room, players: [a, b] } = lobby(['Ann', 'Ben'], {
    turnSeconds: 0.05,
    onChange: (e) => events.push(e),
  });
  room.start(a.id);
  assert.ok(room.publicState().game.turnEndsInMs > 0);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(room.currentPlayerId(), b.id);
  assert.deepEqual(events, [{ type: 'timeout', playerId: a.id }]);
  room.dispose();
});

test('host can add and remove bots; bots are never host', () => {
  const { room, players: [a] } = lobby(['Ann']);
  const bot = room.addBot(a.id, 'hard');
  assert.equal(bot.isBot, true);
  assert.equal(bot.seated, true);
  assert.throws(() => room.addBot(a.id, 'godlike'), /level/);
  room.leave(a.id);
  assert.equal(room.hostId, null, 'a bot never becomes host');
  assert.equal(room.humanCount(), 0);

  const { room: r2, players: [ann, ben] } = lobby(['Ann', 'Ben']);
  const b2 = r2.addBot(ann.id);
  assert.throws(() => r2.addBot(ben.id), /Only the host/);
  assert.throws(() => r2.removeBot(ann.id, ben.id), /not a bot/);
  r2.removeBot(ann.id, b2.id);
  assert.equal(r2.members.length, 2);
});

test('bots play their turns on their own until the game ends', async () => {
  let finished = 0;
  const { room, players: [a] } = lobby(['Ann'], { onFinish: () => finished++ });
  room.addBot(a.id, 'easy');
  room.addBot(a.id, 'hard');
  startSmall(room, a.id);
  // Ann plays the first free line whenever it is her turn; bots do the rest.
  await waitFor(() => {
    if (room.phase === 'playing' && room.currentPlayerId() === a.id) {
      room.move(a.id, freeLines(room.board)[0]);
    }
    return room.phase === 'over';
  });
  assert.equal(finished, 1);
  assert.equal(room.publicState().game.players.reduce((s, p) => s + p.score, 0), 9);
});

test('bots pause while every human is offline', async () => {
  const { room, players: [a] } = lobby(['Ann']);
  room.addBot(a.id);
  room.addBot(a.id);
  startSmall(room, a.id);
  room.disconnect(a.id);
  if (room.currentPlayerId() === a.id) room.advanceTurn(1);
  const lines = freeLines(room.board).length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(freeLines(room.board).length, lines, 'no bot moves while nobody watches');
  room.join('', a.token);
  await waitFor(() => freeLines(room.board).length < lines);
  room.dispose();
});
