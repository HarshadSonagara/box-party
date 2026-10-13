'use strict';

// Production-readiness checks: hostile input, spam, concurrency, disconnects, cleanup.

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createGameServer } = require('../server');

function call(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

/** Keeps the latest 'state' a socket received, and waits for one that matches. */
function track(socket, initial = null) {
  const tracker = { state: initial, waiters: [], count: 0 }; // count = states received
  socket.on('state', (state) => {
    tracker.state = state;
    tracker.count++;
    tracker.waiters = tracker.waiters.filter((waiter) => !waiter(state));
  });
  tracker.until = (predicate, ms = 8000) =>
    new Promise((resolve, reject) => {
      if (tracker.state && predicate(tracker.state)) return resolve(tracker.state);
      const timer = setTimeout(() => reject(new Error('timed out waiting for state')), ms);
      tracker.waiters.push((state) => predicate(state) && (clearTimeout(timer), resolve(state), true));
    });
  return tracker;
}

const firstFreeLine = (g) =>
  ['h', 'v']
    .flatMap((type) => g[type].flatMap((row, r) => row.map((o, c) => (o === null ? { type, r, c } : null))))
    .find(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(t, opts = {}) {
  const game = createGameServer({ turnSeconds: 0, botDelayMs: 1, ...opts });
  await new Promise((resolve) => game.server.listen(0, resolve));
  const url = `http://localhost:${game.server.address().port}`;
  const clients = [];
  t.after(() => {
    clients.forEach((c) => c.close());
    game.close();
  });
  const client = () => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    return socket;
  };
  return { game, url, client };
}

/** Plays every one of `me`'s turns with the first free line until the game ends. */
async function playToEnd(socket, view, playerId) {
  for (;;) {
    const state = await view.until((s) => s.phase === 'over' || s.game?.turnPlayerId === playerId, 20000);
    if (state.phase === 'over') return state;
    const line = firstFreeLine(state.game);
    const seen = view.count;
    const res = await call(socket, 'game:move', line);
    assert.equal(res.ok, true, res.error);
    // Wait for any newer state: a bot may legally bomb our line right away.
    await view.until(() => view.count > seen);
  }
}

test('hostile and malformed payloads never crash the server', async (t) => {
  const { url, client } = await startServer(t, { eventRate: 1000, eventBurst: 1000 });
  const evil = client();
  const junk = [undefined, null, 0, 'x', [], [1, 2], { __proto__: { admin: true } }, { type: 'h', r: 1e12, c: -1 },
    { type: { $ne: 1 }, r: '0', c: '0' }, { gridSize: '5' }, { gridSize: 4.5 }, { turnSeconds: -1 },
    { emoji: { toString: 1 } }, { code: { length: 4 } }, { name: 'x'.repeat(5000) }, { level: 'god' }, { botId: [] },
    { token: 12345 }, { avatar: '<img src=x onerror=alert(1)>' }];
  const events = ['room:create', 'room:join', 'room:quickplay', 'room:settings', 'room:addBot', 'room:removeBot',
    'room:react', 'game:start', 'game:move', 'game:lobby', 'room:leave', 'lobby:watch', 'lobby:unwatch'];

  for (const event of events) {
    for (const payload of junk) {
      const res = await call(evil, event, payload);
      assert.equal(typeof res.ok, 'boolean', `${event} must always answer`);
      if (!res.ok) assert.equal(typeof res.error, 'string');
    }
  }
  // Payloads that are not even objects, and events with no ack at all.
  evil.emit('game:move', 'garbage');
  evil.emit('room:create');

  // Names are trimmed to 16 chars and avatars are whitelisted.
  const ok = await call(client(), 'room:create', { name: 'x'.repeat(5000), avatar: '<script>' });
  assert.equal(ok.ok, true);
  assert.equal(ok.state.members[0].name.length, 16);
  assert.notEqual(ok.state.members[0].avatar, '<script>');

  // Still healthy.
  const health = await (await fetch(`${url}/healthz`)).json();
  assert.equal(health.ok, true);
});

test('spamming events is rate-limited', async (t) => {
  const { client } = await startServer(t, { eventRate: 5, eventBurst: 10 });
  const spammer = client();
  const results = await Promise.all(Array.from({ length: 40 }, () => call(spammer, 'lobby:watch')));
  const limited = results.filter((r) => !r.ok && /slow down/i.test(r.error)).length;
  assert.ok(limited >= 25, `expected most calls limited, got ${limited}`);
  await sleep(1100);
  assert.equal((await call(spammer, 'lobby:watch')).ok, true, 'recovers after a pause');
});

test('double-tapping Join keeps the same seat and never deletes the room', async (t) => {
  const { game, client } = await startServer(t);
  const host = client();
  const created = await call(host, 'room:create', { name: 'Solo' });
  const again = await call(host, 'room:join', { code: created.code, name: 'Solo' });
  assert.equal(again.ok, true);
  assert.equal(again.playerId, created.playerId);
  assert.equal(game.rooms.size, 1);
  assert.equal(game.rooms.get(created.code).members.length, 1);
});

test('host disconnecting mid-game hands over host and the timer skips them', async (t) => {
  const { client } = await startServer(t, { turnSeconds: 0.3 });
  const ann = client();
  const ben = client();
  const a = await call(ann, 'room:create', { name: 'Ann' });
  const benView = track(ben);
  const b = await call(ben, 'room:join', { code: a.code, name: 'Ben' });
  await call(ann, 'room:settings', { gridSize: 3 });
  await call(ann, 'game:start');
  await benView.until((s) => s.phase === 'playing' && s.game.turnPlayerId === a.playerId);

  ann.close(); // host vanishes on their own turn
  const after = await benView.until((s) => s.hostId === b.playerId && s.game.turnPlayerId === b.playerId);
  assert.equal(after.members.find((m) => m.id === a.playerId).connected, false);

  // Ben can finish the game alone; Ann's turns keep getting skipped.
  const end = await playToEnd(ben, benView, b.playerId);
  assert.equal(end.phase, 'over');
});

test('offline players are removed after the grace period and empty rooms are deleted', async (t) => {
  const { game, client } = await startServer(t, { offlineGraceMs: 100, sweepIntervalMs: 50 });
  const ann = client();
  const ben = client();
  const a = await call(ann, 'room:create', { name: 'Ann' });
  const annView = track(ann);
  const b = await call(ben, 'room:join', { code: a.code, name: 'Ben' });
  ben.close();
  await annView.until((s) => !s.members.some((m) => m.id === b.playerId), 3000);

  ann.close();
  for (let i = 0; i < 60 && game.rooms.size > 0; i++) await sleep(50);
  assert.equal(game.rooms.size, 0, 'abandoned room is cleaned up');
});

test('the last human leaving deletes a room full of bots', async (t) => {
  const { game, client } = await startServer(t, { botDelayMs: 50 });
  const solo = client();
  await call(solo, 'room:quickplay', { name: 'Solo', level: 'hard' });
  assert.equal(game.rooms.size, 1);
  await call(solo, 'room:leave');
  assert.equal(game.rooms.size, 0);
});

test('a full room: 6 seats, spectators beyond that, hard cap on members', async (t) => {
  const { client } = await startServer(t);
  const host = client();
  const created = await call(host, 'room:create', { name: 'Host' });
  const joins = [];
  for (let i = 0; i < 15; i++) joins.push(await call(client(), 'room:join', { code: created.code, name: `P${i}` }));
  assert.ok(joins.every((j) => j.ok));
  const last = joins.at(-1).state;
  assert.equal(last.members.length, 16);
  assert.equal(last.members.filter((m) => m.seated).length, 6);

  const overflow = await call(client(), 'room:join', { code: created.code, name: 'Late' });
  assert.deepEqual(overflow, { ok: false, error: 'This room is full.' });
  assert.equal((await call(host, 'room:addBot', { level: 'easy' })).ok, false, 'no seat for a bot either');
});

test('20 simultaneous games against bots all finish correctly', async (t) => {
  const { game, client } = await startServer(t, { botDelayMs: 5 });
  const runs = Array.from({ length: 20 }, async (_, i) => {
    const socket = client();
    const view = track(socket);
    const res = await call(socket, 'room:quickplay', { name: `Player ${i}`, level: ['easy', 'medium', 'hard'][i % 3] });
    assert.equal(res.ok, true, res.error);
    view.state = res.state;
    const end = await playToEnd(socket, view, res.playerId);
    const total = end.game.players.reduce((sum, p) => sum + p.score, 0);
    assert.equal(total, 16, 'every box on the 4x4 board is scored exactly once');
    return end;
  });
  const ends = await Promise.all(runs);
  assert.equal(ends.length, 20);
  assert.equal((await call(client(), 'lobby:watch')).stats.gamesPlayed, 20);
  assert.equal(game.rooms.size, 20);
});

test('static site, API and errors respond correctly', async (t) => {
  const { url } = await startServer(t);
  const home = await fetch(url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await home.text(), /<title>Box Party/);
  for (const asset of ['/app.js', '/styles.css', '/socket.io/socket.io.js']) {
    assert.equal((await fetch(url + asset)).status, 200, asset);
  }
  assert.equal((await fetch(`${url}/nope`)).status, 404);
  assert.equal((await fetch(`${url}/../server.js`)).status, 404, 'no path traversal');
});

test('an expired seat never drops the player into someone else\'s room', async (t) => {
  const { client } = await startServer(t);
  const stranger = client();
  const room = await call(stranger, 'room:create', { name: 'Stranger' });
  const res = await call(client(), 'room:join', { code: room.code, token: 'f'.repeat(32), name: 'Old' });
  assert.equal(res.ok, false);
  assert.match(res.error, /previous game has ended/);
  // Joining normally with the code (no token) still works.
  assert.equal((await call(client(), 'room:join', { code: room.code, name: 'New' })).ok, true);
});
