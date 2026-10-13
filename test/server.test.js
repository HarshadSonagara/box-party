'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createGameServer } = require('../server');

function call(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function nextEvent(socket, event, predicate = () => true) {
  return new Promise((resolve) => {
    const handler = (data) => {
      if (!predicate(data)) return;
      socket.off(event, handler);
      resolve(data);
    };
    socket.on(event, handler);
  });
}

/** Keeps the latest 'state' a socket received, and waits for one that matches. */
function track(socket, initial = null) {
  const tracker = { state: initial, waiters: [], count: 0 }; // count = states received
  socket.on('state', (state) => {
    tracker.state = state;
    tracker.count++;
    tracker.waiters = tracker.waiters.filter((waiter) => !waiter(state));
  });
  tracker.until = (predicate) =>
    new Promise((resolve) => {
      if (tracker.state && predicate(tracker.state)) return resolve(tracker.state);
      tracker.waiters.push((state) => predicate(state) && (resolve(state), true));
    });
  return tracker;
}

const firstFreeLine = (g) =>
  ['h', 'v']
    .flatMap((type) => g[type].flatMap((row, r) => row.map((o, c) => (o === null ? { type, r, c } : null))))
    .find(Boolean);
const drawn = (line) => (s) => s.game?.[line.type][line.r][line.c] != null;

async function startServer(t) {
  const game = createGameServer({ turnSeconds: 0, botDelayMs: 1 });
  await new Promise((resolve) => game.server.listen(0, resolve));
  const url = `http://localhost:${game.server.address().port}`;
  const clients = [];
  t.after(() => {
    clients.forEach((c) => c.close());
    game.close();
  });
  const client = () => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true });
    clients.push(socket);
    return socket;
  };
  return { url, client };
}

test('two devices play a full synced game over websockets', async (t) => {
  const { url, client } = await startServer(t);
  const ann = client();
  const ben = client();

  const created = await call(ann, 'room:create', { name: 'Ann', avatar: 'moon' });
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-Z]{4}$/);
  assert.equal(created.state.members[0].avatar, 'moon');

  const bad = await call(ben, 'room:join', { code: 'ZZZZ', name: 'Ben' });
  assert.deepEqual(bad, { ok: false, error: 'No room with that code. Check it and try again.' });

  const joined = await call(ben, 'room:join', { code: created.code.toLowerCase(), name: 'Ben' });
  assert.equal(joined.ok, true);
  assert.equal(joined.state.members.length, 2);

  // The room shows up in the public directory.
  const lobby = await (await fetch(`${url}/api/lobby`)).json();
  assert.equal(lobby.rooms[0].code, created.code);
  assert.equal(lobby.rooms[0].players, 2);
  assert.ok(lobby.stats.online >= 2);

  assert.equal((await call(ben, 'game:start')).ok, false, 'only the host starts');
  assert.equal((await call(ann, 'room:settings', { gridSize: 3 })).ok, true);

  const started = nextEvent(ben, 'state', (s) => s.phase === 'playing');
  assert.equal((await call(ann, 'game:start')).ok, true);
  let state = await started;

  // Reactions reach the other device.
  const reaction = nextEvent(ann, 'reaction');
  assert.equal((await call(ben, 'room:react', { emoji: '🔥' })).ok, true);
  assert.deepEqual(await reaction, { by: joined.playerId, emoji: '🔥' });
  assert.equal((await call(ben, 'room:react', { emoji: '<b>' })).ok, false);

  const byId = { [created.playerId]: ann, [joined.playerId]: ben };
  const views = new Map([[ann, track(ann)], [ben, track(ben)]]);
  while (state.phase === 'playing') {
    const line = firstFreeLine(state.game);
    const mover = byId[state.game.turnPlayerId];
    const other = mover === ann ? ben : ann;
    const res = await call(mover, 'game:move', line);
    assert.equal(res.ok, true, res.error);
    state = await views.get(other).until(drawn(line)); // the other device sees the move
    assert.equal(state.game[line.type][line.r][line.c], mover === ann ? created.playerId : joined.playerId);
  }

  assert.equal(state.phase, 'over');
  assert.equal(state.game.players.reduce((sum, p) => sum + p.score, 0), 9);
  assert.ok(state.game.winnerIds.length >= 1);
  assert.equal((await (await fetch(`${url}/api/lobby`)).json()).stats.gamesPlayed, 1);

  // A refresh: Ben reconnects on a new socket with his token and keeps his identity.
  ben.close();
  const ben2 = client();
  const rejoined = await call(ben2, 'room:join', { code: created.code, token: joined.token });
  assert.equal(rejoined.ok, true);
  assert.equal(rejoined.playerId, joined.playerId);
});

test('quick play starts a private game against a bot that moves by itself', async (t) => {
  const { url, client } = await startServer(t);
  const solo = client();
  const res = await call(solo, 'room:quickplay', { name: 'Solo', level: 'hard' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.state.phase, 'playing');
  assert.equal(res.state.settings.isPublic, false);
  assert.equal(res.state.members.filter((m) => m.isBot).length, 1);

  const lobby = await (await fetch(`${url}/api/lobby`)).json();
  assert.equal(lobby.rooms.length, 0, 'private rooms are not listed');

  // Whenever it's our turn, play; the bot must answer on its own.
  const view = track(solo, res.state);
  let state = res.state;
  while (state.phase === 'playing') {
    state = await view.until((s) => s.phase === 'over' || s.game.turnPlayerId === res.playerId);
    if (state.phase === 'over') break;
    const line = firstFreeLine(state.game);
    const seen = view.count;
    assert.equal((await call(solo, 'game:move', line)).ok, true);
    state = await view.until(() => view.count > seen); // a bot may bomb our line right away
  }
  assert.equal(state.phase, 'over');
});

test('serves a scan-to-join QR code', async (t) => {
  const { url } = await startServer(t);
  const res = await fetch(`${url}/qr/ABCD.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /svg/);
  assert.match(await res.text(), /<svg/);
  assert.equal((await fetch(`${url}/qr/nope!.svg`)).status, 400);
});

test('home page gets live online counts pushed as devices come and go', async (t) => {
  const { client } = await startServer(t);
  const watcher = client();
  const first = await call(watcher, 'lobby:watch');
  assert.equal(first.ok, true);
  assert.equal(first.stats.online, 1);

  const counts = [];
  watcher.on('lobby', (snap) => counts.push(snap.stats.online));
  const waitForCount = (n) =>
    new Promise((resolve) => {
      const check = () => (counts.at(-1) === n ? resolve() : setTimeout(check, 20));
      check();
    });

  const other = client();
  await waitForCount(2);
  other.close();
  await waitForCount(1);

  // Creating a public room updates the open-rooms list for watchers.
  const host = client();
  const listed = new Promise((resolve) =>
    watcher.on('lobby', (snap) => snap.rooms.length === 1 && resolve(snap))
  );
  const created = await call(host, 'room:create', { name: 'Host' });
  assert.equal((await listed).rooms[0].code, created.code);
});
