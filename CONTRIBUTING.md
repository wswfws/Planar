# Contributing to Planar

Thanks for helping! Before writing code, read [CLEAN_ROOM.md](CLEAN_ROOM.md):
every contribution must follow the clean-room rules described there.

## Workflow

1. Describe new behaviour in [`docs/SPEC.md`](docs/SPEC.md) first, in generic
   terms (what the user sees and does). Spec-only PRs are welcome.
2. Implement it from the spec.
3. Add or update tests in `tests/`.
4. Run `npm test` and `npm run build` before opening a PR.

## Project layout

```
src/core/      editor engine, no React
  math.ts        vectors, affine matrices, rectangles
  types.ts       document model
  document.ts    tree operations, ids, file validation
  geometry.ts    transforms, bounds, hit testing, group fitting
  text.ts        text layout and measurement
  render.ts      Canvas 2D renderer
  overlay.ts     selection, handles, guides, marquee
  interaction.ts pointer tools: move, resize, rotate, create, pen
  editor.ts      editor state, undo/redo, commands, files
  export.ts      PNG and SVG export
src/ui/        React panels and canvas host
tests/         Vitest unit tests
docs/          specification and file format
```

## Pull request checklist

- [ ] I followed the rules in `CLEAN_ROOM.md` (no proprietary code, no reverse
      engineering, no third-party assets, no trademarks).
- [ ] The behaviour is described in `docs/SPEC.md`.
- [ ] `npm test` and `npm run build` pass.
