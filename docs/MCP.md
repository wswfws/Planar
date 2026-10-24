# Planar MCP server — design files for AI agents

Planar ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so coding and design agents (Claude Code, Claude Desktop, Cursor,
VS Code, …) can read, build and change Planar documents.

It is designed around what agents are good at:

- **Few, strong tools.** One `create` call builds a whole screen from a
  nested description; one `update` call restyles many layers.
- **One vocabulary for reading and writing.** `inspect` returns layers in
  exactly the shape `create` and `update` accept (`layout: "column"`,
  `gap: 16`, `fill: "$brand"`, `width: "fill"`…), so an agent can read a
  layer, tweak the object and send it back.
- **Compact answers.** Trees come back as short outlines, not megabytes of
  JSON; details are fetched only when asked for.
- **Developer output.** React components (typed props, variants, slots) and
  HTML/CSS where auto layout becomes flexbox and variables become CSS
  custom properties, plus design tokens in CSS/JSON/TypeScript.
- **Eyes.** `screenshot` renders any layer to PNG so the agent can check its
  work.
- **Live collaboration.** Pointed at a shared room, the agent joins as a
  participant named *Agent*: people watch its pointer and selection and see
  every change appear, and the agent sees what people select.

## Connecting

### Remote (recommended with a Planar server)

A self-hosted Planar server (see [SELF_HOSTING.md](SELF_HOSTING.md))
exposes the MCP endpoint at `https://<your-server>/mcp`. Nothing has to be
installed on the agent's machine.

Create a personal API key in Planar (account menu → **API keys**). The agent
acts with your rights: it sees your files and those shared with you, and is
read-only on files you can only view.

```bash
claude mcp add --transport http planar https://planar.example.com/mcp \
  --header "Authorization: Bearer plk_…"
```

Then ask the agent to work on a file: *"Create a file called Landing and design
a hero section"* (it uses `files` and `open`), or give it a link:
*"Open https://planar.example.com/file/abc123 and …"*.

### Claude (claude.ai, desktop, mobile): custom connector with OAuth

No key needed. In Claude open **Settings → Connectors → Add custom connector**,
enter `https://planar.example.com/mcp`, keep **OAuth client** on *Use Claude's
published credentials* (or *Register automatically*) and leave the request
headers empty. Claude opens Planar: sign in and press **Allow**. The connector
then acts as you; disconnect it any time under your account → *Connected apps*.

Planar implements the MCP authorization spec: protected-resource metadata
(`/.well-known/oauth-protected-resource`), authorization-server metadata
(`/.well-known/oauth-authorization-server`), client ID metadata documents and
dynamic client registration, authorization code with PKCE (S256), and rotating
refresh tokens (access tokens last an hour, refresh tokens 90 days). Set
`PUBLIC_URL` if the server is reached under a different address than its
`Host` header suggests.

### Local (stdio)

From a clone of the repository (`npm ci && npm run build` once):

```bash
# Work on a file (created if missing; changes are saved to it):
claude mcp add planar -- node /path/to/Planar/dist-mcp/index.js --file ./design.planar.json

# Or work on files on a Planar server (key from the account menu):
claude mcp add planar -e PLANAR_KEY=plk_… -- node /path/to/Planar/dist-mcp/index.js --server https://planar.example.com
# Or open one file straight away:
claude mcp add planar -e PLANAR_KEY=plk_… -- node /path/to/Planar/dist-mcp/index.js --link "https://planar.example.com/file/abc123"
```

Other clients use the same command in their MCP configuration, e.g.

```json
{
  "mcpServers": {
    "planar": { "command": "node", "args": ["/path/to/Planar/dist-mcp/index.js", "--file", "design.planar.json"] }
  }
}
```

Without `--file` or `--link`, the agent opens a document with the `open`
tool. `--key` (or `PLANAR_KEY`) is the API key and `--server` (or
`PLANAR_SERVER`) the server for the `files` tool.

## Tools

