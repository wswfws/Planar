# Collaboration protocol (v1)

Planar clients talk to a Planar server over a WebSocket at `/ws`. Every
message is a JSON object with a `t` (type) field.

## Model

The server holds each room's document. Changes are exchanged as **ops**:

```jsonc
{ "o": "node", "id": "<node id>", "node": { ...SceneNode } }   // create or replace
{ "o": "node", "id": "<node id>", "node": null }               // delete
{ "o": "meta", "key": "name" | "pageIds" | "variables" | "modes", "value": ... }
```

The server applies ops in the order it receives them, assigns each batch the
next room **version**, and relays it to the other clients. Replacing a whole
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
| `hello` | `room`, `name`, `color`, `token?`, `doc?` | Join a room. With `doc`, the room is created from it if it does not exist. |
| `ops` | `seq`, `ops` | A batch of local changes. |
| `presence` | `pageId`, `cursor` (`{x, y}` or null), `selection` | Pointer and selection, sent at most ~20 times a second. |

Server → client

| `t` | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `clientId`, `doc`, `version`, `peers` | Room state after `hello`. |
| `ack` | `seq`, `version` | A batch from this client was applied. |
| `ops` | `from`, `version`, `ops` | Changes from another client. |
| `presence` | `from`, `pageId`, `cursor`, `selection` | Another client's presence. |
| `join` / `leave` | `peer` / `id` | Someone joined or left. |
| `error` | `message`, `fatal?` | Problem; fatal errors close the connection. |

## HTTP

`GET /api/info` returns `{ "planar": true, "protocol": 1, "auth": boolean }`
so the editor can tell it is being served by a Planar server.
