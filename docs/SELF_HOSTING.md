# Self-hosting a Planar collaboration server

The Planar server lets several people edit the same document in real time.
It also serves the editor itself, so your team only needs one address.

What you need:

- a small Linux VPS (1 vCPU / 1 GB RAM is plenty for a team) with a public IP;
- a domain or subdomain pointing at it (for HTTPS — browsers require a
  secure connection for the editor on GitHub Pages and for clipboard access);
- Docker with the Compose plugin.

## 1. Point a domain at the server

Create a DNS `A` record such as `planar.example.com → <server IP>` (and an
`AAAA` record if the server has IPv6). Wait until `ping planar.example.com`
shows the right address.

## 2. Install Docker

On Ubuntu/Debian:

```bash
curl -fsSL https://get.docker.com | sh
```

## 3. Get Planar and start it

```bash
git clone https://github.com/wswfws/Planar.git
cd Planar
DOMAIN=planar.example.com PLANAR_TOKEN=$(openssl rand -hex 16) docker compose up -d --build
```

This starts two containers:

- **planar** — the editor and the collaboration server on port 8080 inside
  the Docker network, storing documents in the `planar-data` volume;
- **caddy** — listens on ports 80/443, gets a free Let's Encrypt certificate
  for `DOMAIN` automatically and forwards traffic (including WebSockets) to
  Planar.

Open `https://planar.example.com`. Click **Share**, enter your name and the
access token, then **Start collaborating** and send the link to your team.
The token is included in the link (after `#`, so it is never sent to the
server in logs or referrers).

To see the token later: `docker compose exec planar printenv PLANAR_TOKEN`.
To run without a token (anyone who can guess a room link may join — room ids
are random and long), leave `PLANAR_TOKEN` empty.

Make sure ports 80 and 443 are open in the server's firewall
(`ufw allow 80,443/tcp`).

## AI agents

The server also hosts the Planar MCP endpoint at `https://planar.example.com/mcp`
(same token, sent as `Authorization: Bearer <token>`). See [MCP.md](MCP.md):

```bash
claude mcp add --transport http planar https://planar.example.com/mcp --header "Authorization: Bearer <token>"
```

## Updating

```bash
cd Planar
git pull
DOMAIN=planar.example.com PLANAR_TOKEN=<your token> docker compose up -d --build
```

Put `DOMAIN` and `PLANAR_TOKEN` into a `.env` file next to
`docker-compose.yml` to avoid typing them each time:

```
DOMAIN=planar.example.com
PLANAR_TOKEN=your-token
```

## Backups

Documents are JSON files in the `planar-data` volume:

```bash
docker compose cp planar:/data ./planar-backup
```

## Without Docker

Requires Node.js 20 or newer.

```bash
npm ci
npm run build
PORT=8080 DATA_DIR=/var/lib/planar PLANAR_TOKEN=... node dist-server/index.js
```

Put a reverse proxy with TLS (Caddy, nginx, Traefik) in front of it and make
sure it forwards WebSocket upgrades on `/ws`. For nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

## Without a domain (testing only)

`docker build -t planar . && docker run -p 8080:8080 -v planar-data:/data planar`
and open `http://<server IP>:8080`. This works for trying things out, but
the connection is not encrypted, and the GitHub Pages editor (HTTPS) cannot
connect to a plain-HTTP server.

## Using the public editor with your server

You can also keep using `https://wswfws.github.io/Planar/`: in **Share**,
enter `https://planar.example.com` as the server address. Share links then
point at the public editor and carry your server address.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP and WebSocket port |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where rooms are stored |
| `STATIC_DIR` | `dist` next to the server | Built editor to serve |
| `PLANAR_TOKEN` | empty | Access token required from clients |

Health check: `GET /healthz`. Server info: `GET /api/info`.

## Limits and notes

- There are no user accounts yet: everyone with the link (and the token)
  can edit.
- A room is one document. Leaving a room keeps a local copy in that browser.
- Images are embedded in documents; messages up to 50 MB are accepted.
- The wire protocol is documented in [PROTOCOL.md](PROTOCOL.md).
