# Deploying the leaderboard with Docker

This guide puts the Clean! Cut! Action! leaderboard on **https://cca.ohmcodes.com** with Docker. The repo
has everything it needs:

| File | What it does |
|---|---|
| `Dockerfile` | Node 22 Alpine image, runs as the unprivileged `node` user, with a built-in health check |
| `.dockerignore` | keeps `.git`, `data/`, tests and docs out of the image |
| `docker-compose.yml` | the `leaderboard` service, plus a `caddy` service for automatic HTTPS |
| `Caddyfile` | Caddy config: `cca.ohmcodes.com` → `leaderboard:8787` |

The game only talks to the server over **HTTPS**. itch.io serves the game over https, and the browser blocks
plain http requests from it. The game expects `https://cca.ohmcodes.com` (`BaseUrl` in
`ULTTLeaderboardSubsystem`).

---

## 1. Prerequisites

- A Linux server (any VPS: 1 vCPU / 512 MB is plenty) with **Docker Engine 24+** and the **Compose plugin**.

  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER   # log out and back in afterwards
  docker --version && docker compose version
  ```

- A DNS **A record** (and AAAA if the server has IPv6): `cca.ohmcodes.com` → the server's public IP.
  Check it with `dig +short cca.ohmcodes.com`.
- Ports **80** and **443** open in the firewall / cloud security group (Caddy needs 80 for the certificate
  challenge and 443 for HTTPS).

  ```bash
  sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp   # if you use ufw
  ```

If Cloudflare proxies the domain (orange cloud), set SSL/TLS mode to **Full (strict)**. Or start with the cloud grey
(DNS only) until Caddy has its certificate.

---

## 2. Get the code onto the server

```bash
sudo mkdir -p /srv/cca-leaderboard && sudo chown $USER /srv/cca-leaderboard
git clone <your private repo URL> /srv/cca-leaderboard
cd /srv/cca-leaderboard
```

(No git access on the server? `scp -r` or `rsync` the repo folder instead. `node_modules` isn't needed because there
are no dependencies.)

---

## 3. Option A: leaderboard + Caddy (recommended for a fresh server)

```bash
docker compose up -d --build
```

That's it. Caddy requests a Let's Encrypt certificate for `cca.ohmcodes.com` on first start (usually under a
minute) and renews it automatically.

Check it:

```bash
docker compose ps                      # both "running", leaderboard "healthy"
docker compose logs -f caddy           # look for "certificate obtained successfully"
curl https://cca.ohmcodes.com/api/health
# {"ok":true,"players":0,"time":...}
```

Then open https://cca.ohmcodes.com/leaderboard in a browser.

## 3. Option B: leaderboard only (you already run nginx / Traefik / another Caddy)

Start just the app. It listens on `127.0.0.1:8787` on the host:

```bash
docker compose up -d --build leaderboard
curl http://127.0.0.1:8787/api/health
```

Point your existing reverse proxy at it. nginx example (certificate via `certbot --nginx -d cca.ohmcodes.com`):

```nginx
server {
    server_name cca.ohmcodes.com;
    listen 443 ssl http2;
    # ssl_certificate ... (added by certbot)

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Don't add CORS headers in the proxy.** The app already sends `Access-Control-Allow-Origin: *` and
`Cross-Origin-Resource-Policy: cross-origin`. Sending them twice makes browsers reject the response.

If the proxy is another container on a shared Docker network, drop the `ports:` line and proxy to
`cca-leaderboard:8787` on that network.

---

## 4. Configuration

Set these in `docker-compose.yml` under `leaderboard.environment`, then run `docker compose up -d` to apply them:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8787` | port inside the container |
| `DATA_FILE` | `/app/data/leaderboard.json` | lives in the `leaderboard-data` volume |
| `TRUST_PROXY` | `1` | read the client IP from `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For` (for the rate limit). Set `0` only if the container is exposed directly |
| `WRITE_LIMIT_PER_MIN` | `30` | POST/PUT per IP per minute |
| `MAX_SCORE` | `100000` | runs above this are rejected |
| `MIN_RUN_SECONDS` | `10` | shorter runs never count as a clean set |

---

## 5. Data and backups

All scores are in a single file, `leaderboard.json`, in the named volume `leaderboard-data`. It survives
`docker compose down`, rebuilds and image updates. It's only deleted by `docker compose down -v` or `docker volume rm`.
**Never use `-v` on this stack.**

Back up (works while running, since the file is replaced atomically):

```bash
docker compose cp leaderboard:/app/data/leaderboard.json ./backup-$(date +%F).json
```

Nightly cron example (`crontab -e`):

```cron
0 4 * * * cd /srv/cca-leaderboard && docker compose cp leaderboard:/app/data/leaderboard.json /srv/backups/cca-$(date +\%F).json
```

Restore (stop the app first so it doesn't overwrite the file on shutdown):

```bash
docker compose stop leaderboard
docker compose cp ./backup-2026-11-13.json leaderboard:/app/data/leaderboard.json
docker compose start leaderboard
```

Removing a cheater or a bad row works the same way: stop, copy out, edit the JSON, copy back, start.

---

## 6. Updating

```bash
cd /srv/cca-leaderboard
git pull
docker compose up -d --build leaderboard
docker image prune -f      # optional: drop old images
```

The data volume isn't touched. Downtime is the second or two it takes the container to restart.

---

## 7. Operating it

```bash
docker compose ps                         # status + health
docker compose logs -f leaderboard        # every run: "[run] <name> score=... -> #rank"
docker compose restart leaderboard
docker compose down                       # stop (data kept)
docker stats cca-leaderboard              # CPU / memory
```

Logs rotate at 10 MB × 3 files (`logging:` in the compose file).

---

## 8. Checklist before uploading the game to itch.io

- [ ] `curl https://cca.ohmcodes.com/api/health` returns `{"ok":true,...}` from outside the server
- [ ] https://cca.ohmcodes.com/leaderboard loads with a valid certificate (padlock, no warnings)
- [ ] CORS is present exactly once:
      `curl -sI -X OPTIONS https://cca.ohmcodes.com/api/runs | grep -i access-control-allow-origin` → one line, `*`
- [ ] The game's `BaseUrl` is `https://cca.ohmcodes.com` (no localhost override in `Config/DefaultGame.ini`)
- [ ] Play one game in the itch.io build: the end screen shows "Leaderboard: #N of M", and the run appears in
      `docker compose logs leaderboard`

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Caddy logs `challenge failed` / no certificate | DNS doesn't point at this server yet, or port 80 is blocked. Fix it, then `docker compose restart caddy`. Let's Encrypt rate-limits repeated failures, so check DNS first |
| Game says "Couldn't reach the leaderboard (offline?)" | Server down, http instead of https, or CORS stripped/duplicated by a proxy. Open the browser devtools console on the itch page and look at the failed request |
| `ERR_TOO_MANY_REDIRECTS` behind Cloudflare | Cloudflare SSL mode is "Flexible": switch to **Full (strict)** |
| Every player hits the rate limit together | The proxy isn't forwarding the client IP, so all requests look like they come from one address. Add `X-Real-IP` / `X-Forwarded-For` (section 3B) and keep `TRUST_PROXY=1` |
| `EACCES` writing `/app/data/...` | The volume was created by another image as root. Run `docker compose run --rm -u root leaderboard chown -R node:node /app/data`, then restart |
| Container `unhealthy` | `docker compose logs leaderboard`. Usually an invalid `leaderboard.json` after a manual edit. Restore a backup |
| Port 80/443 already in use | Another web server is running. Use Option B and proxy from it instead |