| Tool | For | What it does |
| --- | --- | --- |
| `files` | all | List your files (and those shared with you), create one, or duplicate a file you can view |
| `open` | all | Open a Planar file by id or link, or a local `.planar.json` |
| `overview` | all | Pages, top-level frames, components, variables, selection, people |
| `tree` | all | Outline of a page or layer (depth-limited) |
| `find` | all | Find layers by name, text content, context notes or type |
| `context` | all | Read everything written about a layer (file brief → page → parents → component → layer, plus the notes around its screen), write the file brief or a layer's notes |
| `notes` | all | Requests for the agent (`inbox`: chat messages and notes mentioning @ai), list/read notes, add sticky notes, descriptions, chats, checklists and callouts, post in chats, tick checklist items |
| `inspect` | all | Full properties of layers, in create/update vocabulary |
| `screenshot` | all | PNG of a layer or page |
| `create` | design | Create layers from a nested description (frames, text, shapes, instances…) |
| `update` | design | Change properties of layers, move them, set instance props/variants |
| `delete` | design | Delete layers |
| `components` | design | Create component, combine as variants, add variant, detach instance |
| `variables` | design | Create/update/delete variables and modes |
| `pages` | all | List, create, rename, delete or switch pages |
| `select` | all | Select layers (in a live room, people see the agent's selection) |
| `undo` | design | Undo the agent's last changes |
| `code` | dev | React or HTML/CSS for a layer or component |
| `tokens` | dev | Variables as CSS custom properties, JSON or TypeScript |
| `export` | dev | SVG markup or PNG image of layers (or files, locally) |
| `requests` | dev | Send HTTP API requests and read or manage the file's request history (the "API requests…" tool) |

## Layer vocabulary

Used by `inspect` (output) and `create` / `update` (input). Every key is
optional.

| Key | Values |
| --- | --- |
| `type` | `frame`, `text`, `rectangle`, `ellipse`, `line`, `vector`, `group`, `component`, `instance`, `svg` (create only) |
| `svg` | create only, with `type: "svg"`: SVG markup to import as a frame of vector layers (icons, logos, illustrations). `width`/`height` scale it; `fill` recolours every shape (e.g. `"$ink"`) |
| `path` | vector: SVG path data such as `"M4 12 L20 12 M12 4 L12 20"` (curves allowed); `viewBox: [w, h]` gives the coordinate space (default: the path's bounds) |
| `name` | string |
| `context` | notes on what the layer is for (markdown); `null` or `""` clears them |
| `x`, `y` | number (relative to the parent; ignored inside auto layout) |
| `width`, `height` | number, `"hug"` (fit content) or `"fill"` (stretch in auto layout) |
| `rotation`, `opacity` | degrees; 0–1 |
| `visible`, `locked` | boolean |
| `fill`, `stroke` | `"#RRGGBB"`, `"#RRGGBB 50%"`, `"$variable"`, `"image:<path or URL>"`, `null`, or a list of these |
| `strokeWidth`, `radius` | number or `"$variable"` |
| `clip` | boolean — clip content (frames) |
| `shadow` | `"x y blur [spread] #RRGGBB [opacity%]"`, `"inset …"` for an inner shadow, several separated by commas; `null` removes all shadows |
| `blur`, `backgroundBlur` | blur radius in px; `0` or `null` removes it |
| `textStyle`, `effectStyle` | a style name from the `styles` tool; `null` detaches (the layer keeps its look) |
| `wrap`, `rowGap` | boolean; number — row layouts continue on new rows |
| `constraints` | `"<h> <v>"`, h = left / right / left-right / center / scale, v = top / bottom / top-bottom / center / scale — how the layer follows its parent frame when it is resized (outside auto layout); a single word sets its own axis |
| `layout` | `"row"`, `"column"`, `"grid"` or `"none"` — auto layout |
| `columns`, `rows` | grid: number of columns (1–100) and rows (`0` = as many as needed); `gap` is the column gap, `rowGap` the row gap; `align` / `crossAlign` place items inside their cells |
| `strokesIncluded` | boolean — auto layout: strokes take up space |
| `stacking` | `"last-on-top"` (default) or `"first-on-top"` — auto layout |
| `lockAspect` | boolean — resizing keeps the ratio |
| `gap` | number or `"$variable"` |
| `padding` | `16`, `[12, 24]` (vertical, horizontal) or `[t, r, b, l]` |
| `align` | `"start"`, `"center"`, `"end"`, `"space-between"` — along the layout direction |
| `crossAlign` | `"start"`, `"center"`, `"end"` |
| `absolute` | boolean — ignore the parent's auto layout |
| `text` | string — text content (text layers) |
| `font`, `size`, `weight` | family name (any Google Fonts family works, e.g. `"Manrope"`, `"Unbounded"`); px; 100–900 or `"bold"`, `"medium"`… |
| `lineHeight` | multiplier or `"auto"` |
| `textAlign`, `textAlignVertical` | `left/center/right`; `top/middle/bottom` |
| `component` | instance: component or component-set name or id |
| `props` | instance: `{ "Label": "Buy", "Show icon": false }` |
| `variant` | instance: `{ "Type": "Danger", "Size": "Large" }` |
| `mode` | variable mode name for this subtree, e.g. `"Dark"` |
| `parent`, `index` | update only: move the layer |
| `children` | create only: nested layers |

Example — a card in one call:

```json
{
  "parent": "<page or frame id>",
  "layers": [{
    "type": "frame", "name": "Card", "layout": "column", "gap": 12, "padding": 24,
    "width": 320, "height": "hug", "fill": "#FFFFFF", "radius": 16,
    "children": [
      { "type": "text", "text": "Upgrade to Pro", "size": 20, "weight": "bold" },
      { "type": "text", "text": "Unlimited projects and sharing.", "width": "fill", "fill": "#5A5A68" },
      { "type": "instance", "component": "Button", "props": { "Label": "Upgrade" }, "variant": { "Type": "Primary" } }
    ]
  }]
}
```

## Code generation

`code` turns a layer into code a developer can paste:

- auto layout → flexbox (`gap`, `padding`, `justify-content`,
  `align-items`); *fill* → `flex: 1` / `align-self: stretch`; *hug* → no
  fixed size; layers in frames without auto layout → absolute positioning;
- fills, strokes, radius, opacity, rotation, clipping, text styles;
- constraints → `right`/`bottom`, both sides, `calc(50% …)` or percentages; wrapping rows → `flex-wrap: wrap` with `row-gap`;
- shadows → `box-shadow` (`text-shadow` for text, `filter: drop-shadow()` for vectors), blurs → `filter` / `backdrop-filter`;
- colours and numbers bound to variables → `var(--token-name)`, matching
  `tokens`;
- `react`: a component per main component or component set, with a typed
  props interface (text properties → `string`, booleans → `boolean`,
  instance swap → `ReactNode` slot, variant properties → string unions);
  instances inside a layout become `<Button label="…" />` elements;
- `html`: plain HTML with a stylesheet.

## Safety

- An API key gives an agent exactly its owner's rights (owner, editor or
  viewer per file) and can be revoked at any time in the account menu.
- The remote endpoint never reads or writes files on the server.
- Every change an agent makes is a normal edit: it can be undone with
  `undo`, and in a room it is visible to everyone immediately.
- `requests send` calls APIs from where the MCP server runs. The remote
  endpoint refuses loopback, private and link-local addresses (unless the
  server runs with `PROXY_PRIVATE_HOSTS=1`); a local MCP server may call them.


### versions

`versions` — `list`, `save {label}`, `restore {versionId}` for the open server file. A version is saved automatically before an agent starts editing; restoring saves the current state first.

### comments

`comments` — `list` (open threads, `resolved: true` for all), `add {text, nodeId?, x?, y?}`, `reply {commentId, text}`, `resolve {commentId, resolved?}` for the open server file.

### Prototype links

`create` / `update` accept `"link": "<top-level frame name or id>"` (and optionally `"transition": "instant" | "slide" | "dissolve"`) to make a layer open that screen on click in Present mode (`/file/<id>/present?frame=<id>`). `"link": null` removes it; `inspect` returns it.

### Projects and search

`files` also takes `action: "projects"`, and `project` (name or id) and `q` (name search) on `list`, and `project` on `create`.

### Styles

`styles` creates or updates text and effect styles in one call — `set: [{name, type: "text", font, size, weight, lineHeight}]`, `set: [{name, type: "effect", shadow, blur, backgroundBlur}]`, or `{name, from: "<layer id>"}` to copy a layer's settings — and `remove: [names]`; with no arguments it lists them with how many layers use each. Layers follow a style through the props `textStyle` and `effectStyle`. `tokens` exports text styles as `--font-<name>` (for `font: var(…)`) and shadow styles as `--shadow-<name>`; generated code uses those variables for styled layers.

### Context

`context` keeps the reasons behind a design next to it. `action: "get"` with a layer id returns, as markdown sections, the file brief, the page's notes, the notes of every enclosing layer, the main component's notes (documentation) and the layer's own; without an id it returns the file brief. `action: "set"` replaces the notes of a layer, or the file brief when `id` is omitted; `append: true` adds a paragraph instead. `overview` starts with the file brief, `tree` and `find` show a short excerpt of a layer's notes, and `find` takes `context` to search them. Generated React code puts a component's notes in a JSDoc comment.

### Notes, chats and requests

Annotation layers (sticky notes, markdown descriptions, chats, checklists and callouts) are how people and agents talk on the canvas. `notes` with:

- `action: "inbox"` lists open requests: chat messages that mention `@ai` (also `@agent`, `@claude`) with no agent message after them, and other notes whose text mentions `@ai`. `overview` says how many there are.
- `list` (current page, or `within: "all"`) and `read` (`id` or `ids`; a chat with its messages, a checklist with its items).
- `add` with `kind` (`sticky` default, `doc`, `chat`, `checklist`, `callout`), `text`, `title` and `items` (chats and checklists), `target` (a layer id: a callout points at it, other notes are placed beside its screen), `color`, `x`/`y`. Without a position a note goes right of the page content, below notes already there. Sticky notes and messages are signed with the agent's name and marked as written by AI.
- `post` (`id`, `text`) answers in a chat; the request then leaves the inbox.
- `set` changes `text`, `title`, `color`, a callout's `target`, replaces checklist `items`, or ticks items with `check: [{item, done}]` (item id, 1-based number or text).

`inspect`, `tree`, `find` (`type: "note"`) and `screenshot` include annotations; `export` and `code` leave them out. `context get` lists the notes on and around a layer's screen and the callouts pointing into it.

### API requests

`requests` works with the file's API request history, the same one people see in "API requests…" (main menu):

- `action: "list"` shows the history, newest first: id, name, method, URL, status and time, and who sent it.
- `get` (`id`) returns one entry in full: the request with its headers and body, then the response status, headers and body (JSON indented, cut at 20 000 characters).
- `send` calls an API: `method` (default `GET`), `url`, `params` and `headers` as `{name: value}`, and `body` (an object or array is sent as JSON; a string as JSON when it parses, else as text) or `form` fields. `bodyKind` overrides the guess. With `id` it re-sends that saved request, changing only the fields given. The request is saved with its response (or the error) and the agent's name; `name` names the entry and `save: false` leaves the history alone. A request that gets no response returns an error but is still saved.
- `rename` (`id`, `name`; an empty name removes it), `delete` (`id`) and `clear`.

History changes are not undo steps. Anyone who can open the file sees the saved requests, headers and tokens included.

### Team libraries

`libraries` lists the libraries the open file uses and the ones it could add (with versions and contents), and with `action: "add" | "update" | "remove"` and `library: "<name or file id>"` adds, updates or removes one. Library components then work like local ones (`create` with `component: "Name"`), and `overview` marks them "from library". `action: "publish"` publishes the open file as a library (again to share changes).
