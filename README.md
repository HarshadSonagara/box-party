# 🟥 Box Party — real-time multiplayer Dots & Boxes

**Connect the dots. Steal the boxes.** The classic pen-and-paper duel, rebuilt for the group chat.
2–6 players, each on their own phone or laptop. Share a 4-letter code, a link or a QR code. Nobody has to log in or install anything.

## How to play

1. On your turn, tap the gap between two neighbouring dots to **draw a line**.
2. If your line closes the **4th side of a box**, you claim that box and you **go again**.
3. If you don't close a box, the turn passes to the next player.
4. When every box is taken, the player with **the most points wins**. Ties share the win.
5. **⭐ Star boxes** (optional mode) are worth 2 points.
6. **Power-ups** (on by default): everyone gets three, each usable once per game on your own turn:
   - **Freeze**: the next player misses their next turn.
   - **Double**: your next line doesn't end your turn, so you can set a trap and take the box yourself.
   - **Bomb**: erase any line that isn't part of a claimed box.
7. Every turn has a timer (10s Blitz up to 60s). If time runs out, your turn is skipped (and an armed Double is lost).

> 💡 Tip: never draw the 3rd side of a box, or the next player will steal it.

The rules are on the home page (with a live, self-playing demo board) and behind the **?** button during play.

## Features

| | |
|---|---|
| 📈 **Rankings, goals and shop** | Every game earns **XP and credits**. Level up from Rookie to Grandmaster and climb the **global rankings** (XP, wins, win rate, best combo, boxes). Finish **daily challenges** and **progressive goals** that level up forever, then spend credits in the **shop** on premium avatars and animated frames (gold, frost, ember, prism) that everyone sees in game. No account needed: progress is saved on the device and **signed by the server**, so it can't be faked and survives server restarts. |
| 💣 **Power-up cards** | Freeze a rival, draw a Double line, or Bomb a line off the board. Each has its own effect (frost flash, explosion with screen shake), and power-ups left are shown on the scoreboard. Bots use them too, saving them for the moment they'd otherwise have to give boxes away. |
| ⚡ **Play vs AI in one tap** | Three bot levels. Easy is random-ish. Medium always takes free boxes and avoids 3rd sides. Hard also gives away the fewest points when it's forced to sacrifice. Bots can fill empty seats in any room. |
| 📱 **Scan-to-join QR codes** | Every lobby shows a QR code. Point a phone at the screen and you're in. |
| 🌍 **Live "Open rooms" directory** | Public rooms are listed on the home page and refresh automatically. Join a waiting room or 👀 watch a live game. |
| 📊 **Live stats** | See players online, live games, and games finished. |
| 😂 **Real-time emoji reactions** | Reactions float across every player's screen. |
| 🔥 **Combos and awards** | COMBO ×N pop-ups when you chain boxes. End-of-round titles: 🔥 Combo King, ⚡ Lightning Hands, ⭐ Star Hunter, 💣 Mastermind. Confetti for the winner. |
| 🎭 **Avatars** | 16 line-art avatars (crown, gem, moon…). Your avatar stamps every box you win, in your colour. |
| ⚙️ **Host settings** | Board size from 3×3 to 7×7, turn timer, star boxes, power-ups on or off, and public or private room. |
| 🔄 **Never lose your seat** | A refresh, an app switch, or a Wi-Fi drop puts you right back into your game. Your turn timer keeps running, offline players are skipped, and the host role passes on automatically. |
| 👀 **Spectators** | Late joiners watch the current round and get a seat in the rematch. |
| 🏆 **Rematch** | Win tally across rounds, and the starting player rotates each round. |

### How the sync works

