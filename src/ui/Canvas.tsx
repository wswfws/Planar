import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { worldMatrix } from '../core/geometry';
import { Interaction, type PointerInput } from '../core/interaction';
import { drawOverlay } from '../core/overlay';
import { drawPage, setImageLoadListener } from '../core/render';
import { lineHeightPx, verticalOffset } from '../core/text';
import { COMPONENT_DRAG_TYPE } from './AssetsPanel';
import { useContextMenu } from './ContextMenu';
import { useEditor, useEditorState } from './EditorContext';
import { canvasMenu, selectionMenu } from './menus';

export function readImageFile(file: File): Promise<{ src: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => resolve({ src, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('Unsupported image'));
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

export function Canvas({ onOpenVariables }: { onOpenVariables: () => void }) {
  const editor = useEditor();
  const openMenu = useContextMenu();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const interaction = useMemo(() => new Interaction(editor), [editor]);
  const [cursor, setCursor] = useState('default');

  // Size the canvas to its container.
  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      editor.setCanvasSize(width, height);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [editor]);

  // Repaint on every editor change, at most once per frame.
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = 0;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const { viewport: v } = editor;
      const bg = editor.page.fills.find((f) => f.visible && f.type === 'solid');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = bg && bg.type === 'solid' ? bg.color : '#1e1e24';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, dpr * v.x, dpr * v.y);
      drawPage(ctx, editor.doc, editor.pageId, {
        hidden: editor.editingTextId ? new Set([editor.editingTextId]) : undefined,
        annotations: editor.showAnnotations,
      });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawOverlay(ctx, editor, dpr);
      setCursor(interaction.cursor());
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    setImageLoadListener(schedule);
    const unsubscribe = editor.subscribe(schedule);
    const unsubscribeRedraw = editor.onRedraw(schedule);
    schedule();
    return () => {
      unsubscribe();
      unsubscribeRedraw();
      setImageLoadListener(null);
      cancelAnimationFrame(frame);
    };
  }, [editor, interaction]);

  // Wheel needs a non-passive listener to prevent browser zoom/scroll.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        editor.zoomAt(pt, editor.viewport.zoom * Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01));
      } else if (e.shiftKey && !dx) {
        editor.panBy(-dy, 0);
      } else {
        editor.panBy(-dx, -dy);
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [editor]);

  const input = (e: ReactPointerEvent | React.MouseEvent): PointerInput => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      screen: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: e.ctrlKey || e.metaKey,
    };
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const at = editor.screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const componentId = e.dataTransfer.getData(COMPONENT_DRAG_TYPE);
    if (componentId) {
      editor.createInstance(componentId, at);
      return;
    }
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
        editor.importSvg(await file.text(), at, file.name.replace(/\.svg$/i, ''));
      } else if (file.type.startsWith('image/')) {
        try {
          const img = await readImageFile(file);
          editor.placeImage(img.src, img.width, img.height, at);
        } catch {
          editor.notify(`Could not read ${file.name}`);
        }
      } else if (file.name.endsWith('.json')) {
        editor.openFile(await file.text());
      }
    }
  };

  return (
    <div className="canvas-wrap" ref={wrapRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <canvas
        ref={canvasRef}
        className="canvas"
        style={{ cursor }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          interaction.pointerDown(input(e));
          setCursor(interaction.cursor());
        }}
        onPointerMove={(e) => {
          const pi = input(e);
          editor.setPointer(editor.screenToWorld(pi.screen));
          interaction.pointerMove(pi);
          setCursor(interaction.cursor());
        }}
        onPointerUp={(e) => {
          interaction.pointerUp(input(e));
          setCursor(interaction.cursor());
        }}
        onPointerLeave={() => {
          editor.setPointer(null);
          if (editor.hoverId && !interaction.drag) {
            editor.hoverId = null;
            editor.emit();
          }
        }}
        // Keep the browser from moving focus on mousedown, which would
        // immediately blur a text editor opened by this click.
        onMouseDown={(e) => e.preventDefault()}
        onDoubleClick={(e) => interaction.doubleClick(input(e))}
        onContextMenu={(e) => {
          e.preventDefault();
          const rect = canvasRef.current!.getBoundingClientRect();
          const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          const kind = interaction.contextSelect(screen);
          const at = editor.screenToWorld(screen);
          openMenu(e.clientX, e.clientY, kind === 'selection' ? selectionMenu(editor, at) : canvasMenu(editor, at, onOpenVariables));
        }}
      />
      <TextEditor />
    </div>
  );
}

function TextEditor() {
  const editor = useEditorState();
  const id = editor.editingTextId;
  const node = id ? editor.doc.nodes[id] : null;
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [id]);

  if (!node) return null;
  const m = worldMatrix(editor.doc, node.id);
  const { zoom: z, x: vx, y: vy } = editor.viewport;
  const transform = `matrix(${m[0] * z}, ${m[1] * z}, ${m[2] * z}, ${m[3] * z}, ${m[4] * z + vx}, ${m[5] * z + vy})`;
  const fill = node.fills.find((f) => f.visible && f.type === 'solid');

  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={node.characters}
      spellCheck={false}
      style={{
        transform,
        width: (node.autoWidth ? node.width + node.fontSize : node.width) + 'px',
        height: node.height + 'px',
        paddingTop: Math.max(0, verticalOffset(node)) + 'px',
        font: `${node.fontWeight} ${node.fontSize}px ${node.fontFamily}`,
        lineHeight: `${lineHeightPx(node)}px`,
        textAlign: node.textAlign,
        color: fill && fill.type === 'solid' ? fill.color : '#000',
        whiteSpace: node.autoWidth ? 'pre' : 'pre-wrap',
      }}
      onChange={(e) => editor.setText(node.id, e.target.value)}
      onBlur={() => editor.finishTextEditing()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          editor.finishTextEditing();
        }
      }}
    />
  );
}
