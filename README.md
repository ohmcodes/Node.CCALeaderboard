# Clean! Cut! Action! - Leaderboard

The leaderboard server for the game: a small JSON API that the game talks to, plus the public page at
**https://cca.ohmcodes.com/leaderboard**. It needs Node.js 18 or newer and has no npm dependencies.

```
Leaderboard/
  src/server.js         HTTP server: API + static files
  src/store.js          player records, ranking, JSON file storage
  public/leaderboard/   the leaderboard page (index.html, style.css, app.js)
  public/assets/        cafe theme art (exported from Content/_CleanCutAction/UI/Widget)
  test/api.test.js      smoke tests (npm test)
  data/                 leaderboard.json lives here (git-ignored)
```

## Run it

```bash
cd Leaderboard
npm start            # http://localhost:8787/leaderboard
npm test             # API smoke tests
```

To point the editor or a test build at a local server, start the game with `-LeaderboardUrl=http://localhost:8787`,
or set it in `Config/DefaultGame.ini`:

```ini
[/Script/CleanCutAction.LTTLeaderboardSubsystem]
BaseUrl=http://localhost:8787
```

Remove that override before packaging for itch.io: the default is `https://cca.ohmcodes.com`.

## How players are identified

There are no accounts. On first launch the game makes a random id (a GUID) and keeps it in the browser's
`localStorage` (`cca_player_id`, plus `cca_player_name`). On desktop builds and in the editor it's in the
`LTTPlayerProfile` save slot instead. The briefing screen shows a random name like "Sleepy Barista 42" that the player can
edit or reroll. If a player clears their browser data, they come back as a new player.

The API never sends a player's id back in a list. The game opens the page as `/leaderboard?player=<id>` so the
page can highlight that player's row. The page then saves the id in its own localStorage and removes it from the address bar.

## Ranking

1. Best score, highest first.
2. If scores tie, the faster **best time** wins. Best time counts only runs where every prop got back on its mark (`setClean`).
3. If those tie too, whoever got the score first wins.

The server keeps each player's best score and best time, and only overwrites them with better ones.

## API

All responses are JSON with `ok: true|false`. CORS is open (`*`) because the game runs on itch.io's domain inside a
cross-origin isolated page.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/api/health` | | `{ ok, players }` |
| GET | `/api/leaderboard` | `limit` (1-100, default 10), `offset`, `player`, `q` (name search) | `{ total, matched, topScore, fastestTime, entries[], you }` |
| GET | `/api/players/:id` | | that player's row and rank |
| PUT | `/api/players/:id` | `{ name }` | rename |
| POST | `/api/runs` | `{ playerId, name, score, timeSeconds, setClean, timeTrial, placed, total, broken, hints }` | `{ newBestScore, newBestTime, player, total }` |

An entry looks like `{ rank, name, bestScore, bestTime (seconds or null), runs, cleanRuns, lastPlayed, isYou }`.
In `you`, `rank: 0` means the player has a name but no finished run yet.

The server checks every value: whole-number score within ±`MAX_SCORE`, time from 0 to 24 h, `placed <= total`, and a name of
at most 24 characters with control characters and `<>` removed. A run counts as clean only if `placed == total` and it took
at least `MIN_RUN_SECONDS`. Writes are limited per IP. **Scores aren't protected against cheating**: anyone who reads the
web build can post a made-up score. If that ever matters, delete the bad rows from `data/leaderboard.json` while the server is stopped.

## Configuration (environment variables)

| Var | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `DATA_FILE` | `data/leaderboard.json` | written atomically, 0.5 s after each change |
| `TRUST_PROXY` | `1` | read the client IP from `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For` (for the rate limit) |
| `WRITE_LIMIT_PER_MIN` | `30` | POST/PUT requests per IP per minute |
| `MAX_SCORE` | `100000` | |
| `MIN_RUN_SECONDS` | `10` | |

## Deploy on cca.ohmcodes.com

1. Copy the `Leaderboard` folder to the server (no `npm install` needed).
2. Keep it running with systemd or pm2:

   ```ini
   # /etc/systemd/system/cca-leaderboard.service
   [Unit]
   Description=Clean! Cut! Action! leaderboard
   After=network.target

   [Service]
   WorkingDirectory=/srv/cca-leaderboard
   ExecStart=/usr/bin/node src/server.js
   Environment=PORT=8787 HOST=127.0.0.1
   Restart=always
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```

   or `pm2 start src/server.js --name cca-leaderboard && pm2 save`.

3. Put HTTPS in front of it. **The game must reach it over https**: itch.io serves the game over https, and
   the browser blocks plain http requests from an https page.

   Caddy (gets its own certificate):

   ```
   cca.ohmcodes.com {
       reverse_proxy 127.0.0.1:8787
   }
   ```

   nginx:

   ```nginx
   server {
       server_name cca.ohmcodes.com;
       listen 443 ssl;   # certbot --nginx -d cca.ohmcodes.com
       location / {
           proxy_pass http://127.0.0.1:8787;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       }
   }
   ```

   Don't add CORS headers in the proxy (the server already sends them; sending them twice breaks CORS).

4. Check it: `curl https://cca.ohmcodes.com/api/health`, then open https://cca.ohmcodes.com/leaderboard.

Back up `data/leaderboard.json` now and then. It's the whole database.
