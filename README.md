# SHADOW MARKET

A real-time, 2–8 player strategy party game. Players join with a six-character room code, select a specialty, negotiate, invest, protect assets, sabotage rivals, and compete for the highest final coin balance across six rounds.

## Requirements

- Node.js 20 or newer
- No npm dependencies; the server uses Node's built-in HTTP, crypto, and filesystem modules.

## Run locally

```bash
npm start
```

Open `http://localhost:3000` in two or more browser windows/devices on the same network. To let phones on the same Wi-Fi join, use the computer's LAN IP and allow inbound TCP traffic on port 3000. The room code is shown in the lobby.

Health check: `GET /health`.

## Deploy publicly

Deploy this folder to any Node.js host that supports a long-running web service (for example, Render, Railway, Fly.io, or a small VPS):

- Runtime: Node.js 20+
- Build command: none
- Start command: `npm start`
- Port: use the platform-provided `PORT` environment variable (the app supports it automatically)

After deployment, share the host's HTTPS URL. Anyone with that URL can create a room or join one with a room code. A public URL cannot be created from this source bundle alone; it must be deployed to an account/hosting environment you control.

## Important operational notes

- The server is authoritative for balances, timers, actions, market outcomes, room membership, and scoring.
- Client state is synchronized using lightweight HTTP polling (350 ms between completed polls) and ordered action requests. This avoids third-party runtime dependencies and works over HTTPS.
- Room state is held in memory. Reconnects work while the server process and room remain alive; a server restart clears active rooms. Use a single server instance unless shared persistent storage and cross-instance coordination are added.
- This is designed for casual private rooms, not hostile public matchmaking. Before a large public launch, add persistent storage, rate limiting, abuse controls, and automated integration tests.

## Rules implemented

- Six rounds, 100 starting coins, 60-coin total investment cap per round.
- Investments settle once per round; principal plus/minus P/L is returned to liquid coins.
- Protection costs 5 coins per token, maximum two per round, and offsets 10 percentage points of negative market movement.
- Market Disruption costs 10 coins and worsens a target asset's return by 10 points (Phantom can add 10); Asset Theft costs 10 coins and attempts to transfer 5 coins (Phantom can raise it to 10). Sentinel can block one theft if activated.
- Mutually selected alliances last one round; sabotage against an ally transfers up to 5 coins as a betrayal penalty.
- Guardian, Phantom, Oracle, Diplomat, Tycoon, and Sentinel abilities are once per match.
- Actions resolve in a fixed order, balances cannot become negative, and unsubmitted/disconnected players take a no-op turn.
- Ties use total wealth, cumulative investment P/L, and fewer successful sabotage actions; if all are equal, players share victory.
