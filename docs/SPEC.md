# Planar functional specification (v0.1)

This is the clean-room specification Planar is implemented from. It describes
observable behaviour only. See [`../CLEAN_ROOM.md`](../CLEAN_ROOM.md).

## 1. Document model

- A **document** has a name and an ordered list of **pages**.
- A page holds an ordered tree of **layers**. Later siblings paint on top of
  earlier ones.
- Layer types:
  - **Frame**: a rectangular container with fills, strokes, corner radius and
    an optional *clip content* flag. Frames can be nested.
  - **Group**: a container without its own paint whose bounds always fit its
    children. A group with no children is removed.
  - **Rectangle** (with corner radius), **Ellipse**.
  - **Vector**: a polyline or polygon (open or closed), also used for lines,
    or one or more **paths** with straight and curved (Bézier) segments and a
    fill rule (non-zero or even-odd). Paths scale with the layer's box.
  - **Text**: a block of text with font family, size, weight, horizontal and
    vertical alignment and line height. Its box has one of three sizing
    modes:
    - *auto width* — width and height grow with the content (no wrapping);
    - *auto height* — fixed width, lines wrap, height grows with the content;
    - *fixed size* — width and height are set by the user; lines wrap and
      the content is placed at the top, middle or bottom of the box and may
      overflow it.
    Each line is as tall as font size × line height — or, with line height
    *Auto* (the default), as tall as the font's own ascent + descent — with
    the glyphs centred
    in the line the same way the browser lays out text, so the text looks
    the same while editing and on the canvas.
- Every layer has: name, position (x, y) relative to its parent container,
  width, height, rotation in degrees around its centre, opacity, visible flag,
  locked flag, a list of fills, a list of strokes and a stroke width.
- A paint is either a solid colour (hex + opacity) or an image (embedded data
  URL, *fill* or *fit* scaling). Each paint can be hidden.

## 2. Canvas and viewport

- Infinite canvas. Mouse wheel / trackpad scroll pans; Ctrl/Cmd + wheel or
  pinch zooms around the pointer. Zoom range 2 %–25 600 %.
- Holding Space, using the Hand tool (H) or dragging with the middle button
  pans.
- Shift+0 zoom to 100 %, Shift+1 zoom to fit all, Shift+2 zoom to selection,
  Ctrl/Cmd + `=` / `-` zoom in/out.
- Top-level frames display their name above the top-left corner; clicking the
  label selects the frame.

## 3. Tools

| Key | Tool | Behaviour |
| --- | --- | --- |
| V | Move | Select, move, resize, rotate |
| H | Hand | Pan |
| F | Frame | Drag to create a frame; click creates 100×100 |
| R | Rectangle | Drag to create; Shift keeps 1:1; Alt draws from centre |
| O | Ellipse | As rectangle |
| L | Line | Drag to create a line; Shift snaps to 45° |
| P | Pen | Click to add points; click the first point to close; Enter/Esc or double-click to finish |
| T | Text | Click to place a text layer and start typing |

After a shape is created the tool returns to Move and the new layer is
selected. A shape created over a frame becomes a child of the deepest frame
under the starting point.

## 4. Selection and transformation

- Click selects the top-most layer under the pointer. Shift-click toggles.
  Dragging on empty canvas draws a marquee that selects intersecting layers of
  the current level.
- Clicking inside a group selects the whole group; double-click enters the
  group and selects the child. Children of frames are selectable directly.
- Enter selects the children of the selection; Shift+Enter or Esc selects the
  parent; Esc on a top-level selection clears it.
- Dragging a selected layer moves it. Shift constrains to one axis. Alt-drag
  duplicates. Moving snaps edges and centres to other layers (5 screen px)
  and shows guide lines. Positions are rounded to whole pixels. Dropping a
  layer over a frame moves it into that frame; dropping outside moves it to
  the page (layers inside groups stay in their group).
- Eight resize handles. Shift keeps aspect ratio, Alt resizes from centre.
  Resizing a group scales its children; resizing a frame does not. Resizing
  a text layer horizontally switches it to *auto height*; resizing it
  vertically (or typing a height) switches it to *fixed size*.
- Just outside each corner the pointer rotates the selection; Shift snaps to
  15° steps.
- Arrow keys nudge by 1 px, Shift+arrow by 10 px.
- The selection shows its size (W × H) under the bounding box.

## 5. Layer operations

