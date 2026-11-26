# 🏏 CricMate

A timing-based **3D** cricket duel for the browser. The bowler picks a delivery and a line, and the batter reads the ball and picks a shot by pressing a key at the right moment.

The 3D view (Three.js, bundled in `public/vendor` so it works offline) puts you behind the keeper when you bat and on a broadcast camera when you bowl. A follow-cam tracks every shot to the boundary. A light **2D** view is available under *Graphics* in the menu, and the game switches to it automatically on devices without WebGL.

| Mode | How it connects |
|---|---|
| **Offline vs CPU** | No network needed. Once loaded over `localhost`/HTTPS, a service worker caches the game, so it also works with no connection. |
| **LAN** | One player runs the server. Others on the same Wi‑Fi open `http://<host-ip>:3000`. |
| **P2P** | After joining a room, the browsers open a direct **WebRTC DataChannel**. If that fails, the game keeps running over the **WebSocket relay**. The badge in the top bar shows which one is in use. |
| **Online** | Expose the host's server with **ngrok**. WebSockets go through the tunnel (`wss://`). |

## Quick start

```bash
npm install
npm start          # http://localhost:3000 and the LAN URLs are printed
```

### Play online with ngrok

Pick one:

```bash
# A) built-in tunnel (uses the @ngrok/ngrok package)
set NGROK_AUTHTOKEN=your_token      # PowerShell: $env:NGROK_AUTHTOKEN="your_token"
npm run online

# B) ngrok CLI in a second terminal
npm start
ngrok http 3000
```

The host lobby finds the public URL on its own (it reads ngrok's local API on :4040 for option B) and shows a link with the room code to share.

## Characters

Pick one of 8 original cricketers on the menu. Each has a look (skin, hair, beard, build, headwear, name and number on the shirt) and four stats worth 12 points in total. A 3 in any stat has no effect.

| Cricketer | Role | Timing | Power | Pace | Craft |
|---|---|:-:|:-:|:-:|:-:|
| Rook Okafor “The Wall” | Opening batter | 5 | 2 | 2 | 3 |
| Arjun Vale “Thunder” | Power hitter | 2 | 5 | 3 | 2 |
| Kesh Ndlovu “Whiplash” | Express quick | 2 | 2 | 5 | 3 |
| Mira Solberg “Silk” | Swing bowler | 3 | 1 | 3 | 5 |
| Tobias Grieve “Old Fox” | Spin wizard | 4 | 2 | 1 | 5 |
| Jojo Banda “Sparks” | All-rounder | 3 | 3 | 3 | 3 |
| Ana Reyes “Ace” | Finisher | 4 | 4 | 2 | 2 |
| Dex Huang “Slingshot” | Skiddy quick | 1 | 4 | 4 | 3 |

- **Timing** (batting): every timing window gets up to ±9% wider or narrower.
- **Power** (batting): fours and sixes become more likely and catches less likely, by up to ±20%.
- **Pace** (bowling): fast, medium, yorker and bouncer deliveries arrive up to 6% sooner or later.
- **Craft** (bowling): more swing and turn, and the batter's timing windows shrink by up to 4%.

In 3D, each innings opens with broadcast-style close-ups of the striker and the bowler, with name cards. Online, the guest sends their pick to the host, and the host includes both picks in the `setup` message. Both clients then use the same modifiers, so the match stays deterministic.

## How to play

**Bowling:** choose a delivery (`1`–`6`) and a line (`Z` leg / `X` middle / `C` off), then **Bowl** (`Enter`).

| Delivery | What it does |
|---|---|
| Fast | Gives the batter the least time to react |
| Medium | Swings in the air |
| Slower | Tempts the batter into swinging early |
| Yorker | Lands at the batter's feet, hard to attack |
| Bouncer | Short and high; punishes drives, but pulls love it |
| Spin | Turns after it bounces |

**Batting:** press a shot key as the ball reaches the glowing zone at your crease. The key sets both the shot and the timing. Don't press anything to leave the ball.

| Key | Shot |
|---|---|
| `←` / `A` | Pull (leg side) |
| `↑` / `W` | Drive (straight / off side) |
| `→` / `D` | Cut (off side) |
| `Space` | Loft (sixes, or caught) |
| `↓` / `S` | Block |

Timing windows: Perfect ≤35 ms, Good ≤80, OK ≤130, Edge ≤200. Anything slower is a miss. Picking the wrong shot for the line or length lowers your timing grade.

On touch screens, use the on-screen buttons.

## Architecture

```
server.js            HTTP static server + WebSocket rooms (relay + WebRTC signaling), ngrok tunnel
public/
  js/engine.js       Pure deterministic rules: deliveries, shots, outcome tables, Match state
  js/main.js         Session: turn flow, HUD, input; same code drives CPU and network games
  js/net.js          WebSocket client + WebRTC P2P upgrade, sequence-numbered messages
  js/ai.js           CPU opponent that speaks the same message protocol as a remote peer
  js/characters.js   Roster, stats → engine modifiers, 2D portraits
  js/render3d.js     3D renderer (Three.js): stadium, crowd, players, ball flight, cameras
  js/render.js       2D fallback renderer (same API)
  vendor/            three.js browser build (copied from node_modules by scripts/vendor.js)
  js/sound.js        Synthesized sound effects (no audio files)
  sw.js              Offline cache (PWA)
test/                node:test unit tests (engine, rules, server rooms)
```

**Netcode:** the game is turn-based and lockstep. Each ball goes through two messages:

1. `deliver {n, delivery, seed}` from the bowler.
2. `swing {n, shot, timingErrorMs}` from the batter.

Each client then computes `resolveBall(delivery, swing, seed)` on its own. The function is deterministic, so both match states stay the same without one client acting as the authority. Timing is measured on the batter's own screen, so network lag doesn't affect batting.

## Tests

```bash
npm test
```
