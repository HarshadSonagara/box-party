'use strict';

/**
 * Player profiles without accounts.
 *
 * The server assigns each device a profile (XP, credits, stats, goals, shop
 * items) and sends it back with an HMAC signature. The browser keeps that
 * signed copy; on every visit it hands it back and the server verifies it.
 * So progress survives server restarts (even on hosts with no disk), and
 * nobody can edit their own stats — a changed profile fails the signature.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FREE_AVATARS = ['crown', 'gem', 'star', 'moon', 'sun', 'zap', 'flame', 'leaf', 'anchor', 'compass', 'rocket', 'heart', 'spade', 'club', 'key', 'feather'];

const SHOP = [
  { id: 'avatar:ghost', kind: 'avatar', value: 'ghost', name: 'Ghost', price: 150 },
  { id: 'avatar:cat', kind: 'avatar', value: 'cat', name: 'Cat', price: 150 },
  { id: 'avatar:bird', kind: 'avatar', value: 'bird', name: 'Bird', price: 150 },
  { id: 'avatar:flower', kind: 'avatar', value: 'flower', name: 'Bloom', price: 150 },
  { id: 'avatar:swords', kind: 'avatar', value: 'swords', name: 'Duelist', price: 300 },
  { id: 'avatar:skull', kind: 'avatar', value: 'skull', name: 'Skull', price: 300 },
  { id: 'frame:gold', kind: 'frame', value: 'gold', name: 'Gold ring', price: 200 },
  { id: 'frame:ice', kind: 'frame', value: 'ice', name: 'Frost ring', price: 250 },
  { id: 'frame:fire', kind: 'frame', value: 'fire', name: 'Ember ring', price: 300 },
  { id: 'frame:prism', kind: 'frame', value: 'prism', name: 'Prism ring', price: 500 },
];
const SHOP_BY_ID = new Map(SHOP.map((item) => [item.id, item]));
const PREMIUM_AVATARS = SHOP.filter((i) => i.kind === 'avatar').map((i) => i.value);
const FRAMES = ['none', ...SHOP.filter((i) => i.kind === 'frame').map((i) => i.value)];
const ALL_AVATARS = [...FREE_AVATARS, ...PREMIUM_AVATARS];

/** Daily challenges: three of these rotate in each UTC day. `metric` reads one game result. */
const DAILY = [
  { id: 'play3', text: 'Play 3 games', target: 3, reward: 40, metric: () => 1 },
  { id: 'win2', text: 'Win 2 games', target: 2, reward: 60, metric: (r) => (r.won ? 1 : 0) },
  { id: 'boxes15', text: 'Claim 15 boxes', target: 15, reward: 40, metric: (r) => r.boxes },
  { id: 'combo4', text: 'Chain a 4-box combo', target: 1, reward: 50, metric: (r) => (r.bestCombo >= 4 ? 1 : 0) },
  { id: 'powers3', text: 'Use 3 power-ups', target: 3, reward: 40, metric: (r) => r.powers },
  { id: 'stars3', text: 'Capture 3 star boxes', target: 3, reward: 50, metric: (r) => r.stars },
  { id: 'friend1', text: 'Play a game with a friend', target: 1, reward: 60, metric: (r) => (r.humans >= 2 ? 1 : 0) },
  { id: 'hard1', text: 'Beat a Hard bot', target: 1, reward: 80, metric: (r) => (r.won && r.vsHard ? 1 : 0) },
];
const DAILY_BY_ID = new Map(DAILY.map((d) => [d.id, d]));
const DAILY_COUNT = 3;

