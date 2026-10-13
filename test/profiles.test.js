'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { ProfileStore, levelFor, xpForLevel, dailyFor, DAILY, TRACKS } = require('../src/profiles');
const { createGameServer } = require('../server');

const SECRET = 'test-secret';
const store = (opts = {}) => new ProfileStore({ secret: SECRET, ...opts });
const win = { won: true, boxes: 6, bestCombo: 3, combos: 1, powers: 2, stars: 1, humans: 2, vsHard: false };

test('levels grow with XP', () => {
  assert.equal(levelFor(0), 1);
  assert.equal(levelFor(99), 1);
  assert.equal(levelFor(100), 2);
  assert.equal(levelFor(300), 3);
  assert.equal(xpForLevel(levelFor(12345) + 1) > 12345, true);
});

test('a new device gets a signed starter profile', () => {
  const s = store();
  const p = s.hello(null);
  assert.match(p.id, /^[a-f0-9]{24}$/);
  assert.equal(p.credits, 50);
  const snap = s.snapshot(p.id);
  assert.equal(s.verify(snap.profile, snap.sig), true);
  assert.equal(snap.view.level, 1);
  assert.equal(snap.view.daily.length, 3);
  assert.equal(snap.view.tracks.length, TRACKS.length);
});

test('edited profiles are rejected — you cannot fake XP or credits', () => {
  const s = store();
  const p = s.hello(null);
  const { profile, sig } = s.snapshot(p.id);
  const forged = JSON.parse(JSON.stringify(profile));
  forged.credits = 999999;
  const back = s.hello({ profile: forged, sig });
  assert.notEqual(back.id, profile.id, 'a forged profile gets a fresh one instead');
  assert.equal(back.credits, 50);
  assert.equal(s.get(profile.id).credits, 50, 'the real profile is untouched');
});

test('progress survives a server restart through the signed copy', () => {
  const before = store();
  const p = before.hello(null);
  before.recordGame(p.id, win);
  const saved = JSON.parse(JSON.stringify(before.snapshot(p.id))); // what the browser keeps

  const after = store(); // new process, empty memory, same secret
  const restored = after.hello({ profile: saved.profile, sig: saved.sig });
  assert.equal(restored.id, p.id);
  assert.equal(restored.stats.wins, 1);
  assert.equal(after.leaderboard('xp').top[0].name, restored.name);

  const otherServer = new ProfileStore({ secret: 'different' });
  assert.notEqual(otherServer.hello(saved).id, p.id, 'a different secret does not trust it');
});

test('a game result gives XP, credits, stats and streaks; practice vs bots earns half XP', () => {
  const s = store();
  const p = s.hello(null);
  const r1 = s.recordGame(p.id, win);
  assert.equal(r1.xp, 20 + 6 * 5 + 3 * 5 + 50);
  assert.equal(r1.credits, 10 + 50, 'win bonus + level-up bonus');
  assert.equal(r1.levelUp, 2);
  s.recordGame(p.id, win);
  const r3 = s.recordGame(p.id, { ...win, won: false, humans: 1 });
  assert.equal(r3.xp, Math.round((20 + 30 + 15) / 2));
  const st = s.get(p.id).stats;
  assert.deepEqual(
    { games: st.games, wins: st.wins, streak: st.streak, bestStreak: st.bestStreak, friendGames: st.friendGames },
    { games: 3, wins: 2, streak: 0, bestStreak: 2, friendGames: 2 }
  );
});

