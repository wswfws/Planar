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

```bash
claude mcp add --transport http planar https://planar.example.com/mcp \
  --header "Authorization: Bearer <PLANAR_TOKEN>"
```

Then ask the agent to open a document by its share link:
*"Open https://planar.example.com/?room=abc123 and …"*.

### Local (stdio)

From a clone of the repository (`npm ci && npm run build` once):

```bash
# Work on a file (created if missing; changes are saved to it):
claude mcp add planar -- node /path/to/Planar/dist-mcp/index.js --file ./design.planar.json

# Or join a shared room as a live participant:
claude mcp add planar -- node /path/to/Planar/dist-mcp/index.js --link "https://planar.example.com/?room=abc123#t=TOKEN"
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
tool.

## Tools

| Tool | For | What it does |
| --- | --- | --- |
| `open` | all | Open a `.planar.json` file or join a room by share link |
| `overview` | all | Pages, top-level frames, components, variables, selection, people |
| `tree` | all | Outline of a page or layer (depth-limited) |
| `find` | all | Find layers by name, text content or type |
| `inspect` | all | Full properties of layers, in create/update vocabulary |
| `screenshot` | all | PNG of a layer or page |
| `create` | design | Create layers from a nested description (frames, text, shapes, instances…) |
| `update` | design | Change properties of layers, move them, set instance props/variants |
| `delete` | design | Delete layers |
| `components` | design | Create component, combine as variants, add variant, detach instance |
| `variables` | design | Create/update/delete variables and modes |
| `select` | all | Select layers (in a live room, people see the agent's selection) |
| `undo` | design | Undo the agent's last changes |
| `code` | dev | React or HTML/CSS for a layer or component |
| `tokens` | dev | Variables as CSS custom properties, JSON or TypeScript |
| `export` | dev | SVG markup or PNG image of layers (or files, locally) |

## Layer vocabulary

Used by `inspect` (output) and `create` / `update` (input). Every key is
optional.

| Key | Values |
| --- | --- |
| `type` | `frame`, `text`, `rectangle`, `ellipse`, `line`, `vector`, `group`, `component`, `instance` (create only) |
| `name` | string |
| `x`, `y` | number (relative to the parent; ignored inside auto layout) |
| `width`, `height` | number, `"hug"` (fit content) or `"fill"` (stretch in auto layout) |
| `rotation`, `opacity` | degrees; 0–1 |
| `visible`, `locked` | boolean |
| `fill`, `stroke` | `"#RRGGBB"`, `"#RRGGBB 50%"`, `"$variable"`, `"image:<path or URL>"`, `null`, or a list of these |
| `strokeWidth`, `radius` | number or `"$variable"` |
| `clip` | boolean — clip content (frames) |
| `layout` | `"row"`, `"column"` or `"none"` — auto layout |
| `gap` | number or `"$variable"` |
| `padding` | `16`, `[12, 24]` (vertical, horizontal) or `[t, r, b, l]` |
| `align` | `"start"`, `"center"`, `"end"`, `"space-between"` — along the layout direction |
| `crossAlign` | `"start"`, `"center"`, `"end"` |
| `absolute` | boolean — ignore the parent's auto layout |
| `text` | string — text content (text layers) |
| `font`, `size`, `weight` | CSS family; px; 100–900 or `"bold"`, `"medium"`… |
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
- colours and numbers bound to variables → `var(--token-name)`, matching
  `tokens`;
- `react`: a component per main component or component set, with a typed
  props interface (text properties → `string`, booleans → `boolean`,
  instance swap → `ReactNode` slot, variant properties → string unions);
  instances inside a layout become `<Button label="…" />` elements;
- `html`: plain HTML with a stylesheet.

## Safety

- Room access uses the same token as people (`PLANAR_TOKEN`).
- The remote endpoint never reads or writes files on the server.
- Every change an agent makes is a normal edit: it can be undone with
  `undo`, and in a room it is visible to everyone immediately.
