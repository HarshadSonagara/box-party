'use strict';

const crypto = require('crypto');
const game = require('./game');
const ai = require('./ai');

const MAX_SEATS = 6; // players per round (humans + bots)
const MAX_MEMBERS = 16; // players + spectators
const GRID_SIZES = [3, 4, 5, 6, 7];
const TURN_OPTIONS = [10, 20, 30, 60];
// Jewel tones: distinct from each other and from the gold UI accent.
const COLORS = ['#f0607a', '#5b9bff', '#3fcf98', '#f2a23c', '#a989ff', '#33c3d0'];
const AVATARS = ['crown', 'gem', 'star', 'moon', 'sun', 'zap', 'flame', 'leaf', 'anchor', 'compass', 'rocket', 'heart', 'spade', 'club', 'key', 'feather'];
const BOT_AVATAR = 'bot';
const BOT_NAMES = ['Pixel', 'Byte', 'Turbo', 'Glitch', 'Nova', 'Circuit'];
const POWERS = ['freeze', 'double', 'bomb'];

/** An error whose message is safe to show to the player. */
class GameError extends Error {}

function cleanName(raw) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return name || 'Player';
}

function randomId(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * One game room. The server owns this object; clients only ever see
 * publicState(), which never contains secret reconnect tokens.
 *
 * Phases: 'lobby' -> 'playing' -> 'over' -> ('playing' | 'lobby') ...
 */
class Room {
  constructor(
    code,
    {
      turnSeconds = 30,
      botDelayMs = 900,
      onChange = () => {},
      onFinish = () => {},
      now = Date.now,
      rand = Math.random,
    } = {}
  ) {
    this.code = code;
    this.botDelayMs = botDelayMs;
    this.onChange = onChange; // called after changes nobody asked for (timeouts, bot moves)
    this.onFinish = onFinish;
    this.now = now;
    this.rand = rand;
    this.createdAt = now();

    this.members = [];
    this.hostId = null;
    this.phase = 'lobby';
    this.round = 0;
    this.settings = { gridSize: 4, turnSeconds, stars: false, powers: true, isPublic: true };

    this.board = null;
    this.roster = []; // players in the current round: [{ id, name, color, avatar, isBot }]
    this.turnOrder = []; // ids still playing this round
    this.turnIndex = 0;
    this.turnDeadline = null;
    this.turnStartedAt = 0;
    this.timer = null;
    this.lastMove = null;
    this.combo = 0; // boxes claimed so far in the current turn
    this.stats = {};
    this.winnerIds = [];
    this.awards = [];

    // Power-ups (per round)
    this.powers = {}; // playerId -> { freeze, double, bomb } (true = still available)
    this.frozenId = null; // misses their next turn
    this.doubleArmed = false; // current player's next non-scoring line keeps the turn
    this.eventSeq = 0;
    this.lastPower = null; // { seq, power, by, target?, line? }
    this.lastSkip = null; // { seq, playerId } when a frozen player's turn is skipped
  }

  getMember(id) {
    return this.members.find((m) => m.id === id) || null;
  }

  currentPlayerId() {
    return this.phase === 'playing' ? this.turnOrder[this.turnIndex] ?? null : null;
  }

  humanCount() {
    return this.members.filter((m) => !m.isBot).length;
  }

  // ---------------------------------------------------------------- members

  /** Adds a member, or reconnects one when `token` matches. Returns the member. */
  join(rawName, token, avatar) {
    const existing = token ? this.members.find((m) => m.token === token) : null;
    if (existing) {
      existing.connected = true;
      existing.disconnectedAt = null;
      if (!this.getMember(this.hostId)?.connected) this.hostId = existing.id;
      this.ensureLiveTurn();
      return existing;
    }

    if (this.members.length >= MAX_MEMBERS) throw new GameError('This room is full.');
    const member = this.addMember({
      name: this.uniqueName(cleanName(rawName)),
      avatar: AVATARS.includes(avatar) ? avatar : AVATARS[Math.floor(this.rand() * AVATARS.length)],
      token: randomId(16),
      isBot: false,
      botLevel: null,
    });
    if (!this.hostId) this.hostId = member.id;
    return member;
  }

  addMember(fields) {
    const member = {
      id: randomId(6),
      color: null,
      seated: false,
      connected: true,
      disconnectedAt: null,
      wins: 0,
      ...fields,
    };
    this.members.push(member);
    if (this.phase === 'lobby') this.reseat();
    // Mid-game joiners watch until the next round.
    return member;
  }

  uniqueName(name) {
    const taken = new Set(this.members.map((m) => m.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, 13)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /** Hosts are always humans, preferably online ones. */
  pickHost() {
    const humans = this.members.filter((m) => !m.isBot);
    return (humans.find((m) => m.connected) || humans[0])?.id ?? null;
  }

  disconnect(id) {
    const member = this.getMember(id);
    if (!member) return;
    member.connected = false;
    member.disconnectedAt = this.now();
    if (this.hostId === id) this.hostId = this.pickHost();
    // Their turn is not skipped instantly — a quick refresh shouldn't cost a turn.
    // The turn timer handles it, and later turns skip offline players.
  }

  /** Removes a member for good (they left, or were offline too long). */
  leave(id) {
    const index = this.members.findIndex((m) => m.id === id);
    if (index === -1) return;
    this.members.splice(index, 1);
    if (this.hostId === id) this.hostId = this.pickHost();

    if (this.phase === 'lobby') {
      this.reseat();
    } else if (this.phase === 'playing') {
      const pos = this.turnOrder.indexOf(id);
      if (pos === -1) return;
      const wasTheirTurn = pos === this.turnIndex;
      this.turnOrder.splice(pos, 1);
      if (this.frozenId === id) this.frozenId = null;
      if (this.turnOrder.length < 2 || !this.turnOrder.some((pid) => !this.getMember(pid)?.isBot)) {
        this.finish(); // nobody left to play against, or only bots remain
        return;
      }
      if (pos < this.turnIndex) this.turnIndex--;
      if (wasTheirTurn) {
        this.turnIndex %= this.turnOrder.length;
        this.advanceTurn(0);
      }
    }
  }

  /** Removes humans that have been offline longer than `graceMs`. Returns them. */
  pruneDisconnected(graceMs) {
    const t = this.now();
    const stale = this.members.filter((m) => !m.connected && t - m.disconnectedAt > graceMs);
    for (const m of stale) this.leave(m.id);
    return stale;
  }

  /** Lobby only: the first MAX_SEATS members get a seat and a distinct colour. */
  reseat() {
    const seated = this.members.filter((m, i) => (m.seated = i < MAX_SEATS));
    const used = new Set();
    for (const m of seated) {
      if (m.color && !used.has(m.color)) used.add(m.color);
      else m.color = null;
    }
    for (const m of seated) {
      if (!m.color) {
        m.color = COLORS.find((c) => !used.has(c));
        used.add(m.color);
      }
    }
    for (const m of this.members) if (!m.seated) m.color = null;
  }

  // ---------------------------------------------------------------- host actions

  assertHost(id) {
    if (id !== this.hostId) throw new GameError('Only the host can do that.');
  }

  assertLobby(what) {
    if (this.phase !== 'lobby') throw new GameError(`You can only ${what} in the lobby.`);
  }

  updateSettings(byId, patch = {}) {
    this.assertHost(byId);
    this.assertLobby('change settings');
    const next = { ...this.settings };
    if ('gridSize' in patch) {
      if (!GRID_SIZES.includes(patch.gridSize)) throw new GameError('That board size is not available.');
      next.gridSize = patch.gridSize;
    }
    if ('turnSeconds' in patch) {
      if (!TURN_OPTIONS.includes(patch.turnSeconds)) throw new GameError('That timer is not available.');
      next.turnSeconds = patch.turnSeconds;
    }
    for (const key of ['stars', 'powers', 'isPublic']) {
      if (key in patch) next[key] = Boolean(patch[key]);
    }
    this.settings = next;
  }

  addBot(byId, level = 'medium') {
    this.assertHost(byId);
    this.assertLobby('add bots');
    if (!ai.LEVELS.includes(level)) throw new GameError('Unknown bot level.');
    if (this.members.length >= MAX_MEMBERS) throw new GameError('This room is full.');
    if (this.members.filter((m) => m.seated).length >= MAX_SEATS) {
      throw new GameError(`All ${MAX_SEATS} seats are taken.`);
    }
    const botCount = this.members.filter((m) => m.isBot).length;
    return this.addMember({
      name: this.uniqueName(BOT_NAMES[botCount % BOT_NAMES.length]),
      avatar: BOT_AVATAR,
      token: null,
      isBot: true,
      botLevel: level,
    });
  }

  removeBot(byId, botId) {
    this.assertHost(byId);
    this.assertLobby('remove bots');
    if (!this.getMember(botId)?.isBot) throw new GameError('That player is not a bot.');
    this.leave(botId);
  }

  /** Starts a round from the lobby, or a rematch straight from the results screen. */
  start(byId) {
    this.assertHost(byId);
    if (this.phase === 'playing') throw new GameError('A game is already running.');

    if (this.phase === 'over') this.reseat(); // let spectators in for the rematch
    const players = this.members.filter((m) => m.seated && m.connected);
    if (players.length < 2) {
      throw new GameError('You need at least 2 players — invite a friend or add a bot.');
    }

    const n = this.settings.gridSize;
    const stars = this.settings.stars
      ? game.randomStars(n, Math.max(2, Math.round((n * n) / 6)), this.rand)
      : [];
    this.board = game.createBoard(n, { stars });
    this.roster = players.map(({ id, name, color, avatar, isBot, botLevel }) => ({
      id, name, color, avatar, isBot, botLevel,
    }));
    this.stats = Object.fromEntries(
      players.map((p) => [p.id, { moves: 0, stars: 0, bestCombo: 0, thinkMs: 0, timedMoves: 0, powers: 0 }])
    );
    this.powers = Object.fromEntries(players.map((p) => [p.id, { freeze: true, double: true, bomb: true }]));
    this.frozenId = null;
    this.doubleArmed = false;
    this.lastPower = null;
    this.lastSkip = null;
    this.turnOrder = players.map((p) => p.id);
    this.turnIndex = this.round % players.length; // a different player starts each round
    this.round++;
    this.lastMove = null;
    this.combo = 0;
    this.winnerIds = [];
    this.awards = [];
    this.phase = 'playing';
    this.startTurnTimer();
  }

  backToLobby(byId) {
    this.assertHost(byId);
    if (this.phase !== 'over') throw new GameError('Finish the game first.');
    this.phase = 'lobby';
    this.board = null;
    this.roster = [];
    this.turnOrder = [];
    this.lastMove = null;
    this.winnerIds = [];
    this.awards = [];
    this.reseat();
  }

  // ---------------------------------------------------------------- gameplay

  /** Plays a line for `byId`. Returns the boxes it claimed. */
  move(byId, line) {
    if (this.phase !== 'playing') throw new GameError('The game is not running.');
    if (this.currentPlayerId() !== byId) throw new GameError("It's not your turn.");
    if (!game.isValidLine(this.board, line)) throw new GameError('That line is already taken.');

    const clean = { type: line.type, r: line.r, c: line.c };
    const claimed = game.drawLine(this.board, clean, byId);

    const stats = this.stats[byId];
    stats.moves++;
    if (!this.getMember(byId)?.isBot) {
      stats.thinkMs += this.now() - this.turnStartedAt;
      stats.timedMoves++;
    }
    if (claimed.length > 0) {
      this.combo += claimed.length;
      stats.bestCombo = Math.max(stats.bestCombo, this.combo);
      stats.stars += claimed.filter(({ r, c }) => this.board.stars[r][c]).length;
    }
    this.lastMove = { ...clean, by: byId, claimed, combo: claimed.length > 0 ? this.combo : 0 };

    if (game.isFull(this.board)) this.finish();
    else if (claimed.length > 0) this.startTurnTimer(); // closed a box: go again
    else if (this.doubleArmed) {
      this.doubleArmed = false; // Double power: this line doesn't end the turn
      this.lastMove.doubled = true;
      this.startTurnTimer();
    } else this.advanceTurn(1);
    return claimed;
  }

  /** The next online player after `id` in turn order (never `id` itself). */
  nextPlayerAfter(id) {
    const n = this.turnOrder.length;
    const start = this.turnOrder.indexOf(id);
    for (let i = 1; i < n; i++) {
      const candidate = this.turnOrder[(start + i) % n];
      if (this.getMember(candidate)?.connected) return candidate;
    }
    return null;
  }

  /** Uses a one-time power-up for the current player. Doesn't end their turn. */
  usePower(byId, power, line) {
    if (this.phase !== 'playing') throw new GameError('The game is not running.');
    if (!this.settings.powers) throw new GameError('Power-ups are turned off in this room.');
    if (this.currentPlayerId() !== byId) throw new GameError('You can only use a power on your turn.');
    if (!POWERS.includes(power)) throw new GameError('Unknown power-up.');
    const mine = this.powers[byId];
    if (!mine?.[power]) throw new GameError('You already used that power this game.');

    let target = null;
    let clean = null;
    if (power === 'freeze') {
      if (this.frozenId) throw new GameError('Someone is already frozen.');
      target = this.nextPlayerAfter(byId);
      if (!target) throw new GameError('There is nobody to freeze.');
      this.frozenId = target;
    } else if (power === 'double') {
      if (this.doubleArmed) throw new GameError('Double is already active.');
      this.doubleArmed = true;
    } else {
      if (!game.isBombable(this.board, line)) {
        throw new GameError('Pick a drawn line that is not part of a claimed box.');
      }
      clean = { type: line.type, r: line.r, c: line.c };
      game.eraseLine(this.board, clean);
    }

    mine[power] = false;
    this.stats[byId].powers++;
    this.lastPower = { seq: ++this.eventSeq, power, by: byId, target, line: clean };
  }

  /** Moves the turn `step` places on, then onward past anyone offline. */
  advanceTurn(step) {
    const previous = this.currentPlayerId();
    const n = this.turnOrder.length;
    let next = (this.turnIndex + step) % n;
    for (let i = 0; i < n; i++) {
      const idx = (this.turnIndex + step + i) % n;
      const id = this.turnOrder[idx];
      if (!this.getMember(id)?.connected) continue;
      if (step > 0 && id === this.frozenId && id !== previous) {
        // Freeze power: this player misses one turn.
        this.frozenId = null;
        this.lastSkip = { seq: ++this.eventSeq, playerId: id };
        continue;
      }
      next = idx;
      break;
    }
    this.turnIndex = next;
    if (this.currentPlayerId() !== previous) {
      this.combo = 0;
      this.doubleArmed = false;
    }
    this.startTurnTimer();
  }

  /** After a reconnect, make sure the turn belongs to someone who is online and has a clock. */
  ensureLiveTurn() {
    if (this.phase !== 'playing') return;
    const current = this.getMember(this.currentPlayerId());
    const needsTimer = current?.isBot || this.settings.turnSeconds > 0;
    if (current?.connected && (this.timer || !needsTimer)) return;
    this.advanceTurn(0);
  }

  startTurnTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    this.turnDeadline = null;
    if (this.phase !== 'playing') return;

    const player = this.getMember(this.currentPlayerId());
    if (!player?.connected) return; // nobody online: wait for a reconnect
    const humanOnline = this.turnOrder.some((id) => {
      const m = this.getMember(id);
      return m && !m.isBot && m.connected;
    });
    if (!humanOnline) return; // don't let bots finish the game alone; resume on reconnect
    this.turnStartedAt = this.now();

    if (player.isBot) {
      const delay = this.botDelayMs * (0.7 + this.rand() * 0.8);
      this.timer = this.safeTimeout(() => this.playBot(player.id), delay);
      return;
    }

    if (!this.settings.turnSeconds) return;
    const ms = this.settings.turnSeconds * 1000;
    this.turnDeadline = this.now() + ms;
    this.timer = this.safeTimeout(() => {
      if (this.phase !== 'playing' || this.currentPlayerId() !== player.id) return;
      this.doubleArmed = false; // running out of time forfeits an armed Double
      this.advanceTurn(1);
      this.onChange({ type: 'timeout', playerId: player.id });
    }, ms);
  }

  /** Timers run outside any request; an exception here must never crash the whole server. */
  safeTimeout(fn, ms) {
    const timer = setTimeout(() => {
      try {
        fn();
      } catch (err) {
        console.error(`[room ${this.code}] timer failed`, err);
      }
    }, ms);
    timer.unref?.();
    return timer;
  }

  playBot(id) {
    if (this.phase !== 'playing' || this.currentPlayerId() !== id) return;
    const bot = this.getMember(id);
    if (this.settings.powers) {
      const choice = ai.choosePower(
        this.board,
        bot.botLevel,
        this.powers[id],
        { canFreeze: !this.frozenId && Boolean(this.nextPlayerAfter(id)) },
        this.rand
      );
      try {
        if (choice) this.usePower(id, choice.power, choice.line);
      } catch (err) {
        console.error(`[room ${this.code}] bot power failed`, err); // still make the move
      }
    }
    this.move(id, ai.chooseMove(this.board, bot.botLevel, this.rand));
    this.onChange({ type: 'move', playerId: id });
  }

  finish() {
    clearTimeout(this.timer);
    this.timer = null;
    this.turnDeadline = null;
    this.phase = 'over';

    const scores = game.scores(this.board);
    const best = Math.max(...this.turnOrder.map((id) => scores[id] || 0));
    this.winnerIds = this.turnOrder.filter((id) => (scores[id] || 0) === best);
    for (const id of this.winnerIds) {
      const member = this.getMember(id);
      if (member) member.wins++;
    }
    this.awards = this.computeAwards();
    this.onFinish(this);
  }

  /** Fun end-of-round titles, each given to the single best player for it. */
  computeAwards() {
    const best = (score, minimum) => {
      let winner = null;
      for (const { id } of this.roster) {
        const value = score(this.stats[id], id);
        if (value != null && value > minimum && (!winner || value > winner.value)) {
          winner = { playerId: id, value };
        }
      }
      return winner;
    };

    const awards = [];
    const combo = best((s) => s.bestCombo, 1);
    if (combo) {
      awards.push({ icon: 'flame', title: 'Combo King', playerId: combo.playerId, detail: `${combo.value} boxes in one turn` });
    }
    const fast = best((s) => (s.timedMoves >= 3 ? -s.thinkMs / s.timedMoves : null), -Infinity);
    if (fast) {
      awards.push({ icon: 'zap', title: 'Lightning Hands', playerId: fast.playerId, detail: `${(-fast.value / 1000).toFixed(1)}s per move` });
    }
    const powers = best((s) => s.powers, 1);
    if (powers) {
      awards.push({ icon: 'bomb', title: 'Mastermind', playerId: powers.playerId, detail: `${powers.value} power-ups used` });
    }
    const stars = best((s) => s.stars, 0);
    if (stars) {
      awards.push({ icon: 'star', title: 'Star Hunter', playerId: stars.playerId, detail: `${stars.value} star ${stars.value === 1 ? 'box' : 'boxes'}` });
    }
    return awards;
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------- views

  /** Short listing for the public "open rooms" directory. */
  summary() {
    const host = this.getMember(this.hostId);
    return {
      code: this.code,
      host: host?.name ?? '—',
      hostAvatar: host?.avatar ?? 'crown',
      phase: this.phase,
      players: this.members.filter((m) => m.seated).length,
      maxSeats: MAX_SEATS,
      gridSize: this.settings.gridSize,
      stars: this.settings.stars,
      powers: this.settings.powers,
      turnSeconds: this.settings.turnSeconds,
    };
  }

  publicState() {
    const scores = this.board ? game.scores(this.board) : {};
    const current = this.getMember(this.currentPlayerId());
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      settings: { ...this.settings },
      options: { gridSizes: GRID_SIZES, turnSeconds: TURN_OPTIONS, botLevels: ai.LEVELS },
      maxSeats: MAX_SEATS,
      round: this.round,
      members: this.members.map(({ id, name, avatar, color, seated, connected, wins, isBot, botLevel }) => ({
        id, name, avatar, color, seated, connected, wins, isBot, botLevel,
      })),
      game: this.board && {
        size: this.board.size,
        h: this.board.h,
        v: this.board.v,
        boxes: this.board.boxes,
        stars: this.board.stars,
        players: this.roster.map((p) => ({
          ...p,
          score: scores[p.id] || 0,
          connected: Boolean(this.getMember(p.id)?.connected),
          left: !this.turnOrder.includes(p.id),
          powers: this.settings.powers ? { ...this.powers[p.id] } : null,
        })),
        powersEnabled: this.settings.powers,
        frozenId: this.frozenId,
        doubleArmed: this.doubleArmed,
        lastPower: this.lastPower,
        lastSkip: this.lastSkip,
        turnPlayerId: this.currentPlayerId(),
        turnIsBot: Boolean(current?.isBot),
        turnSeconds: this.settings.turnSeconds,
        turnEndsInMs: this.turnDeadline ? Math.max(0, this.turnDeadline - this.now()) : null,
        lastMove: this.lastMove,
        winnerIds: this.winnerIds,
        awards: this.awards,
      },
    };
  }
}

module.exports = {
  Room,
  GameError,
  cleanName,
  MAX_SEATS,
  MAX_MEMBERS,
  GRID_SIZES,
  TURN_OPTIONS,
  COLORS,
  AVATARS,
  POWERS,
};