/** Progressive goals: each claim unlocks a harder level with a bigger reward. */
const TRACKS = [
  { id: 'wins', name: 'Victor', icon: 'trophy', stat: 'wins', steps: [1, 3, 5, 10, 20, 35, 50, 75, 100], reward: 40, text: (n) => `Win ${n} ${n === 1 ? 'game' : 'games'}` },
  { id: 'boxes', name: 'Box Collector', icon: 'grid', stat: 'boxes', steps: [10, 25, 50, 100, 200, 400, 800], reward: 30, text: (n) => `Claim ${n} boxes` },
  { id: 'combos', name: 'Combo Artist', icon: 'flame', stat: 'combos', steps: [1, 3, 6, 10, 20, 35, 50], reward: 40, text: (n) => `Chain ${n} ${n === 1 ? 'combo' : 'combos'} of 3+ boxes` },
  { id: 'powers', name: 'Power Player', icon: 'bomb', stat: 'powers', steps: [3, 10, 25, 50, 100, 200], reward: 35, text: (n) => `Use ${n} power-ups` },
  { id: 'social', name: 'Life of the Party', icon: 'users', stat: 'friendGames', steps: [1, 3, 5, 10, 25, 50], reward: 50, text: (n) => `Play ${n} ${n === 1 ? 'game' : 'games'} with friends` },
];
const TRACK_BY_ID = new Map(TRACKS.map((t) => [t.id, t]));

const TITLES = [
  [20, 'Grandmaster'],
  [15, 'Mastermind'],
  [10, 'Tactician'],
  [5, 'Strategist'],
  [1, 'Rookie'],
];

const STAT_KEYS = ['games', 'wins', 'boxes', 'bestCombo', 'combos', 'powers', 'stars', 'friendGames', 'hardWins', 'streak', 'bestStreak'];
const LEADERBOARD_METRICS = {
  xp: (p) => p.xp,
  wins: (p) => p.stats.wins,
  winRate: (p) => (p.stats.games >= 5 ? Math.round((p.stats.wins / p.stats.games) * 100) : -1),
  bestCombo: (p) => p.stats.bestCombo,
  boxes: (p) => p.stats.boxes,
};

const WELCOME_CREDITS = 50;
const WIN_CREDITS = 10;
const LEVEL_UP_CREDITS = 50;
const MAX_PROFILES = 20_000;
const SAVE_DELAY_MS = 2000;

/** Total XP needed to reach `level` (level 1 = 0, 2 = 100, 3 = 300, 4 = 600 ...). */
function xpForLevel(level) {
  return 50 * level * (level - 1);
}

function levelFor(xp) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

function titleFor(level) {
  return TITLES.find(([min]) => level >= min)[1];
}

function trackTarget(track, level) {
  if (level < track.steps.length) return track.steps[level];
  const last = track.steps[track.steps.length - 1];
  return last * 2 ** (level - track.steps.length + 1);
}

function trackReward(track, level) {
  return track.reward + level * 15;
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** The same three challenges for everyone on a given UTC day. */
function dailyFor(day) {
  let seed = Number(day.replace(/-/g, ''));
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const ids = DAILY.map((d) => d.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, DAILY_COUNT);
}

const int = (v, max = 1e9) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);

function cleanName(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';
}

/** Rebuilds a profile from untrusted data, keeping only known fields with sane values. */
function sanitize(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const owned = Array.isArray(p.owned) ? [...new Set(p.owned.filter((id) => SHOP_BY_ID.has(id)))] : [];
  const avatar = FREE_AVATARS.includes(p.avatar) || owned.includes(`avatar:${p.avatar}`) ? p.avatar : 'crown';
  const frame = p.frame !== 'none' && owned.includes(`frame:${p.frame}`) ? p.frame : 'none';
  const stats = Object.fromEntries(STAT_KEYS.map((k) => [k, int(p.stats?.[k])]));
  const tracks = Object.fromEntries(TRACKS.map((t) => [t.id, int(p.tracks?.[t.id], 1000)]));
  const daily = {
    day: typeof p.daily?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.daily.day) ? p.daily.day : '',
    progress: Object.fromEntries(DAILY.map((d) => [d.id, int(p.daily?.progress?.[d.id], 1000)]).filter(([, v]) => v > 0)),
    claimed: Array.isArray(p.daily?.claimed) ? [...new Set(p.daily.claimed.filter((id) => DAILY_BY_ID.has(id)))] : [],
  };
  return {
    v: 1,
    id: typeof p.id === 'string' && /^[a-f0-9]{24}$/.test(p.id) ? p.id : crypto.randomBytes(12).toString('hex'),
    name: cleanName(p.name),
    avatar,
    frame,
    xp: int(p.xp),
    credits: int(p.credits),
    stats,
    tracks,
    daily,
    owned,
    createdAt: int(p.createdAt, 1e15),
    updatedAt: int(p.updatedAt, 1e15),
  };
}

