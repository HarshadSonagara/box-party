/* Box Party client. The server is the source of truth: this file renders the
 * latest `state` it receives and sends player intents (create, join, move…). */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SESSION_KEY = 'boxparty.session'; // per tab, so two tabs = two players
  const NAME_KEY = 'boxparty.name';
  const AVATAR_KEY = 'boxparty.avatar';
  const LEVEL_KEY = 'boxparty.level';
  const SOUND_KEY = 'boxparty.sound';
  const SPACING = 100; // svg units between dots
  const PAD = 26;
  const GREY = '#66635c';
  const AVATARS = ['crown', 'gem', 'star', 'moon', 'sun', 'zap', 'flame', 'leaf', 'anchor', 'compass', 'rocket', 'heart', 'spade', 'club', 'key', 'feather'];
  const ICONS = new Set([...AVATARS, 'bot']);
  const REACTIONS = ['👏', '😂', '😱', '🔥', '😭', '🤯', '👀', '💀'];
  const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const socket = io();

  let session = loadSession(); // { code, token, playerId }
  let state = null;
  let currentView = null;
  let turnEndsAt = null; // local timestamp for the current turn deadline
  let seenMoveKey = null;
  let prevTurnPlayerId = null;
  let prevPhase = null;
  let seenPowerSeq = null;
  let seenSkipSeq = null;
  let bombMode = false; // choosing a line to erase with the Bomb power
  let avatar = AVATARS.includes(localStorage.getItem(AVATAR_KEY))
    ? localStorage.getItem(AVATAR_KEY)
    : AVATARS[Math.floor(Math.random() * AVATARS.length)];
  let level = LEVEL_LABEL[localStorage.getItem(LEVEL_KEY)] ? localStorage.getItem(LEVEL_KEY) : 'medium';

  // ------------------------------------------------------------------ helpers

  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY));
    } catch {
      return null;
    }
  }

  function saveSession(next) {
    session = next;
    if (next) sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(SESSION_KEY);
  }

  /** Emits with an ack and resolves to the server's reply ({ ok, error?, ... }). */
  function request(event, payload = {}) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, payload, (err, res) =>
        resolve(err ? { ok: false, timeout: true, error: 'Connection problem — please try again.' } : res)
      );
    });
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('--')) node.style.setProperty(k, v);
      else if (k.startsWith('aria-') || k === 'role') node.setAttribute(k, v);
      else node[k] = v;
    }
    for (const child of [].concat(children)) {
      if (child != null && child !== false) node.append(child);
    }
    return node;
  }

  function svg(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent?.append(node);
    return node;
  }

  /** An icon from the sprite in index.html. */
  function icon(name, className = 'icon') {
    const node = document.createElementNS(SVG_NS, 'svg');
    node.setAttribute('class', className);
    node.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    node.append(use);
    return node;
  }

  /** A player's avatar: their icon in their colour inside a round badge. */
  function avatarBadge(name, color, size = '') {
    return el('span', { className: `avatar ${size}`.trim(), '--c': color || GREY }, icon(ICONS.has(name) ? name : 'crown'));
  }

  function toast(text, isError = false) {
    const node = el('div', { className: `toast${isError ? ' error' : ''}`, textContent: text });
    $('toasts').append(node);
    setTimeout(() => node.remove(), 3200);
  }

  function showView(name) {
    if (name === currentView) return;
    currentView = name;
    window.scrollTo(0, 0);
    for (const view of ['home', 'loading', 'lobby', 'game']) {
      $(`${view}View`).hidden = view !== name;
    }
    $('roomBadge').hidden = !(name === 'lobby' || name === 'game');
    $('onlinePill').hidden = name !== 'home' || $('onlineCount').textContent === '0';
    watchLobby(name === 'home');
  }

  function setUrlRoom(code) {
    const url = code ? `/?room=${code}` : '/';
    if (location.pathname + location.search !== url) history.replaceState(null, '', url);
  }

  const isHost = () => state && session && state.hostId === session.playerId;
  const playerById = (id) =>
    state?.game?.players.find((p) => p.id === id) || state?.members.find((m) => m.id === id) || null;
  const colorOf = (id) => playerById(id)?.color || GREY;

  /** Radio-style segmented control. */
  function segmented(container, options, selected, onPick, disabled = false) {
    container.replaceChildren(
      ...options.map(({ value, label, hint }) => {
        const btn = el('button', { type: 'button', disabled, role: 'radio', 'aria-checked': String(value === selected) }, [
          label,
          hint ? el('small', { textContent: hint }) : null,
        ]);
        btn.addEventListener('click', () => onPick(value));
        return btn;
      })
    );
  }

  // ------------------------------------------------------------------ sound

  const sound = (() => {
    let ctx = null;
    let enabled = localStorage.getItem(SOUND_KEY) !== 'off';

    function unlock() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    }

    function tone(freq, at, duration, gain = 0.07, type = 'sine') {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const t = ctx.currentTime + at;
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(gain, t + 0.01);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(amp).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    }

    const songs = {
      line: () => tone(420, 0, 0.08, 0.05, 'triangle'),
      claim: () => { tone(660, 0, 0.12); tone(990, 0.08, 0.18); },
      combo: () => [660, 880, 1100, 1320].forEach((f, i) => tone(f, i * 0.06, 0.16, 0.06, 'square')),
      turn: () => { tone(523, 0, 0.12); tone(784, 0.1, 0.2); },
      react: () => tone(880, 0, 0.06, 0.04, 'triangle'),
      win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.11, 0.32, 0.08)),
      end: () => { tone(392, 0, 0.2); tone(330, 0.15, 0.3); },
      bomb: () => { tone(140, 0, 0.45, 0.14, 'sawtooth'); tone(70, 0.05, 0.6, 0.12, 'square'); },
      freeze: () => [1568, 2093, 2637, 3136].forEach((f, i) => tone(f, i * 0.05, 0.25, 0.035)),
      double: () => { tone(700, 0, 0.1, 0.06, 'triangle'); tone(1050, 0.12, 0.16, 0.06, 'triangle'); },
    };

    return {
      unlock,
      play(name) {
        if (!enabled || !ctx || ctx.state !== 'running') return;
        songs[name]?.();
      },
      toggle() {
        enabled = !enabled;
        localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off');
        return enabled;
      },
      get enabled() {
        return enabled;
      },
    };
  })();

  document.addEventListener('pointerdown', () => sound.unlock(), { once: true });

  // ------------------------------------------------------------------ confetti

  const confetti = (() => {
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    const LIFETIME_MS = 4000;
    let parts = [];
    let frame = null;
    let startedAt = 0;

    function clear() {
      parts = [];
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function loop() {
      // Browsers pause animation frames in background tabs; never resume a stale burst.
      if (performance.now() - startedAt > LIFETIME_MS) return clear();
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.vy += 0.32;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x * dpr, p.y * dpr);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect((-p.size / 2) * dpr, (-p.size / 4) * dpr, p.size * dpr, (p.size / 2) * dpr);
        ctx.restore();
      }
      parts = parts.filter((p) => p.y < window.innerHeight + 30);
      frame = parts.length ? requestAnimationFrame(loop) : null;
      if (!frame) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    return {
      clear,
      burst(colors, count = 180) {
        if (reducedMotion || document.hidden) return;
        startedAt = performance.now();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = window.innerWidth * dpr;
        canvas.height = window.innerHeight * dpr;
        for (let i = 0; i < count; i++) {
          parts.push({
            x: window.innerWidth / 2 + (Math.random() - 0.5) * 240,
            y: window.innerHeight * 0.3,
            vx: (Math.random() - 0.5) * 18,
            vy: -Math.random() * 15 - 5,
            size: 7 + Math.random() * 7,
            rot: Math.random() * Math.PI,
            vr: (Math.random() - 0.5) * 0.4,
            color: colors[i % colors.length],
          });
        }
        if (!frame) frame = requestAnimationFrame(loop);
      },
    };
  })();

  // ------------------------------------------------------------------ board rendering (game + demo)

  /** Endpoints of a line in svg coordinates. */
  function lineEnds({ type, r, c }) {
    const x = PAD + c * SPACING;
    const y = PAD + r * SPACING;
    return type === 'h' ? [x, y, x + SPACING, y] : [x, y, x, y + SPACING];
  }

  /** The (up to two) boxes on either side of a line. */
  function boxesBeside(size, { type, r, c }) {
    const out = [];
    if (type === 'h') {
      if (r > 0) out.push([r - 1, c]);
      if (r < size) out.push([r, c]);
    } else {
      if (c > 0) out.push([r, c - 1]);
      if (c < size) out.push([r, c]);
    }
    return out;
  }

  /** Mirrors the server rule: a drawn line that isn't a side of any claimed box. */
  function isBombable(view, line) {
    return view[line.type][line.r][line.c] !== null && boxesBeside(view.size, line).every(([r, c]) => view.boxes[r][c] === null);
  }

  /**
   * Draws a board into `target`.
   * view: { size, h, v, boxes, stars, players: [{ id, color, avatar, name }], lastMove }
   */
  function renderBoard(target, view, { animate = false, previewColor, bombTargets = false } = {}) {
    const extent = view.size * SPACING + PAD * 2;
    const find = (id) => view.players.find((p) => p.id === id);
    const color = (id) => find(id)?.color || GREY;
    target.setAttribute('viewBox', `0 0 ${extent} ${extent}`);
    target.replaceChildren();

    const last = view.lastMove;
    const fresh = new Set(animate && last ? last.claimed.map(({ r, c }) => `${r},${c}`) : []);

    view.boxes.forEach((row, r) =>
      row.forEach((owner, c) => {
        const x = PAD + c * SPACING;
        const y = PAD + r * SPACING;
        const star = view.stars?.[r][c];
        if (owner === null) {
          if (star) {
            svg('rect', { class: 'box star-empty', x: x + 10, y: y + 10, width: SPACING - 20, height: SPACING - 20, rx: 12 }, target);
            svg('use', { href: '#i-star', class: 'star-mark', x: x + 34, y: y + 34, width: 32, height: 32 }, target);
          }
          return;
        }
        const isFresh = fresh.has(`${r},${c}`);
        svg('rect', {
          class: `box${isFresh ? ' fresh' : ''}`,
          x: x + 5, y: y + 5, width: SPACING - 10, height: SPACING - 10, rx: 12, fill: color(owner),
        }, target);
        const avatarName = find(owner)?.avatar;
        svg('use', {
          href: `#i-${ICONS.has(avatarName) ? avatarName : 'crown'}`,
          class: `box-icon${isFresh ? ' pop-in' : ''}`,
          x: x + 30, y: y + 30, width: 40, height: 40, stroke: color(owner),
        }, target);
        if (star) svg('use', { href: '#i-star', class: 'star-mark claimed', x: x + SPACING - 28, y: y + 10, width: 18, height: 18 }, target);
      })
    );

    for (const type of ['h', 'v']) {
      view[type].forEach((row, r) =>
        row.forEach((owner, c) => {
          const [x1, y1, x2, y2] = lineEnds({ type, r, c });
          const isLast = animate && last && last.type === type && last.r === r && last.c === c;
          const bombable = bombTargets && owner !== null && isBombable(view, { type, r, c });
          svg('line', {
            class: `edge ${owner === null ? 'free' : 'taken'}${isLast ? ' last' : ''}${bombable ? ' bombable' : ''}`,
            x1, y1, x2, y2,
            ...(owner !== null && { stroke: color(owner), color: color(owner) }),
          }, target);
        })
      );
    }

    if (previewColor) {
      svg('line', { class: 'preview', id: `${target.id}-preview`, stroke: previewColor, visibility: 'hidden' }, target);
    }

    for (let r = 0; r <= view.size; r++) {
      for (let c = 0; c <= view.size; c++) {
        svg('circle', { class: 'dot', cx: PAD + c * SPACING, cy: PAD + r * SPACING, r: 8 }, target);
      }
    }
  }

  // ------------------------------------------------------------------ live demo on the home page

  const demo = (() => {
    const players = [
      { id: 'a', name: 'Ruby', avatar: 'flame', color: '#f0607a' },
      { id: 'b', name: 'Sapphire', avatar: 'moon', color: '#5b9bff' },
    ];
    let view;
    let turn = 0;

    const grid = (rows, cols, fill = null) => Array.from({ length: rows }, () => Array(cols).fill(fill));
    const sides = (r, c) =>
      (view.h[r][c] !== null) + (view.h[r + 1][c] !== null) + (view.v[r][c] !== null) + (view.v[r][c + 1] !== null);
    const adjacent = ({ type, r, c }) => {
      const out = [];
      if (type === 'h') { if (r > 0) out.push([r - 1, c]); if (r < view.size) out.push([r, c]); }
      else { if (c > 0) out.push([r, c - 1]); if (c < view.size) out.push([r, c]); }
      return out;
    };
    const free = () =>
      ['h', 'v'].flatMap((type) => view[type].flatMap((row, r) => row.flatMap((o, c) => (o === null ? [{ type, r, c }] : []))));

    function reset() {
      const size = 4;
      view = {
        size, h: grid(size + 1, size), v: grid(size, size + 1), boxes: grid(size, size),
        stars: grid(size, size, false), players, lastMove: null,
      };
      view.stars[1][2] = true;
      view.stars[3][0] = true;
      turn = 0;
    }

    function step() {
      const lines = free();
      if (lines.length === 0) return reset();
      const pick = (list) => list[Math.floor(Math.random() * list.length)];
      const captures = lines.filter((l) => adjacent(l).some(([r, c]) => sides(r, c) === 3));
      const safe = lines.filter((l) => !adjacent(l).some(([r, c]) => sides(r, c) === 2));
      const line = captures.length ? pick(captures) : safe.length && Math.random() < 0.85 ? pick(safe) : pick(lines);
      const id = players[turn].id;
      view[line.type][line.r][line.c] = id;
      const claimed = adjacent(line).filter(([r, c]) => sides(r, c) === 4 && view.boxes[r][c] === null);
      for (const [r, c] of claimed) view.boxes[r][c] = id;
      view.lastMove = { ...line, claimed: claimed.map(([r, c]) => ({ r, c })) };
      if (claimed.length === 0) turn = 1 - turn;
    }

    function score(id) {
      let total = 0;
      view.boxes.forEach((row, r) => row.forEach((o, c) => { if (o === id) total += view.stars[r][c] ? 2 : 1; }));
      return total;
    }

    function tick() {
      if (currentView === 'home' && !document.hidden) {
        step();
        renderBoard($('demoBoard'), view, { animate: true });
        $('demoScore').replaceChildren(
          ...players.map((p) => el('span', { className: 'demo-player', style: { color: p.color } }, [icon(p.avatar), String(score(p.id))]))
        );
      }
      const pause = free().length === 0 ? 2600 : 700;
      setTimeout(tick, pause);
    }

    reset();
    return { start: tick };
  })();

  // ------------------------------------------------------------------ home: directory & profile

  /** Home page: subscribe to live stats + open rooms (pushed by the server, no polling). */
  let watchingLobby = false;
  async function watchLobby(on) {
    if (on === watchingLobby || !socket.connected) return;
    watchingLobby = on;
    const res = await request(on ? 'lobby:watch' : 'lobby:unwatch');
    if (on && res.ok) renderDirectory(res);
  }

  function renderDirectory({ stats, rooms }) {
    $('statOnline').textContent = stats.online;
    $('statLive').textContent = stats.liveGames;
    $('statPlayed').textContent = stats.gamesPlayed;
    $('onlineCount').textContent = stats.online;
    $('onlinePill').hidden = currentView !== 'home';

    if (rooms.length === 0) {
      $('roomList').replaceChildren(
        el('div', { className: 'empty' }, [
          el('p', { textContent: 'No open rooms right now.' }),
          el('p', { className: 'small', textContent: 'Create a public room and it appears here for everyone — or play the AI instantly.' }),
        ])
      );
      return;
    }

    $('roomList').replaceChildren(
      ...rooms.map((room) => {
        const live = room.phase === 'playing';
        const seats = Array.from({ length: room.maxSeats }, (_, i) => el('i', { className: i < room.players ? 'on' : '' }));
        const btn = el('button', { className: `btn ${live ? 'outline' : 'primary'}`, type: 'button' }, live ? [icon('eye'), 'Watch live'] : ['Join room', icon('arrow-right')]);
        btn.addEventListener('click', () => joinRoom(room.code));
        return el('article', { className: 'card room-card' }, [
          el('div', { className: 'room-top' }, [
            avatarBadge(room.hostAvatar, 'var(--gold)', 'lg'),
            el('div', {}, [
              el('div', { className: 'room-code-sm', textContent: room.code }),
              el('div', { className: 'muted small', textContent: `${room.host}'s room` }),
            ]),
          ]),
          el('div', { className: 'tags' }, [
            el('span', { className: `tag ${live ? 'live' : ''}`, textContent: live ? '● Playing' : 'Waiting for players' }),
            el('span', { className: 'tag', textContent: `${room.gridSize}×${room.gridSize}` }),
            el('span', { className: 'tag', textContent: `${room.turnSeconds}s turns` }),
            room.stars ? el('span', { className: 'tag', textContent: 'Star boxes' }) : null,
            room.powers ? el('span', { className: 'tag', textContent: 'Power-ups' }) : null,
          ]),
          el('div', { className: 'seats', title: `${room.players}/${room.maxSeats} players` }, seats),
          btn,
        ]);
      })
    );
  }

  function renderProfilePickers() {
    $('avatarPicker').replaceChildren(
      ...AVATARS.map((a) => {
        const btn = el('button', { type: 'button', role: 'radio', 'aria-checked': String(a === avatar), 'aria-label': `Avatar: ${a}`, title: a }, icon(a));
        btn.addEventListener('click', () => {
          avatar = a;
          localStorage.setItem(AVATAR_KEY, a);
          renderProfilePickers();
        });
        return btn;
      })
    );
    for (const btn of $('levelPicker').children) {
      btn.setAttribute('aria-checked', String(btn.dataset.level === level));
    }
  }

  // ------------------------------------------------------------------ joining

  function enteredRoom(res) {
    if (!state) {
      // Fresh page or new room: don't replay effects that happened before we arrived.
      seenMoveKey = moveKey(res.state);
      seenPowerSeq = res.state.game?.lastPower?.seq ?? null;
      seenSkipSeq = res.state.game?.lastSkip?.seq ?? null;
    }
    saveSession({ code: res.code, token: res.token, playerId: res.playerId });
    setUrlRoom(res.code);
    onState(res.state);
  }

  function leftRoom(message) {
    saveSession(null);
    state = null;
    // Forget per-room cue tracking so the next room starts fresh.
    seenMoveKey = null;
    prevTurnPlayerId = null;
    prevPhase = null;
    seenPowerSeq = null;
    seenSkipSeq = null;
    bombMode = false;
    confetti.clear();
    setUrlRoom(null);
    showView('home');
    $('homeError').textContent = message || '';
  }

  function playerName() {
    const name = $('nameInput').value.trim();
    if (name) localStorage.setItem(NAME_KEY, name);
    return name;
  }

  function nameMissing() {
    $('homeError').textContent = 'Type your name first so friends know who you are.';
    $('nameInput').focus();
    $('nameInput').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async function withBusy(button, fn) {
    button.disabled = true;
    try {
      return await fn();
    } finally {
      button.disabled = false;
    }
  }

  async function createRoom() {
    const name = playerName();
    if (!name) return nameMissing();
    const res = await withBusy($('createBtn'), () => request('room:create', { name, avatar }));
    if (res.ok) enteredRoom(res);
    else $('homeError').textContent = res.error;
  }

  async function quickPlay() {
    const name = playerName() || 'You';
    const res = await withBusy($('quickBtn'), () => request('room:quickplay', { name, avatar, level }));
    if (res.ok) enteredRoom(res);
    else $('homeError').textContent = res.error;
  }

  async function joinRoom(code) {
    const name = playerName();
    if (!name) return nameMissing();
    if (!/^[A-Z]{4}$/.test(code)) {
      $('homeError').textContent = 'Room codes are 4 letters.';
      $('codeInput').focus();
      return;
    }
    const res = await request('room:join', { code, name, avatar });
    if (res.ok) enteredRoom(res);
    else $('homeError').textContent = res.error;
  }

  /** Re-attach to our room after a refresh or a dropped connection. */
  async function resume() {
    if (!session) return;
    $('loadingText').textContent = 'Rejoining your room…';
    if (!state) showView('loading');
    const res = await request('room:join', {
      code: session.code,
      token: session.token,
      name: localStorage.getItem(NAME_KEY) || '',
      avatar,
    });
    if (res.ok) return enteredRoom(res);
    // A slow network is not a lost seat: keep the session and try again.
    if (res.timeout) return void setTimeout(() => socket.connected && resume(), 2000);
    const code = session.code;
    leftRoom(res.error);
    $('codeInput').value = code; // one tap to join again
  }

  function leaveRoom() {
    request('room:leave'); // don't make the player wait on a slow network
    leftRoom();
  }

  // ------------------------------------------------------------------ state

  function onState(next) {
    if (!session || next.code !== session.code) return;
    const isMoveNew = Boolean(next.game?.lastMove) && moveKey(next) !== seenMoveKey;
    state = next;
    turnEndsAt = next.game?.turnEndsInMs != null ? performance.now() + next.game.turnEndsInMs : null;

    if (!state.members.some((m) => m.id === session.playerId)) {
      return leftRoom('You are no longer in that room.');
    }
    render(isMoveNew);
    playCues(isMoveNew);
  }

  function moveKey(s) {
    const m = s.game?.lastMove;
    return m ? `${s.round}:${m.type}${m.r},${m.c}` : null;
  }

  function playCues(isMoveNew) {
    const g = state.game;
    if (isMoveNew) {
      const { combo, claimed } = g.lastMove;
      sound.play(combo >= 2 ? 'combo' : claimed.length ? 'claim' : 'line');
      showComboPop(g.lastMove);
    }
    seenMoveKey = moveKey(state);

    const turnId = g?.turnPlayerId ?? null;
    if (state.phase === 'playing' && turnId === session.playerId && turnId !== prevTurnPlayerId) {
      setTimeout(() => sound.play('turn'), isMoveNew ? 180 : 0);
      if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(60);
    }
    if (state.phase === 'over' && prevPhase === 'playing') {
      const iWon = g.winnerIds.includes(session.playerId);
      sound.play(iWon ? 'win' : 'end');
      confetti.burst(g.winnerIds.map(colorOf).concat(['#ffffff', '#ffb800']), iWon ? 220 : 120);
    }
    prevTurnPlayerId = turnId;
    prevPhase = state.phase;
    playPowerCues();
  }

  /** Effects for power-ups everyone sees: explosion, frost, pop-up messages. */
  function playPowerCues() {
    const g = state.game;
    const nameOf = (id) => (id === session.playerId ? 'You' : playerById(id)?.name ?? 'Someone');
    const power = g?.lastPower;
    if (power && power.seq !== seenPowerSeq) {
      seenPowerSeq = power.seq;
      const who = nameOf(power.by);
      if (power.power === 'bomb') {
        showPop('Boom!', '#ff7a59');
        blastAt(power.line);
        flashBoard('shake', 450);
        sound.play('bomb');
        if (power.by !== session.playerId) toast(`${who} bombed a line`);
      } else if (power.power === 'freeze') {
        showPop(`${who} froze ${power.target === session.playerId ? 'you' : nameOf(power.target)}`, '#7fd3ff');
        flashBoard('frost', 1200);
        sound.play('freeze');
      } else {
        showPop(`${who === 'You' ? 'Double' : `${who}: Double`} line`, 'var(--gold)');
        sound.play('double');
      }
    }
    const skip = g?.lastSkip;
    if (skip && skip.seq !== seenSkipSeq) {
      seenSkipSeq = skip.seq;
      toast(skip.playerId === session.playerId ? 'You were frozen — turn skipped' : `${nameOf(skip.playerId)} was frozen — turn skipped`);
    }
  }

  function flashBoard(className, ms) {
    const wrap = $('board').parentElement;
    wrap.classList.remove(className);
    void wrap.offsetWidth; // restart the animation
    wrap.classList.add(className);
    setTimeout(() => wrap.classList.remove(className), ms);
  }

  function blastAt(line) {
    if (!line || reducedMotion) return;
    const [x1, y1, x2, y2] = lineEnds(line);
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const board = $('board');
    const group = svg('g', {}, board);
    svg('circle', { class: 'blast-core', cx, cy, r: 26 }, group);
    svg('circle', { class: 'blast', cx, cy, r: 30 }, group);
    setTimeout(() => group.remove(), 800);
  }

  function showComboPop({ combo, claimed, by }) {
    const stars = claimed.filter(({ r, c }) => state.game.stars[r][c]).length;
    let text = null;
    if (combo >= 2) text = `Combo ×${combo}`;
    else if (stars) text = '+2 ★';
    if (text) showPop(text, colorOf(by));
  }

  function showPop(text, color) {
    const pop = el('span', { textContent: text, '--c': color });
    $('comboPop').replaceChildren(pop);
    setTimeout(() => pop.remove(), 1200);
  }

  function render(isMoveNew) {
    $('roomBadge').textContent = state.code;
    if (state.phase === 'lobby') {
      renderLobby();
      showView('lobby');
    } else {
      renderGame(isMoveNew);
      showView('game');
    }
  }

  // ------------------------------------------------------------------ lobby

  let qrCode = null;
  function renderLobby() {
    const host = isHost();
    const seated = state.members.filter((m) => m.seated);
    const ready = seated.filter((m) => m.connected).length;
    const s = state.settings;

    $('lobbyCode').textContent = state.code;
    $('siteHost').textContent = location.host;
    if (qrCode !== state.code) {
      qrCode = state.code;
      $('qrImg').src = `/qr/${state.code}.svg`;
    }
    $('playerCount').textContent = `${ready}/${state.maxSeats} seats`;

    $('lobbyPlayers').replaceChildren(
      ...state.members.map((m) => {
        const tags = [
          m.id === session.playerId && el('span', { className: 'tag you', textContent: 'You' }),
          m.id === state.hostId && el('span', { className: 'tag host' }, [icon('crown'), 'Host']),
          m.isBot && el('span', { className: 'tag bot', textContent: `Bot · ${LEVEL_LABEL[m.botLevel]}` }),
          m.wins > 0 && el('span', { className: 'tag' }, [icon('trophy'), String(m.wins)]),
          !m.seated && el('span', { className: 'tag', textContent: 'Waiting for a seat' }),
          !m.connected && el('span', { className: 'tag', textContent: 'Offline' }),
        ];
        let remove = null;
        if (m.isBot && host) {
          remove = el('button', { className: 'remove-bot', type: 'button', 'aria-label': `Remove ${m.name}`, title: 'Remove bot' }, icon('x'));
          remove.addEventListener('click', () => hostAction('room:removeBot', { botId: m.id }));
        }
        return el('li', { className: m.connected ? '' : 'offline', '--c': m.color || GREY }, [
          avatarBadge(m.avatar, m.color),
          el('span', { className: 'player-name', textContent: m.name }),
          ...tags,
          remove,
        ]);
      })
    );

    $('botControls').hidden = !host;
    for (const btn of $('botControls').querySelectorAll('button')) btn.disabled = seated.length >= state.maxSeats;

    const update = (patch) => hostAction('room:settings', patch);
    segmented(
      $('sizePicker'),
      state.options.gridSizes.map((n) => ({ value: n, label: `${n}×${n}`, hint: `${n * n} boxes` })),
      s.gridSize,
      (gridSize) => update({ gridSize }),
      !host
    );
    segmented(
      $('timerPicker'),
      state.options.turnSeconds.map((t) => ({ value: t, label: `${t}s`, hint: t <= 10 ? 'Blitz' : t >= 60 ? 'Chill' : '' })),
      s.turnSeconds,
      (turnSeconds) => update({ turnSeconds }),
      !host
    );
    $('starsToggle').checked = s.stars;
    $('starsToggle').disabled = !host;
    $('powersToggle').checked = s.powers;
    $('powersToggle').disabled = !host;
    $('publicToggle').checked = s.isPublic;
    $('publicToggle').disabled = !host;
    $('hostOnly').textContent = host ? 'you are the host' : 'only the host can change these';

    $('startBtn').hidden = !host;
    $('startBtn').disabled = ready < 2;
    const hostName = state.members.find((m) => m.id === state.hostId)?.name || 'the host';
    $('startHint').textContent = !host
      ? `Waiting for ${hostName} to start the game…`
      : ready < 2
        ? 'You need at least 2 players — share the code or add a bot.'
        : 'Everyone in? Hit start!';
  }

  // ------------------------------------------------------------------ game

  function renderGame(isMoveNew) {
    const g = state.game;
    const over = state.phase === 'over';
    const myTurn = !over && g.turnPlayerId === session.playerId;
    const current = g.players.find((p) => p.id === g.turnPlayerId);
    if (!myTurn) bombMode = false;

    // Turn banner
    $('turnBanner').hidden = over;
    $('turnBanner').classList.toggle('mine', myTurn);
    $('turnBanner').style.setProperty('--turn', colorOf(g.turnPlayerId));
    $('turnAvatar').replaceChildren(icon(current ? current.avatar : 'clock'));
    $('turnText').replaceChildren(
      ...(myTurn
        ? bombMode
          ? [el('span', { className: 'big', textContent: 'Bomb armed' }), 'tap a glowing line to erase it · tap Bomb to cancel']
          : [el('span', { className: 'big', textContent: 'Your turn' }), g.doubleArmed ? 'double line active — this line keeps your turn' : 'draw a line']
        : current && g.turnIsBot
          ? [el('span', { className: 'who', textContent: current.name }), el('span', { className: 'thinking' }, [' is thinking', el('i'), el('i'), el('i')])]
          : current
            ? [el('span', { className: 'who', textContent: current.name }), '’s turn']
            : ['Waiting for players to reconnect…'])
    );

    // Result
    $('resultCard').hidden = !over;
    if (over) renderResult();

    renderPowerBar(myTurn, over);
    renderBoard($('board'), g, { animate: isMoveNew, previewColor: colorOf(session.playerId), bombTargets: bombMode });
    $('board').classList.toggle('bomb-mode', bombMode);
    renderScoreboard(over);

    const watching = state.members.filter((m) => !g.players.some((p) => p.id === m.id));
    $('watchers').textContent = watching.length
      ? `Watching: ${watching.map((m) => (m.id === session.playerId ? 'you' : m.name)).join(', ')} — joining next round`
      : '';
  }

  function renderPowerBar(myTurn, over) {
    const g = state.game;
    const me = g.players.find((p) => p.id === session.playerId);
    $('powerBar').hidden = over || !g.powersEnabled || !me || me.left;
    if ($('powerBar').hidden) return;
    for (const btn of $('powerBar').querySelectorAll('[data-power]')) {
      const power = btn.dataset.power;
      const available = Boolean(me.powers?.[power]);
      const armed = (power === 'bomb' && bombMode) || (power === 'double' && myTurn && g.doubleArmed);
      btn.classList.toggle('used', !available && !armed);
      btn.classList.toggle('armed', armed);
      btn.dataset.armed = power === 'bomb' ? 'Aiming' : 'Active';
      btn.setAttribute('aria-pressed', String(armed));
      btn.disabled = !myTurn || (!available && !armed) || (power === 'freeze' && Boolean(g.frozenId));
      if (power === 'bomb' && available && !bombMode && !hasBombTarget(g)) btn.disabled = true;
    }
  }

  function hasBombTarget(g) {
    return ['h', 'v'].some((type) => g[type].some((row, r) => row.some((_, c) => isBombable(g, { type, r, c }))));
  }

  async function onPowerClick(power) {
    if (!canMove()) return;
    if (power === 'bomb') {
      bombMode = !bombMode; // pick the line on the board next
      renderGame(false);
      return;
    }
    const res = await request('game:power', { power });
    if (!res.ok) toast(res.error, true);
  }

  function renderResult() {
    const g = state.game;
    const winners = g.players.filter((p) => g.winnerIds.includes(p.id));
    const iWon = g.winnerIds.includes(session.playerId);
    const best = winners[0]?.score ?? 0;

    let title;
    if (winners.length === 0) title = 'Game over';
    else if (winners.length === 1) title = iWon ? 'Victory — you win!' : `${winners[0].name} wins`;
    else title = `Tie: ${winners.map((w) => (w.id === session.playerId ? 'you' : w.name)).join(' & ')}`;

    $('resultAvatar').replaceChildren(
      ...(winners.length ? winners.map((w) => avatarBadge(w.avatar, w.color, 'xl')) : [avatarBadge('crown', 'var(--gold)', 'xl')])
    );
    $('resultTitle').textContent = title;
    $('resultSub').textContent = `${best} ${best === 1 ? 'point' : 'points'}${winners.length > 1 ? ' each' : ''} · round ${state.round}`;
    $('awards').replaceChildren(
      ...g.awards.map((a) => {
        const p = g.players.find((x) => x.id === a.playerId);
        return el('div', { className: 'award' }, [
          el('span', { className: 'award-icon' }, icon(a.icon)),
          el('b', { textContent: a.title }),
          el('span', { className: 'award-player', style: { color: p?.color } }, [icon(p?.avatar ?? 'crown'), p?.id === session.playerId ? 'You' : p?.name ?? '']),
          el('span', { textContent: a.detail }),
        ]);
      })
    );
    $('resultHostActions').hidden = !isHost();
    $('resultWait').hidden = isHost();
  }

  function renderScoreboard(over) {
    const g = state.game;
    const players = over ? [...g.players].sort((a, b) => b.score - a.score) : g.players;
    $('scoreboard').replaceChildren(
      ...players.map((p, i) => {
        const status = p.left ? 'left' : !p.connected ? 'offline' : '';
        return el('li', {
          className: [p.id === g.turnPlayerId && !over ? 'turn' : '', status ? 'gone' : '', g.frozenId === p.id && !over ? 'frozen' : ''].join(' '),
          '--c': p.color,
        }, [
          over ? el('span', { className: `rank${i === 0 ? ' first' : ''}`, textContent: String(i + 1) }) : null,
          avatarBadge(p.avatar, p.color),
          el('span', { className: 'player-name', textContent: p.id === session.playerId ? `${p.name} (you)` : p.name }),
          p.isBot ? el('span', { className: 'tag bot', textContent: LEVEL_LABEL[p.botLevel] }) : null,
          status ? el('span', { className: 'tag', textContent: status }) : null,
          g.frozenId === p.id && !over ? el('span', { className: 'tag frozen-tag' }, [icon('snowflake'), 'Frozen']) : null,
          p.powers && !over
            ? el('span', { className: 'pips', title: 'Power-ups left' },
                ['freeze', 'double', 'bomb'].map((k) => {
                  const pip = icon(k === 'freeze' ? 'snowflake' : k);
                  if (!p.powers[k]) pip.classList.add('spent');
                  return pip;
                }))
            : null,
          el('span', { className: 'score', textContent: p.score }),
        ]);
      })
    );
  }

  // ------------------------------------------------------------------ board input

  /** The free line closest to a pointer event, if it's close enough to be what the player meant. */
  function lineAtPointer(event, mode = 'free') {
    const g = state?.game;
    if (!g) return null;
    const ctm = $('board').getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());

    let best = null;
    let bestDist = SPACING * 0.42;
    for (const type of ['h', 'v']) {
      g[type].forEach((row, r) =>
        row.forEach((owner, c) => {
          if (mode === 'free' ? owner !== null : !isBombable(g, { type, r, c })) return;
          const [x1, y1, x2, y2] = lineEnds({ type, r, c });
          // distance from point to an axis-aligned segment
          const dx = Math.max(Math.min(x1, x2) - pt.x, 0, pt.x - Math.max(x1, x2));
          const dy = Math.max(Math.min(y1, y2) - pt.y, 0, pt.y - Math.max(y1, y2));
          const dist = Math.hypot(dx, dy);
          if (dist < bestDist) {
            bestDist = dist;
            best = { type, r, c };
          }
        })
      );
    }
    return best;
  }

  const canMove = () => state?.phase === 'playing' && state.game.turnPlayerId === session?.playerId;

  function updatePreview(event) {
    const preview = $('board-preview');
    if (!preview) return;
    const line = event && event.pointerType === 'mouse' && canMove() ? lineAtPointer(event, bombMode ? 'bomb' : 'free') : null;
    $('board').style.cursor = line && !bombMode ? 'pointer' : '';
    preview.setAttribute('class', bombMode ? 'bomb-target' : 'preview');
    if (!line) return preview.setAttribute('visibility', 'hidden');
    const [x1, y1, x2, y2] = lineEnds(line);
    for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) preview.setAttribute(k, v);
    preview.setAttribute('visibility', 'visible');
  }

  let moving = false;
  async function onBoardClick(event) {
    if (!canMove() || moving) return;
    const bombing = bombMode;
    const line = lineAtPointer(event, bombing ? 'bomb' : 'free');
    if (!line) return;
    // Leave aiming mode before the server's new state arrives (it usually beats the ack).
    bombMode = false;
    moving = true;
    const res = bombing
      ? await request('game:power', { power: 'bomb', line })
      : await request('game:move', line);
    moving = false;
    if (!res.ok) {
      toast(res.error, true);
      if (state?.game) renderGame(false);
    }
  }

  // Countdown, driven locally from the server's remaining-time value.
  function tick() {
    requestAnimationFrame(tick);
    if (currentView !== 'game') return;
    const bar = $('timerBar');
    const seconds = $('secondsLeft');
    const g = state?.game;
    if (state?.phase === 'playing' && turnEndsAt != null) {
      const total = g.turnSeconds * 1000;
      const left = Math.max(0, turnEndsAt - performance.now());
      const low = left < Math.min(8000, total / 3);
      bar.style.transform = `scaleX(${left / total})`;
      bar.classList.toggle('low', low);
      seconds.textContent = `${Math.ceil(left / 1000)}s`;
      seconds.classList.toggle('low', low);
    } else {
      bar.style.transform = 'scaleX(0)';
      seconds.textContent = '';
    }
  }

  // ------------------------------------------------------------------ reactions

  function showReaction({ by, emoji }) {
    if (currentView !== 'game') return;
    const who = playerById(by);
    const floater = el('div', { className: 'floater', style: { left: `${10 + Math.random() * 75}%` } }, [
      el('span', { className: 'emoji', textContent: emoji }),
      el('span', { className: 'from', textContent: by === session?.playerId ? 'You' : who?.name ?? '' }),
    ]);
    $('reactionLayer').append(floater);
    setTimeout(() => floater.remove(), 2700);
    sound.play('react');
  }

  // ------------------------------------------------------------------ host actions & sharing

  async function hostAction(event, payload) {
    const res = await request(event, payload);
    if (!res.ok) toast(res.error, true);
  }

  async function copyInvite() {
    const url = `${location.origin}/?room=${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied!');
    } catch {
      window.prompt('Copy this link and send it to your friends:', url);
    }
  }

  async function shareInvite() {
    try {
      await navigator.share({
        title: 'Join my Box Party game',
        text: `Play Dots & Boxes with me! Room code: ${state.code}`,
        url: `${location.origin}/?room=${state.code}`,
      });
    } catch {
      /* user cancelled */
    }
  }

  // ------------------------------------------------------------------ wiring

  function init() {
    const params = new URLSearchParams(location.search);
    const urlCode = (params.get('room') || '').trim().toUpperCase();
    $('nameInput').value = localStorage.getItem(NAME_KEY) || '';
    $('codeInput').value = urlCode;
    if (session && urlCode && session.code !== urlCode) saveSession(null); // opened a different invite

    renderProfilePickers();
    $('soundBtn').replaceChildren(icon(sound.enabled ? 'volume' : 'volume-x'));
    $('shareBtn').hidden = !navigator.share;

    $('createBtn').addEventListener('click', createRoom);
    $('quickBtn').addEventListener('click', quickPlay);
    $('levelPicker').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-level]');
      if (!btn) return;
      level = btn.dataset.level;
      localStorage.setItem(LEVEL_KEY, level);
      renderProfilePickers();
    });
    $('joinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      joinRoom($('codeInput').value.trim().toUpperCase());
    });
    $('nameInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const code = $('codeInput').value.trim();
      if (code) joinRoom(code.toUpperCase());
      else createRoom();
    });
    $('codeInput').addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
    });

    $('leaveBtn').addEventListener('click', leaveRoom);
    $('leaveGameBtn').addEventListener('click', leaveRoom);
    $('copyLinkBtn').addEventListener('click', copyInvite);
    $('shareBtn').addEventListener('click', shareInvite);
    $('botControls').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bot]');
      if (btn) hostAction('room:addBot', { level: btn.dataset.bot });
    });
    $('starsToggle').addEventListener('change', (e) => hostAction('room:settings', { stars: e.target.checked }));
    $('powersToggle').addEventListener('change', (e) => hostAction('room:settings', { powers: e.target.checked }));
    $('powerBar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-power]');
      if (btn && !btn.disabled) onPowerClick(btn.dataset.power);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && bombMode) {
        bombMode = false;
        if (state?.game) renderGame(false);
      }
    });
    $('publicToggle').addEventListener('change', (e) => hostAction('room:settings', { isPublic: e.target.checked }));
    $('startBtn').addEventListener('click', () => hostAction('game:start'));
    $('againBtn').addEventListener('click', () => hostAction('game:start'));
    $('lobbyBtn').addEventListener('click', () => hostAction('game:lobby'));
    $('rulesBtn').addEventListener('click', () => $('rulesDialog').showModal());
    $('soundBtn').addEventListener('click', () => {
      $('soundBtn').replaceChildren(icon(sound.toggle() ? 'volume' : 'volume-x'));
    });

    $('reactionBar').replaceChildren(
      ...REACTIONS.map((emoji) => {
        const btn = el('button', { type: 'button', textContent: emoji, 'aria-label': `React ${emoji}` });
        btn.addEventListener('click', () => request('room:react', { emoji }));
        return btn;
      })
    );

    const board = $('board');
    board.addEventListener('click', onBoardClick);
    board.addEventListener('pointermove', updatePreview);
    board.addEventListener('pointerleave', () => updatePreview(null));

    socket.on('connect', () => {
      watchingLobby = false; // a fresh connection has no subscriptions yet
      if (session) resume();
      else if (!state) showView('home');
      if (currentView === 'home') watchLobby(true);
    });
    socket.on('disconnect', () => {
      if (session) toast('Connection lost — reconnecting…', true);
    });
    socket.on('state', onState);
    socket.on('notice', (text) => toast(text));
    socket.on('reaction', showReaction);
    socket.on('lobby', (snapshot) => {
      if (currentView === 'home') renderDirectory(snapshot);
    });
    socket.on('session:replaced', () => leftRoom('You opened this room in another tab.'));

    if (!session) {
      showView('home');
      if (urlCode) $('nameInput').focus();
    }
    demo.start();
    requestAnimationFrame(tick);
  }

  init();
})();