test('daily challenges track progress and can be claimed once', () => {
  let now = Date.parse('2026-10-14T10:00:00Z');
  const s = store({ now: () => now });
  const p = s.hello(null);
  const today = dailyFor('2026-10-14');
  assert.equal(new Set(today).size, 3);
  assert.deepEqual(dailyFor('2026-10-14'), today, 'same for everyone all day');

  // Play enough perfect games to finish every challenge.
  for (let i = 0; i < 20; i++) s.recordGame(p.id, { ...win, bestCombo: 5, powers: 3, stars: 3, vsHard: true });
  const snap = s.snapshot(p.id);
  for (const goal of snap.view.daily) assert.equal(goal.progress, goal.target, goal.text);

  const credits = s.get(p.id).credits;
  const goal = DAILY.find((d) => d.id === today[0]);
  assert.equal(s.claim(p.id, 'daily', today[0]), goal.reward);
  assert.equal(s.get(p.id).credits, credits + goal.reward);
  assert.throws(() => s.claim(p.id, 'daily', today[0]), /Already claimed/);
  const notToday = DAILY.find((d) => !today.includes(d.id)).id;
  assert.throws(() => s.claim(p.id, 'daily', notToday), /today's challenges/);

  now += 86_400_000; // next day: fresh challenges and progress
  assert.equal(s.snapshot(p.id).view.daily.every((g) => g.progress === 0 && !g.claimed), true);
});

test('progressive goals level up after each claim', () => {
  const s = store();
  const p = s.hello(null);
  assert.throws(() => s.claim(p.id, 'track', 'wins'), /Not finished/);
  s.recordGame(p.id, win);
  const reward = s.claim(p.id, 'track', 'wins');
  assert.equal(reward, 40);
  const wins = s.snapshot(p.id).view.tracks.find((t) => t.id === 'wins');
  assert.equal(wins.level, 2);
  assert.equal(wins.target, 3);
  assert.throws(() => s.claim(p.id, 'track', 'nope'), /Unknown goal/);
});

test('the shop sells cosmetics for credits and only owners can equip them', () => {
  const s = store();
  const p = s.hello(null); // 50 credits
  assert.throws(() => s.buy(p.id, 'avatar:ghost'), /need 100 more credits/);
  assert.throws(() => s.equip(p.id, { avatar: 'ghost' }), /Unlock that avatar/);
  assert.throws(() => s.equip(p.id, { frame: 'gold' }), /Unlock that frame/);
  s.get(p.id).credits = 1000;
  s.buy(p.id, 'avatar:ghost');
  s.buy(p.id, 'frame:prism');
  assert.throws(() => s.buy(p.id, 'avatar:ghost'), /already own/);
  assert.throws(() => s.buy(p.id, 'avatar:dragon'), /not in the shop/);
  s.equip(p.id, { avatar: 'ghost', frame: 'prism' });
  const me = s.get(p.id);
  assert.deepEqual([me.avatar, me.frame, me.credits], ['ghost', 'prism', 1000 - 150 - 500]);
  assert.equal(s.ownsAvatar(p.id, 'ghost'), true);
  assert.equal(s.ownsAvatar('someone-else', 'ghost'), false);
});

test('leaderboard ranks by the chosen metric and pins your own row', () => {
  const s = store();
  const ids = [];
  for (let i = 0; i < 60; i++) {
    const p = s.hello(null);
    s.setIdentity(p.id, { name: `P${i}` });
    for (let g = 0; g <= i % 7; g++) s.recordGame(p.id, { ...win, won: g % 2 === 0, boxes: i });
    ids.push(p.id);
  }
  const board = s.leaderboard('xp', ids[0]);
  assert.equal(board.top.length, 50);
  for (let i = 1; i < board.top.length; i++) assert.ok(board.top[i - 1].value >= board.top[i].value);
  assert.equal(board.me.me, true, 'low-ranked player still sees their own rank');
  assert.ok(board.me.rank > 50);
  assert.equal(s.leaderboard('wins').metric, 'wins');
  assert.equal(s.leaderboard('hack').metric, 'xp');
  assert.equal(s.hello(null) && s.leaderboard('xp').players, 60, 'players who never played are not ranked');
});

test('profiles persist to disk and reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxparty-'));
  const file = path.join(dir, 'profiles.json');
  const a = store({ file });
  const p = a.hello(null);
  a.recordGame(p.id, win);
  a.saveNow();
  const b = store({ file });
  assert.equal(b.get(p.id).stats.wins, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('over the network: finishing a game sends each player their rewards', async (t) => {
  const server = createGameServer({ turnSeconds: 0, botDelayMs: 1, profileSecret: SECRET });
  await new Promise((resolve) => server.server.listen(0, resolve));
  const url = `http://localhost:${server.server.address().port}`;
  const socket = connect(url, { transports: ['websocket'], forceNew: true });
  t.after(() => {
    socket.close();
    server.close();
  });
  const call = (event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

  const hello = await call('profile:hello', null);
  assert.equal(hello.ok, true);
  assert.equal((await call('profile:equip', { avatar: 'skull' })).ok, false, 'premium avatar is locked');

  const update = new Promise((resolve) => socket.on('profile:update', resolve));
  let state = (await call('room:quickplay', { name: 'Solo', level: 'easy' })).state;
  socket.on('state', (s) => (state = s));
  const me = state.members.find((m) => !m.isBot).id;
  while (state.phase === 'playing') {
    if (state.game.turnPlayerId === me) {
      const g = state.game;
      const line = ['h', 'v'].flatMap((type) => g[type].flatMap((row, r) => row.map((o, c) => (o === null ? { type, r, c } : null)))).find(Boolean);
      await call('game:move', line);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  const { rewards, profile, sig, view } = await update;
  assert.ok(rewards.xp > 0);
  assert.equal(profile.stats.games, 1);
  assert.equal(view.rank, 1);
  assert.equal(server.profiles.verify(profile, sig), true);

  const board = await call('leaderboard:get', { metric: 'xp' });
  assert.equal(board.top[0].me, true);
  assert.equal(board.top[0].name, 'Solo');
  const api = await (await fetch(`${url}/api/leaderboard`)).json();
  assert.equal(api.top[0].name, 'Solo');
});

test('a new look applies in the lobby or between rounds, never mid-game', () => {
  const { Room } = require('../src/room');
  const room = new Room('LOOK', { turnSeconds: 0 });
  const a = room.join('Ann', undefined, 'moon');
  room.join('Ben');
  assert.equal(room.restyle(a.id, { avatar: 'ghost', frame: 'gold' }), true);
  room.start(a.id);
  assert.equal(room.restyle(a.id, { avatar: 'cat' }), false, 'not while playing');
  assert.equal(room.roster[0].avatar, 'ghost');
  room.leave(room.members[1].id); // game ends
  assert.equal(room.restyle(a.id, { avatar: 'cat', frame: 'prism' }), true, 'fine on the results screen');
  assert.equal(room.publicState().members[0].frame, 'prism');
});
