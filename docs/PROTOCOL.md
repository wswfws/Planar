# Collaboration protocol (v2)

Planar clients talk to a Planar server over a WebSocket at `/ws`. Every
message is a JSON object with a `t` (type) field. Files, accounts and sharing
are managed through the HTTP API below; the WebSocket only edits an existing
file.

## Identity and roles

A browser is identified by its session cookie (`planar_session`, set at
sign-in); the WebSocket must come from the same origin as the page. Agents
send a personal API key (`plk_…`) in `hello`. Without either, the connection
is a **guest**, which only works for files with link access.

A person's role on a file is the strongest of: **owner**, their explicit
membership (**editor** / **viewer**) and the file's link access (`view` →
viewer, `edit` → editor). Only editors and owners may send `ops`.

## Model

The server holds each open file's document. Changes are exchanged as **ops**:

```jsonc
{ "o": "node", "id": "<node id>", "node": { ...SceneNode } }   // create or replace
{ "o": "node", "id": "<node id>", "node": null }               // delete
{ "o": "meta", "key": "name" | "pageIds" | "variables" | "modes", "value": ... }
```

The server applies ops in the order it receives them, assigns each batch the
next file **version**, and relays it to the other clients. Replacing a whole
node is last-writer-wins.

A client applies its own changes immediately and sends them in batches with
an increasing `seq`. Until the server acknowledges a batch, the client keeps
the layers in it **pending**: incoming ops for a pending layer are ignored,
because the client's own op reaches the server later and will win there too.
This keeps every client converging on the server's state.

After applying remote ops, clients repair the layer tree (children lists
are rebuilt from `parentId`; layers whose parent was deleted are removed;
pages missing from `pageIds` are appended), so concurrent structural edits
never leave dangling references.

## Messages

Client → server

| `t` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `file`, `key?`, `guestName?`, `color?` | Open a file. `guestName` and `color` are used for guests and agents; signed-in people use their account's name and colour. |
| `ops` | `seq`, `ops` | A batch of local changes. Viewers are refused with a non-fatal `error`. |
| `presence` | `pageId`, `cursor` (`{x, y}` or null), `selection` | Pointer and selection, sent at most ~20 times a second. |

Server → client

| `t` | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `clientId`, `doc`, `version`, `peers`, `role`, `you` | File state after `hello`; `role` is `owner`, `editor` or `viewer`. |
| `role` | `role` | The person's role changed while connected. |
| `ack` | `seq`, `version` | A batch from this client was handled. |
| `ops` | `from`, `version`, `ops` | Changes from another client (`from: "server"` for renames made through the API). |
| `presence` | `from`, `pageId`, `cursor`, `selection` | Another client's presence. |
| `join` / `leave` | `peer` / `id` | Someone joined or left. |
| `error` | `message`, `fatal?` | Problem; fatal errors close the connection (for example when access is removed). |

## HTTP API

All bodies are JSON. Requests authenticate with the session cookie or
`Authorization: Bearer plk_…`. Writes that use the cookie must come from the
server's own origin.

| Endpoint | Meaning |
| --- | --- |
| `GET /api/info` | `{ "planar": true, "protocol": 2, "accounts": true, "mcp": "/mcp" }` |
| `POST /api/auth/register` `{ username, password, displayName? }` | Create an account and sign in |
| `POST /api/auth/login` `{ username, password }` / `POST /api/auth/logout` | Sign in / out |
| `GET /api/me`, `PATCH /api/me` | The signed-in user (`null` if none); change name, colour or password |
| `GET /api/me/keys`, `POST /api/me/keys` `{ name }`, `DELETE /api/me/keys/:id` | Personal API keys; the secret is returned once, on creation |
| `GET /api/users?q=` | Up to 8 usernames starting with `q` (for invites) |
| `GET /api/files?scope=mine\|shared\|trash` | Your files |
| `POST /api/files` `{ name?, doc? }` | New file, empty or from a document |
| `GET /api/files/:id` | Metadata, your role and (for editors) the members |
| `PATCH /api/files/:id` `{ name?, linkAccess? }` | Rename (editors); link access `none` \| `view` \| `edit` (editors, signed in) |
| `POST /api/files/:id/duplicate` | Copy into your files (any file you can view) |
| `DELETE /api/files/:id` / `?forever=1` | Move to trash / delete for good (owner) |
| `POST /api/files/:id/restore` | Restore from trash (owner) |
| `PUT /api/files/:id/members` `{ username, role }` | `role`: `editor`, `viewer` or `null` to remove (editors; anyone may remove themselves) |
| `POST /api/files/:id/transfer` `{ username }` | Hand ownership over (owner) |
| `GET /api/files/:id/download` | The `.planar.json` document |
| `GET /api/files/:id/thumbnail.png` | Preview (empty if the server cannot render) |

