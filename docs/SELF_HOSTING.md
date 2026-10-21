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
DOMAIN=planar.example.com docker compose up -d --build
```

This starts two containers:

- **planar** — the editor and the collaboration server on port 8080 inside
  the Docker network, storing documents in the `planar-data` volume;
- **caddy** — listens on ports 80/443, gets a free Let's Encrypt certificate
  for `DOMAIN` automatically and forwards traffic (including WebSockets) to
  Planar.

Open `https://planar.example.com` and create an account — registration is
open, so anyone who can reach the server can register. Accounts, file
metadata and documents live in the data volume.

### Accounts, files and sharing

- Every file belongs to an **owner**. The owner can also give it to someone
  else, move it to the trash and restore or delete it for good.
- **Editors** edit, rename and share the file; **viewers** can open it, copy
  from it and export it, but not change it.
- Share a file by username (the box suggests matching users) or with a link
  that gives *view* or *edit* access. People without an account can open such
  a link; they appear as "Guest N".
- Any file you can view can be copied into your own files.

### Documents saved before accounts existed

Older versions stored shared rooms without owners. On start they are moved
into the new file store and stay reachable through their old links (edit
access). Set `LEGACY_OWNER=<username>` and register that username to take
them over: they then appear in that account's files, still with link access
until the owner changes it.

Make sure ports 80 and 443 are open in the server's firewall
(`ufw allow 80,443/tcp`).

## AI agents

The server also hosts the Planar MCP endpoint at `https://planar.example.com/mcp`
(a personal API key, sent as `Authorization: Bearer plk_…`; create one in the
account menu). See [MCP.md](MCP.md):

```bash
claude mcp add --transport http planar https://planar.example.com/mcp --header "Authorization: Bearer plk_…"
```

## Updating

```bash
cd Planar
git pull
DOMAIN=planar.example.com docker compose up -d --build
```

Put `DOMAIN` (and optionally `LEGACY_OWNER`) into a `.env` file next to
`docker-compose.yml` to avoid typing them each time:

```
DOMAIN=planar.example.com
LEGACY_OWNER=your-username
```

`PLANAR_TOKEN` from earlier versions is no longer used: remove it from `.env`.

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
PORT=8080 DATA_DIR=/var/lib/planar node dist-server/index.js
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

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP and WebSocket port |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Accounts, sessions, API keys and documents (`files/`) |
| `STATIC_DIR` | `dist` next to the server | Built editor to serve |
| `LEGACY_OWNER` | empty | Username that takes over documents saved before accounts existed |

Health check: `GET /healthz`. Server info: `GET /api/info`.

## Limits and notes

- Sign-ups are open. The editor must be served by the Planar server itself
  (same address as the API) for accounts to work; the GitHub Pages build is
  a local-only editor.
- Passwords are stored as scrypt hashes; sessions are cookies (`HttpOnly`,
  `SameSite=Lax`, `Secure` over HTTPS); sign-in attempts are rate limited per
  address. Back up the whole `DATA_DIR` — it contains accounts and documents.
- Images are embedded in documents; messages up to 50 MB are accepted.
- The wire protocol is documented in [PROTOCOL.md](PROTOCOL.md).
