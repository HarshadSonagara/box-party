'use strict';

const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { Room, GameError } = require('./src/room');
const { ProfileStore, UserError } = require('./src/profiles');
const game = require('./src/game');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O — easy to read aloud
const CODE_LENGTH = 4;
const CODE_PATTERN = /^[A-Z]{4}$/;
const OFFLINE_GRACE_MS = 2 * 60 * 1000; // offline players are removed after this
const SWEEP_INTERVAL_MS = 10 * 1000;
const REACTIONS = ['👏', '😂', '😱', '🔥', '😭', '🤯', '👀', '💀'];
const REACTION_COOLDOWN_MS = 600;
const DIRECTORY_LIMIT = 12;
const LOBBY_CHANNEL = 'lobby';
const LOBBY_PUSH_DELAY_MS = 250;
const MAX_ROOMS = 2000; // protects memory and the 4-letter code space

/** Token bucket: allows `rate` events per second with bursts up to `burst`. */
function rateLimiter(rate, burst) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/** Security headers. Embedding in other sites (e.g. a showcase page) is intentionally allowed. */
function securityHeaders(req, res, next) {
  const host = req.get('host');
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data:",
      `connect-src 'self' ws://${host} wss://${host}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
}

function createGameServer({
  turnSeconds = 30,
  botDelayMs = 900,
  offlineGraceMs = OFFLINE_GRACE_MS,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  eventRate = 15, // socket events per second, per connection
  eventBurst = 40,
  profileSecret = crypto.randomBytes(32).toString('hex'), // pass a stable one in production
  profilesFile = null, // JSON file for profiles, or null to keep them in memory
} = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 10_000 });
  const rooms = new Map();
  const profiles = new ProfileStore({ secret: profileSecret, file: profilesFile });
  let gamesPlayed = 0;

  app.disable('x-powered-by');
  app.set('trust proxy', true); // correct https:// links behind Render/Railway proxies
  app.use(securityHeaders);

  app.get('/healthz', (req, res) =>
    res.json({ ok: true, rooms: rooms.size, online: io.of('/').sockets.size, uptime: Math.round(process.uptime()) })
  );

  /** Live numbers + public rooms for the home page. `online` = connected browser tabs. */
  function lobbySnapshot() {
    const all = [...rooms.values()];
    const listed = all
      .filter((r) => r.settings.isPublic && r.phase !== 'over' && r.members.some((m) => !m.isBot && m.connected))
      .sort((a, b) => (b.phase === 'lobby') - (a.phase === 'lobby') || b.createdAt - a.createdAt) // joinable first, newest first
      .slice(0, DIRECTORY_LIMIT)
      .map((r) => r.summary());
    return {
      stats: {
        online: io.of('/').sockets.size,
        liveGames: all.filter((r) => r.phase === 'playing').length,
        rooms: all.length,
        gamesPlayed,
      },
      rooms: listed,
    };
  }

  // Home-page viewers sit in this channel and get pushed a fresh snapshot
  // whenever someone connects, leaves, or any room changes (batched).
  let lobbyPush = null;
  function pushLobby() {
    if (lobbyPush) return;
    lobbyPush = setTimeout(() => {
      lobbyPush = null;
      io.to(LOBBY_CHANNEL).emit('lobby', lobbySnapshot());
    }, LOBBY_PUSH_DELAY_MS);
    lobbyPush.unref?.();
  }

  app.get('/api/lobby', (req, res) => res.set('Cache-Control', 'no-store').json(lobbySnapshot()));
  app.get('/api/leaderboard', (req, res) =>
    res.set('Cache-Control', 'no-store').json(profiles.leaderboard(String(req.query.metric || 'xp'), null, 20))
  );

  // Scan-to-join QR code for a room.
  app.get('/qr/:code.svg', async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    if (!CODE_PATTERN.test(code)) return res.status(400).end();
    try {
      const url = `${req.protocol}://${req.get('host')}/?room=${code}`;
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0b0b0f', light: '#ffffff' },
      });
      res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
    } catch (err) {
      console.error('[qr]', err);
      res.status(500).end();
    }
  });

  app.use(express.static(path.join(__dirname, 'public')));
  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  const broadcast = (room) => {
    io.to(room.code).emit('state', room.publicState());
    pushLobby();
  };
  const notice = (room, text) => io.to(room.code).emit('notice', text);

  function newCode() {
    let code;
    do {
      code = Array.from({ length: CODE_LENGTH }, () =>
        CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
      ).join('');
    } while (rooms.has(code));
    return code;
  }

  function createRoom() {
    if (rooms.size >= MAX_ROOMS) throw new GameError('The server is very busy right now — please try again in a minute.');
    const room = new Room(newCode(), {
      turnSeconds,
      botDelayMs,
      onChange(event) {
        if (event.type === 'timeout') {
          const name = room.roster.find((p) => p.id === event.playerId)?.name;
          if (name) notice(room, `${name} ran out of time — turn skipped`);
        }
        broadcast(room);
      },
      onFinish() {
        gamesPlayed++;
        rewardPlayers(room);
      },
    });
    rooms.set(room.code, room);
    return room;
  }

  /** Turns a finished game into XP, credits and goal progress for every human who played it. */
  function rewardPlayers(room) {
    const scores = game.scores(room.board);
    const humans = room.roster.filter((p) => !p.isBot).length;
    const vsHard = room.roster.some((p) => p.isBot && p.botLevel === 'hard');
    for (const player of room.roster) {
      const member = room.getMember(player.id);
      if (player.isBot || !member?.profileId || !room.turnOrder.includes(player.id)) continue;
      const stats = room.stats[player.id];
      const rewards = profiles.recordGame(member.profileId, {
        won: room.winnerIds.includes(player.id),
        boxes: scores[player.id] || 0,
        bestCombo: stats.bestCombo,
        combos: stats.combos,
        powers: stats.powers,
        stars: stats.stars,
        humans,
        vsHard,
      });
      if (rewards && member.socketId) {
        io.to(member.socketId).emit('profile:update', { ...profiles.snapshot(member.profileId), rewards });
      }
    }
  }

  function deleteRoom(room) {
    room.dispose();
    rooms.delete(room.code);
    pushLobby();
  }

  io.on('connection', (socket) => {
    pushLobby(); // someone came online
    const allow = rateLimiter(eventRate, eventBurst);

    /** Registers a handler whose result (or GameError) is sent back through the ack. */
    const on = (event, handler) =>
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (!allow()) return reply({ ok: false, error: 'Slow down a little!' });
        try {
          const data = payload && typeof payload === 'object' ? payload : {};
          reply({ ok: true, ...handler(data) });
        } catch (err) {
          const safe = err instanceof GameError || err instanceof UserError;
          if (!safe) console.error(`[${event}]`, err);
          reply({ ok: false, error: safe ? err.message : 'Something went wrong.' });
        }
      });

    function currentRoom() {
      const room = rooms.get(socket.data.roomCode);
      if (!room || !room.getMember(socket.data.playerId)) {
        throw new GameError('You are not in a room.');
      }
      return room;
    }

    /** Runs a room action for the current player, then syncs everyone. */
    function act(fn) {
      const room = currentRoom();
      const result = fn(room, socket.data.playerId);
      broadcast(room);
      return result || {};
    }

    function leaveCurrentRoom() {
      const room = rooms.get(socket.data.roomCode);
      const member = room?.getMember(socket.data.playerId);
      socket.data.roomCode = null;
      socket.data.playerId = null;
      if (!room) return;
      socket.leave(room.code);
      if (!member) return;
      room.leave(member.id);
      if (room.humanCount() === 0) return deleteRoom(room);
      notice(room, `${member.name} left`);
      broadcast(room);
    }

    function enter(room, { name, token, avatar }) {
      // Already in this room (e.g. a double-tapped Join): stay put instead of leaving and rejoining.
      const current = socket.data.roomCode === room.code && room.getMember(socket.data.playerId);
      if (current) return current;
      const isNew = !token || !room.members.some((m) => m.token === token);
      // A saved seat that no longer exists (expired, or the code now belongs to a new room):
      // never silently drop the player into someone else's game.
      if (token && isNew) throw new GameError('Your previous game has ended. Join again with the room code.');
      if (socket.data.roomCode) leaveCurrentRoom();
      const profileId = socket.data.profileId;
      // Premium avatars only for players who unlocked them.
      const allowedAvatar = profiles.ownsAvatar(profileId, avatar) ? avatar : undefined;
      const member = room.join(name, token, allowedAvatar);
      if (isNew && profileId) {
        member.profileId = profileId;
        member.frame = profiles.get(profileId)?.frame || 'none';
        profiles.setIdentity(profileId, { name, avatar: allowedAvatar });
      }

      // Same player opened the game in another tab: the newest tab wins.
      const old = member.socketId && io.sockets.sockets.get(member.socketId);
      if (old && old.id !== socket.id) {
        old.data.roomCode = null;
        old.data.playerId = null;
        old.leave(room.code);
        old.emit('session:replaced');
      }

      member.socketId = socket.id;
      socket.data.roomCode = room.code;
      socket.data.playerId = member.id;
      socket.join(room.code);
      // Tell everyone else (not the joiner) that someone arrived.
      if (isNew && room.humanCount() > 1) socket.to(room.code).emit('notice', `${member.name} joined`);
      return member;
    }

    const joined = (room, member) => {
      broadcast(room);
      return { code: room.code, playerId: member.id, token: member.token, state: room.publicState() };
    };

    on('room:create', ({ name, avatar }) => {
      const room = createRoom();
      return joined(room, enter(room, { name, avatar }));
    });

    // One tap to play: a private room against a bot, already started.
    on('room:quickplay', ({ name, avatar, level }) => {
      const room = createRoom();
      const member = enter(room, { name, avatar });
      room.updateSettings(member.id, { isPublic: false });
      room.addBot(member.id, level || 'medium');
      room.start(member.id);
      return joined(room, member);
    });

    on('room:join', ({ code, name, token, avatar }) => {
      const room = rooms.get(String(code ?? '').trim().toUpperCase());
      if (!room) throw new GameError('No room with that code. Check it and try again.');
      const member = enter(room, { name, avatar, token: typeof token === 'string' ? token : undefined });
      return joined(room, member);
    });

    on('room:leave', () => {
      leaveCurrentRoom();
      return {};
    });

    on('room:settings', (patch) => act((room, id) => room.updateSettings(id, patch)));
    on('room:addBot', ({ level }) => act((room, id) => void room.addBot(id, level)));
    on('room:removeBot', ({ botId }) => act((room, id) => room.removeBot(id, botId)));
    on('game:start', () => act((room, id) => room.start(id)));
    on('game:lobby', () => act((room, id) => room.backToLobby(id)));
    on('game:move', ({ type, r, c }) =>
      act((room, id) => ({ claimed: room.move(id, { type, r, c }).length }))
    );
    on('game:power', ({ power, line }) =>
      act((room, id) => room.usePower(id, power, line && { type: line.type, r: line.r, c: line.c }))
    );

    on('room:react', ({ emoji }) => {
      const room = currentRoom();
      if (!REACTIONS.includes(emoji)) throw new GameError('Unknown reaction.');
      const now = Date.now();
      if (now - (socket.data.lastReactAt || 0) < REACTION_COOLDOWN_MS) return { throttled: true };
      socket.data.lastReactAt = now;
      io.to(room.code).emit('reaction', { by: socket.data.playerId, emoji });
      return {};
    });

    // ---------------------------------------------------------------- profiles

    function myProfileId() {
      if (!socket.data.profileId || !profiles.get(socket.data.profileId)) {
        throw new GameError('Your profile is still loading — try again in a moment.');
      }
      return socket.data.profileId;
    }

    /** A device says hello with its signed profile (or nothing, the first time). */
    on('profile:hello', (saved) => {
      const profile = profiles.hello(saved);
      socket.data.profileId = profile.id;
      return profiles.snapshot(profile.id);
    });

    on('profile:get', () => profiles.snapshot(myProfileId()));

    on('profile:claim', ({ kind, id }) => {
      const pid = myProfileId();
      const reward = profiles.claim(pid, kind, id);
      return { reward, ...profiles.snapshot(pid) };
    });

    on('profile:buy', ({ itemId }) => {
      const pid = myProfileId();
      const item = profiles.buy(pid, itemId);
      return { item: item.name, ...profiles.snapshot(pid) };
    });

    on('profile:equip', ({ avatar, frame }) => {
      const pid = myProfileId();
      profiles.equip(pid, { avatar, frame });
      // Show the new look straight away if they're waiting in a lobby.
      const room = rooms.get(socket.data.roomCode);
      const p = profiles.get(pid);
      if (room?.restyle(socket.data.playerId, { avatar: p.avatar, frame: p.frame })) broadcast(room);
      return profiles.snapshot(pid);
    });

    on('leaderboard:get', ({ metric }) => profiles.leaderboard(String(metric || 'xp'), socket.data.profileId));

    // Home page subscribes to live stats + open rooms; the ack carries the first snapshot.
    on('lobby:watch', () => {
      socket.join(LOBBY_CHANNEL);
      return lobbySnapshot();
    });
    on('lobby:unwatch', () => {
      socket.leave(LOBBY_CHANNEL);
      return {};
    });

    socket.on('disconnect', () => {
      pushLobby(); // someone went offline
      const room = rooms.get(socket.data.roomCode);
      const member = room?.getMember(socket.data.playerId);
      if (!member || member.socketId !== socket.id) return;
      room.disconnect(member.id);
      broadcast(room);
    });
  });

  // Drop players who have been offline too long, and rooms with no humans left.
  const sweeper = setInterval(() => {
    for (const room of rooms.values()) {
      const removed = room.pruneDisconnected(offlineGraceMs);
      if (room.humanCount() === 0) {
        deleteRoom(room);
      } else if (removed.length > 0) {
        for (const m of removed) notice(room, `${m.name} left`);
        broadcast(room);
      }
    }
  }, sweepIntervalMs);
  sweeper.unref();

  function close() {
    clearInterval(sweeper);
    clearTimeout(lobbyPush);
    profiles.dispose();
    for (const room of rooms.values()) room.dispose();
    io.close();
    server.close();
  }

  return { app, server, io, rooms, profiles, close };
}

/** Profile signatures must survive restarts: keep the key in the data folder if no env var is set. */
function loadOrCreateSecret(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  try {
    return require('fs').readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    try {
      require('fs').mkdirSync(dataDir, { recursive: true });
      require('fs').writeFileSync(file, secret, { mode: 0o600 });
    } catch (err) {
      console.warn('[profiles] could not save secret.key — set PROFILE_SECRET in production', err.message);
    }
    return secret;
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const server = createGameServer({
    profileSecret: process.env.PROFILE_SECRET || loadOrCreateSecret(dataDir),
    profilesFile: path.join(dataDir, 'profiles.json'),
  });
  server.server.listen(port, () => {
    console.log(`Box Party running at http://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  on your Wi-Fi:   http://${ip}:${port}`);
  });

  // Hosts like Render send SIGTERM on redeploy: tell players, then close cleanly.
  // Clients reconnect automatically and rejoin with their saved token.
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal} received — shutting down`);
      server.io.emit('notice', 'Server is restarting — reconnecting you automatically…');
      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 500).unref();
    });
  }
  process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
}

module.exports = { createGameServer, REACTIONS };