| Shortcut | Action |
| --- | --- |
| Delete / Backspace | Delete |
| Ctrl/Cmd+C / X / V | Copy / cut / paste (also across tabs via the system clipboard) |
| Ctrl/Cmd+D | Duplicate (offset 10 px) |
| Ctrl/Cmd+A | Select all on the current level |
| Ctrl/Cmd+G | Group selection |
| Ctrl/Cmd+Shift+G | Ungroup (also unwraps a frame) |
| Ctrl/Cmd+Alt+G | Wrap selection in a new frame |
| Ctrl/Cmd+] / [ | Bring forward / send backward |
| Ctrl/Cmd+Shift+] / [ | Bring to front / send to back |
| Ctrl/Cmd+Shift+H | Show / hide |
| Ctrl/Cmd+Shift+L | Lock / unlock |
| Ctrl/Cmd+Alt+K | Create component |
| Ctrl/Cmd+Alt+B | Detach instance |
| (context menu) | Combine as variants, Add variant |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y | Undo / redo |

Pasting or dropping an image file creates a rectangle with an image fill at
the image's natural size.

**SVG import.** Pasting SVG markup or dropping an `.svg` file creates a
frame (no fill, named after the file or the SVG's title) sized like the SVG,
containing one vector layer per shape (`path`, `rect`, `circle`, `ellipse`,
`line`, `polyline`, `polygon`), with fills, strokes, stroke widths, fill
rules, opacity and transforms (including nested groups) preserved. Gradients,
masks, filters, text and CSS classes are not imported; such shapes fall back
to a solid colour.

**Fonts.** Text can use any font family. Families that are not installed
are loaded from Google Fonts automatically when a document uses them, and
text is re-measured once they arrive. The font picker suggests popular
families and accepts any name. Generated code and exported SVG include the
matching Google Fonts import.

### Context menu

Right-clicking opens a context menu that lists only what applies to the
current situation, each with its keyboard shortcut so the shortcuts can be
learnt from it. Disabled entries are shown greyed out rather than hidden
when they are part of a group that otherwise applies.

- Right-clicking a layer that is not selected selects it first; right-clicking
  inside the current selection (including on a layer nested in a selected
  layer) keeps it. Right-clicking empty canvas clears
  the selection.
- **Empty canvas:** paste here (at the pointer), select all, zoom to fit,
  zoom to 100 %, variables, export page.
- **Selection:** copy, copy as SVG, cut, paste here, duplicate, delete;
  *Select layer* (submenu of every layer under the pointer, top-most first),
  select parent, select children; *Order* submenu (bring to front, forward,
  backward, send to back); group, frame selection, ungroup; add/remove auto
  layout; create component — or for instances: go to main component, reset
  changes, detach; show/hide, lock/unlock, rename; zoom to selection,
  export PNG.
- The same selection menu opens from a right-click on a row in the layer
  tree.
- The menu stays inside the window, opens submenus on hover or with the
  right arrow key, and is fully usable from the keyboard (arrows, Enter,
  Esc). It closes on Esc, on a click elsewhere, on scroll and when the window
  loses focus.
- Ctrl/Cmd+R renames the selected layer (in the layer tree).

## 6. Auto layout

A frame can arrange its children automatically in a row or a column.

- **Add / remove.** Shift+A on a frame without auto layout turns it on; on
  any other selection it wraps the selection in a new, unfilled auto-layout
  frame. The direction is guessed from how the layers are spread out, and the
  children are re-ordered to match their current position along that axis.
  Alt+Shift+A removes auto layout (layers stay where they are).
- **Settings** (per frame): direction (horizontal / vertical), spacing
  between items, padding on each side, alignment along the main axis (start,
  centre, end or *space between*) and across it (start, centre, end).
- **Sizing** (per layer, per axis):
  - *Fixed* — the size does not change by itself;
  - *Hug* — an auto-layout frame shrinks or grows to fit its content plus
    padding; for text, hug width means auto width and hug height means
    auto height;
  - *Fill* — a child of an auto-layout frame stretches to take the remaining
    space on the main axis (shared equally between fill items) or the full
    content box on the cross axis.
  Resizing a layer by hand on an axis switches that axis to *Fixed*.
- **Ignore auto layout.** A child can opt out; it then keeps a free position
  inside the frame.
- Hidden children take no space.
- Rotated children take the space of their rotated bounding box.
- **Re-ordering.** Dragging a child shows an insertion line; dropping inside
  an auto-layout frame inserts the layer at that position (this also moves
  layers in from elsewhere). Dropping outside takes it out of the frame.
  Arrow keys along the main axis move a child one place earlier or later.
- Child X/Y are controlled by the layout and are read-only in the panel.

## 7. Components and instances

- **Component.** A reusable frame-like layer (the *main component*).
  Ctrl/Cmd+Alt+K turns a selected frame into a component, or wraps any other
  selection in a new component. Components can be edited like frames.
- **Instance.** A linked copy of a component. Instances are created from the
  *Assets* tab (click to place at the centre of the view, or drag onto the
  canvas) or with *Create instance* in the properties of a component.
  Copying/duplicating an instance makes another instance of the same
  component. An instance cannot be placed inside its own component.
- **Propagation.** Every change to the main component (layers added, removed,
  re-ordered, restyled, resized) is reflected in all its instances
  immediately, on every page.
- **Overrides.** Inside an instance, layers can be selected (double-click to
  enter, as with groups) and their *appearance* changed: fills, strokes,
  opacity, visibility, corner radius, text content and text style, names and
  variable bindings. Each changed property becomes an override and no longer
  follows the component; everything else keeps following it. Layers inside
  an instance cannot be moved, resized, deleted, re-ordered or re-parented,
  and nothing can be dropped into an instance.
- The instance's own position, rotation, name, visibility, opacity and
  layout placement are its own. Resizing an instance overrides its size.
- **Reset overrides** restores an instance to match its component.
- **Detach instance** (Ctrl/Cmd+Alt+B) turns an instance into a plain frame.
  Instances nested inside it stay linked to their own components.
- **Go to main component** selects the component, switching page if needed.
- If a main component is deleted, its instances keep their last appearance.
- Components and instances are marked with their own icons and a distinct
  colour in the layer tree and on the canvas.

### Component properties

A main component can declare **properties** — named inputs that each
instance sets for itself:

| Type | Drives | Default |
| --- | --- | --- |
| Text | the content of text layers | the text it was created from |
| Boolean | the visibility of layers | on |
| Instance swap | which component a nested instance shows | the nested instance's component |

- **Creating.** In the main component, select a layer inside it and use
  *Create property* next to the content, visibility or swap field (the
  property starts with the layer's current value), or add a property in the
  component's *Properties* section and bind layers to it afterwards. Several
  layers may share one property.
- **Main component.** Bound layers show the property's default. Editing a
  bound text in the main component (typing, or the panel) changes the
  default; so does toggling a bound layer's visibility.
- **Instances.** The *Properties* section of an instance lists every
  property of its component with a text box, a switch or a component picker.
  Typing into a bound text layer inside an instance, or toggling a bound
  layer's visibility there, sets the instance's property value instead of
  creating an override. Instances that never set a property follow the
  default.
- **Instance swap** offers every component except ones that would nest the
  component inside itself. Changes made inside a swapped nested instance are
  lost when it is swapped.
- Renaming a property or changing its default updates all instances at once.
  Deleting a property unbinds its layers and keeps their current values.
- Properties can be combined with variables; when both drive the same value,
  the variable wins.

### Variants

A **component set** groups related components — its **variants** — that
differ along one or more **variant properties** (for example *Type* =
Primary / Secondary and *Size* = Small / Large).

- **Combining.** Selecting two or more components that are not yet in a set
  and choosing *Combine as variants* wraps them in a component set. Each
  becomes a variant with a property *Property 1* whose value is its former
  name. Component properties of the combined components move to the set and
  are shared by all variants.
- **Variant names** are generated from their values (`Type=Primary,
  Size=Small`) and kept in sync.
- **Set panel:** list of variant properties (rename, remove, add — a new
  property starts as *Default* on every variant), *Add variant* (duplicates
  the last variant next to it with a new value) and the shared component
  properties.
- **Variant panel:** a value field for each variant property, plus the
  usual main-component actions.
- **Instances** of any variant show one selector per variant property,
  listing every value used in the set. Picking a value switches the instance
  to the variant matching all chosen values (or, if none matches exactly, the
  closest one with the picked value). Overrides on layers whose names match in
  the new variant are kept; component property values are kept because
  properties belong to the set.
- **Assets** list a set once; placing it creates an instance of its first
  variant. Instance-swap pickers list variants as *Set / Variant*.
- On the canvas a set is shown with a dashed outline in the component colour
  and its name label; its variants are selected like layers in a frame.
- Ungrouping or deleting a set follows the usual rules for frames.

## 8. Variables

- A document has a list of **variables**, each with a name, a type
  (*color*, *number*, *string* or *boolean*) and one value per **mode**
  (for example *Light* and *Dark*). There is always at least one mode.
- Variables are managed in the *Variables* dialog (toolbar button): add,
  rename, delete variables; add, rename, delete modes; edit values.
- **Binding.** Properties can be bound to a variable of a matching type:
  - colour → solid fills and strokes;
  - number → width, height, corner radius, stroke width, auto-layout spacing
    and padding, font size, line height;
  - string → text content;
  - boolean → visibility.
  A bound property shows the variable's name and always takes the variable's
  value. Editing the property by hand (or resizing on canvas) removes the
  binding. Deleting a variable removes its bindings and leaves the last
  values in place.
- **Modes.** Pages, frames, components and instances can choose a mode;
  layers inside use the nearest chosen mode, falling back to the first mode.
  Switching a frame from *Light* to *Dark* re-resolves every binding inside.

## 9. Panels

- **Toolbar** (top): main menu (new, open, save, export, undo, redo),
  tools, editable document name, zoom menu.
- **Left sidebar**: page list (add, rename by double-click, delete when more
  than one), an *Assets* tab listing components with thumbnails, and a layer tree for the current page. The layer tree shows the
  top-most layer first, supports expand/collapse, multi-select, rename by
  double-click, visibility and lock toggles, and drag and drop to reorder or
  re-parent.
- **Right sidebar** (properties):
  - nothing selected: page background colour;
  - alignment (left, centre, right, top, middle, bottom) for two or more
    layers, or relative to the parent for one layer;
  - X, Y, W, H, rotation, corner radius, clip content;
  - opacity;
  - fills and strokes (add, remove, hide, colour, opacity, stroke width);
  - effects: drop and inner shadows (offset, blur, spread, colour, opacity), layer blur and background blur;
  - text settings (family — free text with suggestions, size, weight, line height, horizontal and
    vertical alignment, sizing mode: auto width / auto height / fixed size);
  - export (PNG at 1×/2×/3× or SVG) for the selection, or for the whole page
    when nothing is selected.
- Numeric fields accept arithmetic (`100+20`, `50*2`) and can be scrubbed by
  dragging their label.

## 10. Files

- The document autosaves to browser storage and is restored on reload.
- *Save* downloads a `.planar.json` file; *Open* loads one.
  The format is documented in [`FILE_FORMAT.md`](FILE_FORMAT.md).
- Unknown or invalid files are rejected with a message; the current document
  is not changed.

## 11. Real-time collaboration

Several people can edit the same document at once through a self-hosted
Planar server (see [SELF_HOSTING.md](SELF_HOSTING.md); wire protocol in
[PROTOCOL.md](PROTOCOL.md)).

- **Accounts and files.** When the editor is served by a Planar server it
  shows a sign-in screen (open registration: username, display name,
  password) and then a file list with *My files*, *Shared with me* and
  *Trash*. A file has a name, a thumbnail, an owner and a last-edited time.
  Files can be created, imported from `.planar.json`, renamed, duplicated,
  downloaded, shared, moved to the trash, restored and deleted for good.
  Every file opens at its own address (`/file/<id>`). Without a server the
  editor works on a local draft as before.
- **Roles.** The *owner* can do everything, including trashing, deleting and
  handing the file to someone else. An *editor* edits, renames and shares
  (invites, changes roles, sets link access) but cannot delete or take over.
  A *viewer* can look, select, inspect, copy code and export, and copy the
  file into their own files; every attempt to change it is refused and the
  toolbar says "View only".
- **Sharing.** *Share* opens a dialog: invite by username (with suggestions)
  as editor or viewer, change or remove people, choose link access — only
  invited people, anyone with the link can view, or anyone with the link can
  edit — and copy the link. People without an account can open link-shared
  files as guests ("Guest N"). Changes to access apply immediately to people
  who have the file open (a role change updates their editor; removing access
  closes it).
- **Live editing.** Every change — including moves and resizes while they
  are being dragged — appears for everyone within a fraction of a second.
  Changes are exchanged per layer (and per document-level list: pages,
  variables, modes, the name). When two people change the same layer at the
  same moment, the change the server receives last wins, and everyone ends
  up with the same result. Concurrent structural edits (for example two
  people adding layers to one frame, or one deleting a frame another is
  editing inside) are reconciled so the layer tree stays valid.
- **Undo** only undoes your own changes, layer by layer; it never reverts
  what others did to other layers.
- **Presence.** Everyone gets a colour. Other people's pointers are shown
  with their name, and their selections are outlined in their colour, on
  the page they are looking at. The toolbar shows an avatar per person;
  clicking it jumps to their page and pointer. A dot shows the connection
  state.
- **Connection loss.** Editing continues offline; on reconnection the
  latest server version is loaded and changes made in the meantime are
  re-applied on top of it and sent.
- **Persistence.** The server keeps files on disk and restores them after a
  restart. In a server file the server copy is the source of truth; local
  autosave is not used.
- **Access.** File ids are unguessable, and access is decided by roles and
  link access, never by a shared secret. There is no server-wide token.

## 12. AI agents (MCP) and code

- Planar provides an MCP server for AI agents, locally over stdio (on a
  file or on server files) and remotely at `/mcp` on a Planar server (server
  files only, no local file access). Agents authenticate with a personal API
  key and have their owner's rights. Tools and vocabulary are specified in [MCP.md](MCP.md).
- Agents can create, rename, delete and switch pages, import SVG markup as
  vector layers, and render pages or layers with the document's web fonts.
- Agent edits are ordinary edits: in a room the agent is a participant
  named *Agent* with its own pointer and selection, and its changes are
  undoable by the agent.
- The properties panel has a **Code** section (collapsed by default) that
  shows React + CSS, HTML + CSS, CSS, or the CSS design tokens for the
  selected layer, with a copy button. It uses the same generator as the
  agent `code` tool.

## 13. Out of scope (roadmap)

Variable collections and aliases, boolean operations, Bézier curve editing, gradients, plugins.

## Prototypes and presentation

A layer can link to another top-level frame of its page (`link`, see FILE_FORMAT). The editor shows arrows from the selected layers to their targets and a Prototype section in the properties panel. Present (`/file/<id>/present?frame=<id>`, also by link for viewers and guests) shows one screen at a time scaled to the window: clicking a layer with a link (or inside one) goes to the target with the chosen animation, arrow keys step through screens in layer order, Backspace goes back, Esc leaves. A click that hits nothing briefly highlights the clickable areas.

## Developer export and inspect

Export (properties panel) offers PNG, SVG and PDF. With several layers or screens selected (or nothing selected: every screen of the page), "One file per layer" produces a ZIP, and PDF has one page per layer, sized like it. Inspect shows size, position, radius, gap, padding, font and colours (with variable names) that copy on click, and red distances from the selected layer to the one under the pointer; viewers have it on by default. `GET /api/files/:id/export.zip?format=png|svg|pdf&scale=2&page=<name or id>` returns every screen of a page the same way (PNG and PDF need the optional `@napi-rs/canvas` on the server), for scripts and CI.

## Constraints and wrapping

Layers in a frame without auto layout (or ignoring it) have horizontal and vertical constraints: left, right, left and right (stretch), center, or scale (top, bottom, top and bottom, center, scale vertically). Resizing the frame by handle, in the panel or by an agent moves and stretches its layers accordingly, through nested frames. A resized instance places its layers by their constraints starting from the main component's layout; layers moved or resized inside the instance stay where they were put. The Constraints section shows a pin diagram and two menus. A horizontal auto layout can wrap: items continue on new rows (with their own row spacing) when they do not fit the frame's width; a frame that hugs its width never wraps.

## Styles

Text styles (font family, size, weight, line height) and effect styles (shadows and blurs) are named, shared settings. "Create style…" in the style menu of the Text or Effects section makes one from the selected layer and applies it; the menu also applies an existing style or detaches the layer. Layers follow later changes to their style; editing a styled setting by hand detaches the layer, and deleting a style leaves layers looking the same. The Assets tab lists styles with a preview and usage count: click to apply to the selection, double-click to rename, update from the selected layer, or delete.

## Team libraries

"Team libraries…" (main menu, or the button in Assets) publishes the open file's components, variables and styles as a library, republishes changes with a new version, or unpublishes. The same dialog lists libraries published in files you work with: "Add to file" copies one in (its components appear in Assets with the library's name and insert like local ones), "Update" brings a newer version in while instances keep their overrides, and "Remove" turns its instances into ordinary layers. "Go to main component" on a library instance opens the library file.

## Importing Figma files

"Import from Figma…" on the Files page converts a Figma design file read through the Figma REST API with the user's own token (in the browser; the token is not stored), or the API's JSON saved by the user, into a new Planar file, and lists what was simplified. See FIGMA_IMPORT.md.

## Context notes

The file has a brief and every layer and page has context notes (markdown), edited in the Properties panel (the brief and page notes show when nothing is selected). Layers with notes show an icon in the Layers panel. An instance keeps its own notes and shows its main component's notes as documentation. AI agents read the chain from the file brief down to a layer with the `context` tool and write decisions back; generated React code carries a component's notes as JSDoc. Figma component descriptions are imported as notes.

## Annotations

The notes button in the toolbar adds annotation layers in the middle of the view: a sticky note (colour, author), a text description rendered from markdown, a chat (messages with author and time, written in the Properties panel; Enter sends), a checklist (items with checkboxes and progress) and a callout (a label with a dashed arrow to the selected layer, changeable under "Points at"). Double-click a note to write in it. "Hide annotations" in the same menu hides them and makes them unpickable for this viewer. Annotations are synced, versioned and seen by AI agents (screenshots include them), but are not exported, presented or turned into code. FigJam sticky notes are imported as sticky notes.

## Agents and annotations

Mentioning @ai in a chat message or a note leaves a request for AI agents connected to the file: the MCP `notes` tool lists open requests (`inbox`), and an agent answers in the chat (`post`), which closes the request. Agents add sticky notes, descriptions, checklists and callouts of their own, tick checklist items, and see the notes around a screen when they read its context. See MCP.md.

## Auto layout panel and grids

For a frame with auto layout, the Auto layout section holds everything about it: direction (vertical, horizontal, grid) and Wrap; dimensions (W, H with an aspect-ratio lock, and Fixed / Hug / Fill on each axis); a 3×3 alignment grid; the gap with "Fixed gap" or "Auto" (space between); paddings as horizontal and vertical pairs, or per side; whether strokes take up space (Strokes: Included / Excluded); which item is on top (Canvas stacking: Last on top / First on top); and Clip content. A grid lays items out row by row in a set number of columns (and optionally rows) with column and row gaps; arrow keys move an item by a cell or a row, and dragged layers drop in reading order. Code export uses CSS grid. The aspect-ratio lock also applies to resize handles (Shift then frees the ratio).

## Side panels

The Layers and Properties panels are resized by dragging their inner edge (180–560 px; double-click restores 248 px) and hidden from the main menu, or both at once with Ctrl/⌘+\. Widths and visibility are remembered per browser.

## Toolbar

As in Figma, the top bar holds only the main menu, the file name, the people in the file, Present, Share and zoom; version history, variables, undo/redo and panel visibility are in the main menu. The tools float at the bottom of the canvas: Move/Hand, Frame, shapes (Rectangle, Ellipse, Line), Pen, Text, Comment and the notes menu. A group shows its active or last used tool; its arrow lists the others.

## API requests

"API requests…" in the main menu opens a small HTTP client for checking the APIs a design talks to. The left column is the history; the right side builds a request: a method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS), a URL (a pasted query string moves into Params when the field loses focus), and tabs for Params, Headers and Body (None, JSON, Text or Form fields). Rows of params, headers and form fields can be switched off without deleting them. Send (Enter in the URL, Ctrl/⌘+Enter in the body) shows the status, time, size and content type, and the body (JSON indented) or the response headers. A JSON body that does not parse is refused before sending; GET and HEAD never send a body.

Every sent request is saved with its response (or the error) in the file's `requests` (see FILE_FORMAT), newest first, with who sent it and when: up to 50 entries, response bodies cut to 100 KB. The history is synced live and versioned with the file, so everyone who can open it sees it, headers and tokens included; changes to it are not undo steps. Click an entry to open its request and response, double-click to rename it, use the bin to delete it, or "Clear history". In a view-only file requests can still be sent but are not saved.

On a Planar server, signed-in people can send through the server (on by default), so APIs that do not allow browsers (CORS) work: `POST /api/http-proxy` with `{method, url, headers: [[name, value]], body?}` returns `{response: {status, statusText, headers, body, truncated, size, time}}`. It needs a session (not an API key), does not follow redirects, gives up after 30 s, cuts bodies at 1 MB, and refuses loopback, private and link-local addresses unless the server runs with `PROXY_PRIVATE_HOSTS=1`. Without a server, or signed out, requests go straight from the browser.