The **server is the single source of truth**. Every action (move, setting, bot turn) is validated on the server, and the full room state is broadcast to every device over WebSockets ([Socket.IO](https://socket.io)). Clients only send intents and render the latest state, so screens can never disagree. Each browser tab gets a secret reconnect token, which is never broadcast, so a refresh puts you back into the same seat.

## Run it locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Open http://localhost:3000. The console also prints a `http://192.168.x.x:3000` address that phones on the same Wi-Fi can use.

There are 61 automated tests. They cover the rules, the AI, power-ups, profiles (including anti-cheat signatures), room logic, full two-device and vs-bot games over real WebSockets, and production stress checks: junk and malicious input, spam, 20 games at once, host disconnects, full rooms, and cleanup.

```bash
npm test
```

## Production hardening

- **Server-authoritative:** every move and setting is validated on the server, and clients can't cheat.
- **Crash-proof timers:** a failing bot move or turn timer is logged, never fatal.
- **Rate limiting** per connection, plus caps on rooms (2000) and members per room (16).
- **Security headers:** Content-Security-Policy, nosniff, Referrer-Policy, Permissions-Policy.
- **Input cleaning:** names are trimmed to 16 characters, avatars and reactions are whitelisted, and all output is rendered as text, never HTML.
- **Graceful shutdown on redeploy:** players are told, and they reconnect automatically.
- **Automatic cleanup:** offline players are removed after 2 minutes, and empty rooms are deleted.
- **`/healthz`** endpoint for uptime monitors.

## Deploy it (free) so anyone can join

The game needs a host that supports WebSockets. **Render** works on its free plan:

1. Push this folder to a GitHub repository.
2. On [render.com](https://render.com), choose **New → Blueprint** and pick the repo. `render.yaml` configures everything.
3. You get a public URL like `https://box-party.onrender.com`. Share it!

Free Render services sleep after ~15 minutes idle, so the first visit afterwards takes ~30–60 s to wake up.
Railway and Fly.io also work. They just need to run `npm start` with a `PORT` env var.

## Project structure

```
server.js          Express + Socket.IO: rooms, events, /api/lobby, /qr/:code.svg, cleanup
src/game.js        Pure Dots & Boxes rules (board, moves, star boxes, scoring)
src/ai.js          Bot move and power-up selection (easy / medium / hard)
src/room.js        Room state machine: players, bots, host, settings, turns, timer, power-ups, awards
src/profiles.js    Signed player profiles: XP, levels, credits, goals, shop, leaderboard
public/            Client (vanilla HTML/CSS/JS, no build step)
test/              node:test suites
```

### Socket events

| Client → server | Payload | Notes |
|---|---|---|
| `room:create` | `{ name, avatar }` | Ack: `{ code, playerId, token, state }` |
| `room:quickplay` | `{ name, avatar, level }` | Private room vs a bot, already started |
| `room:join` | `{ code, name, avatar, token? }` | `token` = rejoin as the same player |
| `room:settings` | `{ gridSize?, turnSeconds?, stars?, powers?, isPublic? }` | Host only, lobby only |
| `room:addBot` / `room:removeBot` | `{ level }` / `{ botId }` | Host only, lobby only |
| `room:react` | `{ emoji }` | Rate-limited |
| `game:start` | – | Host only, from lobby or results |
| `game:move` | `{ type: 'h'\|'v', r, c }` | Must be your turn |
| `game:power` | `{ power: 'freeze'\|'double'\|'bomb', line? }` | Your turn, once each per game. `line` is only for Bomb |
| `game:lobby` | – | Host only, after a game |
| `room:leave` | – | |
| `profile:hello` | `{ profile, sig }` or nothing | Restores (if the signature is valid) or creates this device's profile |
| `profile:claim` | `{ kind: 'daily'\|'track', id }` | Claim a finished goal's credits |
| `profile:buy` / `profile:equip` | `{ itemId }` / `{ avatar?, frame? }` | Shop purchases and cosmetics |
| `leaderboard:get` | `{ metric }` | `xp`, `wins`, `winRate`, `bestCombo` or `boxes` |

Server → client: `state` (full public room state), `notice` (toast text), `reaction`, `profile:update` (rewards after a game), `lobby` (live stats), `session:replaced`.

Profiles are stored in `data/profiles.json` (set `DATA_DIR` to move it). `PROFILE_SECRET` signs them; `render.yaml` generates one automatically.