class ProfileStore {
  /**
   * @param {object} opts
   * @param {string} opts.secret  HMAC key; keep it stable across restarts.
   * @param {string|null} opts.file  JSON file for persistence, or null for memory only.
   */
  constructor({ secret, file = null, now = Date.now } = {}) {
    if (!secret) throw new Error('ProfileStore needs a secret');
    this.secret = secret;
    this.file = file;
    this.now = now;
    this.profiles = new Map();
    this.saveTimer = null;
    this.load();
  }

  // ---------------------------------------------------------------- persistence

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const raw of data.profiles || []) {
        const p = sanitize(raw);
        this.profiles.set(p.id, p);
      }
    } catch (err) {
      console.error('[profiles] could not load, starting fresh', err.message);
    }
  }

  scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  saveNow() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ profiles: [...this.profiles.values()] }));
      fs.renameSync(tmp, this.file); // atomic replace: never a half-written file
    } catch (err) {
      console.error('[profiles] save failed', err.message);
    }
  }

  // ---------------------------------------------------------------- identity

  sign(profile) {
    return crypto.createHmac('sha256', this.secret).update(JSON.stringify(profile)).digest('hex');
  }

  verify(profile, sig) {
    if (typeof sig !== 'string' || !/^[a-f0-9]{64}$/.test(sig) || !profile || typeof profile !== 'object') return false;
    const expected = Buffer.from(this.sign(profile), 'hex');
    return crypto.timingSafeEqual(expected, Buffer.from(sig, 'hex'));
  }

  /** A device says hello with its saved copy. Returns the live profile (restored or brand new). */
  hello(saved) {
    const { profile, sig } = saved && typeof saved === 'object' ? saved : {};
    if (this.verify(profile, sig)) {
      const incoming = sanitize(profile);
      const known = this.profiles.get(incoming.id);
      if (!known || incoming.updatedAt > known.updatedAt) this.put(incoming); // restore after a restart
      return this.profiles.get(incoming.id);
    }
    const t = this.now();
    const fresh = sanitize({ credits: WELCOME_CREDITS, createdAt: t, updatedAt: t });
    this.put(fresh);
    return fresh;
  }

  put(profile) {
    this.profiles.set(profile.id, profile);
    if (this.profiles.size > MAX_PROFILES) this.prune();
    this.scheduleSave();
  }

  /** Drops the least recently active profiles, never-played ones first. */
  prune() {
    const sorted = [...this.profiles.values()].sort(
      (a, b) => (a.stats.games > 0) - (b.stats.games > 0) || a.updatedAt - b.updatedAt
    );
    for (const p of sorted.slice(0, this.profiles.size - MAX_PROFILES)) this.profiles.delete(p.id);
  }

  get(id) {
    return this.profiles.get(id) || null;
  }

  touch(p) {
    p.updatedAt = Math.max(this.now(), p.updatedAt + 1);
    this.scheduleSave();
  }

  /** Name / avatar shown on the leaderboard. Premium avatars must be owned. */
  setIdentity(id, { name, avatar } = {}) {
    const p = this.get(id);
    if (!p) return;
    if (name != null) p.name = cleanName(name);
    if (this.ownsAvatar(id, avatar)) p.avatar = avatar;
    this.touch(p);
  }

  ownsAvatar(id, avatar) {
    if (FREE_AVATARS.includes(avatar)) return true;
    const p = this.get(id);
    return Boolean(p && PREMIUM_AVATARS.includes(avatar) && p.owned.includes(`avatar:${avatar}`));
  }

  // ---------------------------------------------------------------- progress

  ensureDay(p) {
    const today = dayKey(this.now());
    if (p.daily.day !== today) p.daily = { day: today, progress: {}, claimed: [] };
  }

  /**
   * Records one finished game for a player.
   * result: { won, boxes, bestCombo, combos, powers, stars, humans, vsHard }
   * Returns what they earned: { xp, credits, level, levelUp, dailyReady }.
   */
  recordGame(id, result) {
    const p = this.get(id);
    if (!p) return null;
    const r = {
      won: Boolean(result.won),
      boxes: int(result.boxes, 1000),
      bestCombo: int(result.bestCombo, 1000),
      combos: int(result.combos, 1000),
      powers: int(result.powers, 10),
      stars: int(result.stars, 1000),
      humans: int(result.humans, 16),
      vsHard: Boolean(result.vsHard),
    };
    const s = p.stats;
    const levelBefore = levelFor(p.xp);

    s.games++;
    s.boxes += r.boxes;
    s.bestCombo = Math.max(s.bestCombo, r.bestCombo);
    s.combos += r.combos;
    s.powers += r.powers;
    s.stars += r.stars;
    if (r.humans >= 2) s.friendGames++;
    if (r.won) {
      s.wins++;
      s.streak++;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      if (r.vsHard) s.hardWins++;
    } else {
      s.streak = 0;
    }

    // XP: playing, scoring, combos and winning all count; practice vs bots earns half.
    let xp = 20 + r.boxes * 5 + r.bestCombo * 5 + (r.won ? 50 : 0);
    if (r.humans < 2) xp = Math.round(xp / 2);
    p.xp += xp;

    let credits = r.won ? WIN_CREDITS : 0;
    const level = levelFor(p.xp);
    if (level > levelBefore) credits += (level - levelBefore) * LEVEL_UP_CREDITS;
    p.credits += credits;

    this.ensureDay(p);
    const today = dailyFor(p.daily.day);
    for (const goalId of today) {
      const goal = DAILY_BY_ID.get(goalId);
      const before = p.daily.progress[goalId] || 0;
      p.daily.progress[goalId] = Math.min(goal.target, before + goal.metric(r));
    }
    this.touch(p);

    return {
      xp,
      credits,
      level,
      levelUp: level > levelBefore ? level : null,
      claimable: this.claimableCount(p),
    };
  }

  claimableCount(p) {
    this.ensureDay(p);
    const daily = dailyFor(p.daily.day).filter(
      (gid) => !p.daily.claimed.includes(gid) && (p.daily.progress[gid] || 0) >= DAILY_BY_ID.get(gid).target
    ).length;
    const tracks = TRACKS.filter((t) => p.stats[t.stat] >= trackTarget(t, p.tracks[t.id])).length;
    return daily + tracks;
  }

  /** Claims a finished daily challenge or progressive goal. Returns credits earned. */
  claim(id, kind, goalId) {
    const p = this.get(id);
    if (!p) throw new Error('No profile');
    let reward;
    if (kind === 'daily') {
      this.ensureDay(p);
      const goal = DAILY_BY_ID.get(goalId);
      if (!goal || !dailyFor(p.daily.day).includes(goalId)) throw new UserError("That isn't one of today's challenges.");
      if (p.daily.claimed.includes(goalId)) throw new UserError('Already claimed.');
      if ((p.daily.progress[goalId] || 0) < goal.target) throw new UserError('Not finished yet.');
      p.daily.claimed.push(goalId);
      reward = goal.reward;
    } else if (kind === 'track') {
      const track = TRACK_BY_ID.get(goalId);
      if (!track) throw new UserError('Unknown goal.');
      const level = p.tracks[track.id];
      if (p.stats[track.stat] < trackTarget(track, level)) throw new UserError('Not finished yet.');
      reward = trackReward(track, level);
      p.tracks[track.id] = level + 1;
    } else {
      throw new UserError('Unknown goal.');
    }
    p.credits += reward;
    this.touch(p);
    return reward;
  }

  buy(id, itemId) {
    const p = this.get(id);
    const item = SHOP_BY_ID.get(itemId);
    if (!p || !item) throw new UserError('That item is not in the shop.');
    if (p.owned.includes(itemId)) throw new UserError('You already own that.');
    if (p.credits < item.price) throw new UserError(`You need ${item.price - p.credits} more credits.`);
    p.credits -= item.price;
    p.owned.push(itemId);
    this.touch(p);
    return item;
  }

  equip(id, { avatar, frame } = {}) {
    const p = this.get(id);
    if (!p) throw new UserError('No profile.');
    if (avatar !== undefined) {
      if (!this.ownsAvatar(id, avatar)) throw new UserError('Unlock that avatar in the shop first.');
      p.avatar = avatar;
    }
    if (frame !== undefined) {
      if (!FRAMES.includes(frame) || (frame !== 'none' && !p.owned.includes(`frame:${frame}`))) {
        throw new UserError('Unlock that frame in the shop first.');
      }
      p.frame = frame;
    }
    this.touch(p);
  }

  // ---------------------------------------------------------------- views

  /** Rankings by `metric`; `meId` gets their own row even outside the top. */
  leaderboard(metric = 'xp', meId = null, limit = 50) {
    const score = LEADERBOARD_METRICS[metric] || LEADERBOARD_METRICS.xp;
    const ranked = [...this.profiles.values()]
      .filter((p) => p.stats.games > 0 && score(p) >= 0)
      .sort((a, b) => score(b) - score(a) || b.xp - a.xp || a.createdAt - b.createdAt);
    const row = (p, i) => ({
      rank: i + 1,
      name: p.name,
      avatar: p.avatar,
      frame: p.frame,
      level: levelFor(p.xp),
      title: titleFor(levelFor(p.xp)),
      value: score(p),
      games: p.stats.games,
      wins: p.stats.wins,
      me: p.id === meId,
    });
    const top = ranked.slice(0, limit).map(row);
    const myIndex = meId ? ranked.findIndex((p) => p.id === meId) : -1;
    return {
      metric: LEADERBOARD_METRICS[metric] ? metric : 'xp',
      players: ranked.length,
      top,
      me: myIndex >= limit ? row(ranked[myIndex], myIndex) : null,
    };
  }

  rankOf(id) {
    const ranked = [...this.profiles.values()].filter((p) => p.stats.games > 0).sort((a, b) => b.xp - a.xp);
    const i = ranked.findIndex((p) => p.id === id);
    return i === -1 ? null : i + 1;
  }

  /** Everything the client needs: the signed profile plus computed goals, shop and level info. */
  snapshot(id) {
    const p = this.get(id);
    if (!p) return null;
    this.ensureDay(p);
    const level = levelFor(p.xp);
    const msToReset = Date.parse(`${p.daily.day}T00:00:00Z`) + 86_400_000 - this.now();
    return {
      profile: p,
      sig: this.sign(p),
      view: {
        level,
        title: titleFor(level),
        levelXp: p.xp - xpForLevel(level),
        nextLevelXp: xpForLevel(level + 1) - xpForLevel(level),
        rank: this.rankOf(p.id),
        winRate: p.stats.games ? Math.round((p.stats.wins / p.stats.games) * 100) : 0,
        claimable: this.claimableCount(p),
        dailyResetsInMs: Math.max(0, msToReset),
        daily: dailyFor(p.daily.day).map((gid) => {
          const goal = DAILY_BY_ID.get(gid);
          return {
            id: gid,
            text: goal.text,
            target: goal.target,
            progress: Math.min(goal.target, p.daily.progress[gid] || 0),
            reward: goal.reward,
            claimed: p.daily.claimed.includes(gid),
          };
        }),
        tracks: TRACKS.map((t) => {
          const lvl = p.tracks[t.id];
          const target = trackTarget(t, lvl);
          return {
            id: t.id,
            name: t.name,
            icon: t.icon,
            level: lvl + 1,
            text: t.text(target),
            target,
            progress: Math.min(target, p.stats[t.stat]),
            reward: trackReward(t, lvl),
          };
        }),
        shop: SHOP.map((item) => ({
          ...item,
          owned: p.owned.includes(item.id),
          equipped: (item.kind === 'avatar' && p.avatar === item.value) || (item.kind === 'frame' && p.frame === item.value),
        })),
        avatars: { free: FREE_AVATARS, premium: PREMIUM_AVATARS },
      },
    };
  }

  dispose() {
    if (this.saveTimer) this.saveNow();
  }
}

/** An error whose message is safe to show to the player. */
class UserError extends Error {}

module.exports = {
  ProfileStore,
  UserError,
  sanitize,
  levelFor,
  xpForLevel,
  titleFor,
  dailyFor,
  trackTarget,
  FREE_AVATARS,
  PREMIUM_AVATARS,
  ALL_AVATARS,
  FRAMES,
  SHOP,
  DAILY,
  TRACKS,
};