Files that someone cannot see look the same as files that do not exist.

### Admin

Only for usernames in `ADMIN_USERS`, signed in with a cookie; everyone else
gets 404.

| Endpoint | Meaning |
| --- | --- |
| `GET /api/admin/overview` | Gauges, counters, per-minute history (24 h), daily totals (30 days), recent events, settings |
| `GET /api/admin/users?q=` | Users with activity, file counts and sizes |
| `POST /api/admin/users/:id` `{ blocked }` | Block or unblock (signs them out and closes their files) |
| `POST /api/admin/users/:id/logout` | Sign out everywhere |
| `DELETE /api/admin/users/:id?files=delete\|transfer:<username>` | Delete an account |
| `GET /api/admin/files?q=` | File metadata (never contents) |
| `POST /api/admin/files/:id` `{ linkAccess?, ownerUsername? }` | Close a link or change the owner |
| `DELETE /api/admin/files/:id` | Delete for good |
| `GET/POST /api/admin/settings` | `registrationOpen`, `maxFilesPerUser`, `maxFileBytes` |
| `POST /api/admin/alerts/test` | Send a Telegram test message |
| `GET /api/metrics` | Prometheus text format; needs `Authorization: Bearer <METRICS_TOKEN>` |

`/mcp` is the Model Context Protocol endpoint for agents (see [MCP.md](MCP.md)).


## Version history

Server messages: `{t:'reset', doc, version}` — the whole document was replaced (a version was restored); clients drop pending and unacknowledged changes and show the new document.

HTTP (editors only; viewers get 403): `GET /api/files/:id/versions`, `POST /api/files/:id/versions {label}`, `GET|PATCH /api/files/:id/versions/:vid`, `POST /api/files/:id/versions/:vid/restore`. Snapshots are taken automatically before an agent (API key / OAuth token) starts editing, and after 30 minutes of quiet or hourly while people edit; automatic ones are kept 30 days / 100 per file.

## Comments

Server message `{t:'comments'}` tells open clients to reload the comments of the file. HTTP: `GET|POST /api/files/:id/comments` (POST needs sign-in; `{text, pageId, nodeId?, x, y}` starts a thread, `{text, threadId}` replies), `PATCH|DELETE /api/files/:id/comments/:cid` (`{text}` author only, `{resolved}` author of the thread or an editor), `POST /api/files/:id/comments/read` marks them read. Anyone who can view a file can comment; a reply reopens a resolved thread. The file list reports `unreadComments` per file.

## Projects and search

A project groups files and is shared as a whole: `GET|POST /api/projects`, `GET|PATCH|DELETE /api/projects/:id`, `PUT /api/projects/:id/members {username, role}`. The project owner and editors can edit every file in it, viewers can view them; a person's role on a file is the strongest of the file's own roles, the link and the project. `PATCH /api/files/:id {projectId}` moves a file (the file's owner, into a project they own or edit; `null` removes it). Deleting a project keeps the files. `GET /api/files?scope=mine|shared|trash|all&q=<text>&project=<id>` filters by name and project.
