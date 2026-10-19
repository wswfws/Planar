import { useEffect, useRef } from 'react';
import { listComponents } from '../core/components';
import { getPageOf } from '../core/document';
import { localMatrix } from '../core/geometry';
import { invert } from '../core/math';
import { drawNode } from '../core/render';
import type { SceneNode } from '../core/types';
import { useEditorState } from './EditorContext';

export const COMPONENT_DRAG_TYPE = 'application/x-planar-component';

function Thumbnail({ node, version }: { node: SceneNode; version: number }) {
  const editor = useEditorState();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 56;
    const H = 40;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pad = 4;
    const s = Math.min((W - pad * 2) / Math.max(node.width, 1), (H - pad * 2) / Math.max(node.height, 1));
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (W - node.width * s) / 2, dpr * (H - node.height * s) / 2);
    // Draw the component in its own space, ignoring where it sits on the canvas.
    ctx.transform(...invert(localMatrix(node)));
    drawNode(ctx, editor.doc, node.id);
  }, [node, version, editor]);
  return <canvas ref={ref} className="thumb" style={{ width: 56, height: 40 }} />;
}

export function AssetsPanel() {
  const editor = useEditorState();
  const components = listComponents(editor.doc).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="assets">
      {components.length ? (
        <ul className="asset-list">
          {components.map((c) => {
            const page = getPageOf(editor.doc, c.id);
            return (
              <li
                key={c.id}
                className="asset"
                draggable
                title="Click to insert, or drag onto the canvas"
                onClick={() => {
                  if (!editor.createInstance(c.id)) editor.notify('Could not insert this component here');
                }}
                onDragStart={(e) => {
                  e.dataTransfer.setData(COMPONENT_DRAG_TYPE, c.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <Thumbnail node={c} version={editor.version} />
                <span className="asset-text">
                  <span className="component-name">{c.name}</span>
                  {page && page.id !== editor.pageId && <span className="asset-page">{page.name}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty-hint">
          No components yet. Select layers and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>K</kbd> to create one.
        </p>
      )}
    </div>
  );
}
