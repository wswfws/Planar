# Planar

**Planar** is an open-source vector design editor that runs in the browser.
It covers the core workflow of modern interface-design tools — frames,
shapes, text, layers, properties, undo and export — and was built with a
[clean-room process](CLEAN_ROOM.md): no proprietary code, formats or assets.

> Planar is an independent project and is not affiliated with Figma, Inc. or
> any other design-tool vendor.

## Features (v0.1)

- Infinite canvas with smooth pan and zoom (2 %–25 600 %)
- Tools: Move, Hand, Frame, Rectangle, Ellipse, Line, Pen (polygons and polylines), Text
- Nested frames with clipping, groups that auto-fit their children
- Auto layout: horizontal / vertical stacks with spacing, padding, alignment,
  space-between, hug / fill / fixed sizing, absolute children and drag-to-reorder
- Components and instances: live propagation, per-property overrides, reset,
  detach, nested instances, Assets tab with thumbnails and drag-to-place
- Component properties: text, boolean (visibility) and instance-swap inputs that
  each instance sets in its own *Properties* section
- Variants: combine components into a set with variant properties (e.g. Type,
  Size); instances switch variants from selectors and keep matching overrides
- Variables (colour, number, string, boolean) with modes such as Light/Dark,
  bound to fills, strokes, sizes, spacing, padding, text and visibility
- Select, multi-select, marquee, move with smart snapping, resize (Shift / Alt),
  rotate (Shift snaps to 15°), Alt-drag to duplicate, drop layers into frames
- Layers panel: tree view, rename, hide, lock, drag and drop to reorder or re-parent
- Pages
- Properties: position, size, rotation, corner radius, opacity, multiple fills
  and strokes, image fills, text settings, alignment
- Numeric fields accept arithmetic (`120/3+8`) and can be scrubbed by dragging the label
- Copy / paste (also between tabs), duplicate, group / ungroup, frame selection, z-order
- Right-click context menus on the canvas and layer tree: contextual actions with
  their shortcuts, *Select layer* (everything under the pointer), *Order*, paste
  at the pointer, copy as SVG, rename
- Paste or drop images
- Undo / redo, autosave to browser storage
- Save / open `.planar.json` files ([format](docs/FILE_FORMAT.md))
- Export PNG (1×–3×) and SVG for the selection or the whole page

See the full [functional specification](docs/SPEC.md) for behaviour and
keyboard shortcuts.

## Getting started

Requires Node.js 18 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

| Command | Description |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm test` | Run unit tests (Vitest) |
| `npm run build` | Type-check and build to `dist/` |
| `npm run preview` | Serve the production build |

The production build is a static site; `.github/workflows/pages.yml` deploys
it to GitHub Pages on every push to `main` (enable *Settings → Pages → Source:
GitHub Actions* once).

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| V, H, F, R, O, L, P, T | Move, Hand, Frame, Rectangle, Ellipse, Line, Pen, Text |
| Space + drag, middle mouse | Pan |
| Ctrl/⌘ + wheel | Zoom |
| Shift+0 / Shift+1 / Shift+2 | Zoom to 100 % / fit / selection |
| Ctrl/⌘+Z, Ctrl/⌘+Shift+Z | Undo, redo |
| Ctrl/⌘+C / X / V / D | Copy, cut, paste, duplicate |
| Ctrl/⌘+G, Ctrl/⌘+Shift+G | Group, ungroup |
| Ctrl/⌘+Alt+G | Frame selection |
| Shift+A, Alt+Shift+A | Add / remove auto layout |
| Ctrl/⌘+Alt+K | Create component |
| Ctrl/⌘+Alt+B | Detach instance |
| Ctrl/⌘+] / [ (+Shift) | Bring forward / send backward (to front / back) |
| Enter, Shift+Enter, Esc | Select children, select parent |
| Arrows (+Shift) | Nudge 1 px (10 px) |
| Ctrl/⌘+S, Ctrl/⌘+O | Save, open |
| Ctrl/⌘+R | Rename layer |
| Right-click | Context menu |

## Architecture

The editor engine (`src/core`) is plain TypeScript with no framework
dependency: a flat node map forms the document tree, transforms are 2D affine
matrices, rendering uses Canvas 2D and every edit runs through a small
transaction system that powers undo/redo and autosave. The UI (`src/ui`) is a
thin React layer over that engine. See [CONTRIBUTING.md](CONTRIBUTING.md) for
the file layout.

## Roadmap

Real-time collaboration, comments,
variable collections and aliases, wrapping auto layout, constraints, boolean operations, Bézier editing, gradients, shadows and blur,
styles, prototyping, plugins, version history.

## Contributing

Contributions are welcome — please read [CLEAN_ROOM.md](CLEAN_ROOM.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE)
