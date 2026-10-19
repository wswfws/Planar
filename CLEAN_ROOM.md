# Clean-room policy

Planar is an independent, open-source vector design editor. It offers features
that are common across the whole category of collaborative interface-design
tools (Figma, Sketch, Penpot, Adobe XD, Inkscape and others), and it was built
using a **clean-room** process so that it contains no code, assets or
proprietary formats belonging to any of those products.

This document describes how the project was built and the rules every
contributor must follow.

## What "clean room" means here

A clean-room implementation separates two activities:

1. **Specification.** Describe *what* the software must do, using only public,
   non-confidential information: general domain knowledge of vector editors,
   publicly documented user-facing behaviour, common keyboard conventions and
   standard computer-graphics techniques. The result is
   [`docs/SPEC.md`](docs/SPEC.md).
2. **Implementation.** Write the software *only* from that specification and
   from public, openly licensed references (MDN, the HTML Canvas and SVG
   specifications, the TypeScript and React documentation, textbook geometry).

The implementation never looks at, copies, translates or derives from another
product's source code, binaries, minified bundles, network protocols, file
formats or internal APIs.

## How Planar v0.1 was produced

- The functional specification (`docs/SPEC.md`) was written first, phrased in
  terms of generic editor behaviour (frames, shapes, layers, properties,
  undo, export) rather than any product's internals.
- The code was then written from the spec, using only the browser platform
  APIs (Canvas 2D, SVG, DOM events) and the public React API.
- No proprietary product was decompiled, disassembled, inspected through
  developer tools, or reverse-engineered. No proprietary API, plugin API or
  file format (for example `.fig`) was used or reproduced.
- No third-party design assets were used. All icons are original SVG paths
  drawn for this project; the UI uses system fonts.
- The native file format (`.planar.json`) is an original, documented JSON
  schema (see [`docs/FILE_FORMAT.md`](docs/FILE_FORMAT.md)).
- The visual design of the UI is Planar's own. Keyboard shortcuts follow
  conventions shared across many graphics tools (V for move, R for rectangle,
  Ctrl+G for group and so on); such functional conventions are not copied
  expression.

**Honesty note:** v0.1 was written by a single author (an AI coding assistant
working for the repository owner) in two sequential phases (spec, then code)
rather than by two physically separate teams. The rules below keep future
work in line with the stricter two-team model as far as an open project can.

## Rules for contributors

By opening a pull request you confirm that:

1. **No proprietary code.** You have not copied, translated or adapted source
   code, minified JavaScript, WebAssembly, shaders or binaries from Figma or
   any other proprietary design tool, and you have not read such code in order
   to write your contribution.
2. **No reverse engineering.** You have not decompiled, disassembled, sniffed
   network traffic of, or otherwise reverse-engineered a proprietary product
   to produce your contribution. Do not add importers or exporters for
   undocumented proprietary formats.
3. **No confidential information.** You are not using knowledge gained under
   an NDA, an employment contract or other confidentiality obligation with a
   design-tool vendor.
4. **No third-party assets.** Icons, illustrations, fonts, cursors, sample
   files and screenshots are your own or come with a compatible open licence
   that is noted in the PR.
5. **No trademarks.** Do not use other products' names, logos or trade dress in
   the UI, in assets or in marketing. Naming other tools in documentation for
   comparison is fine.
6. **Spec first.** New behaviour is first described in `docs/SPEC.md` in
   generic terms (what the user sees and does), and the code is written from
   that description.

If you previously worked on the internals of a proprietary design tool, please
limit yourself to specification review, documentation and tests for areas
related to that work, and say so in your PR.

## Trademarks

"Figma" is a trademark of Figma, Inc. Planar is not affiliated with, endorsed
by or sponsored by Figma, Inc. or any other vendor mentioned in this
repository.
