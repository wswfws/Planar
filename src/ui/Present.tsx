import { useCallback, useEffect, useRef, useState } from 'react';
import { drawNode, setImageLoadListener } from '../core/render';
import { linksOnPage, nextScreen, screenOf, screensOf, stepScreen, type Transition } from '../core/prototype';
import { worldMatrix } from '../core/geometry';
import { apply } from '../core/math';
import { useEditorState } from './EditorContext';
import { navigate, useLocation } from './router';

const ANIMATION_MS = 280;

interface Anim {
  from: string;
  to: string;
  transition: Transition;
  start: number;
}

/** Full-screen prototype: shows one screen at a time and follows links on click. */
export function Present({ fileId }: { fileId: string }) {
  const editor = useEditorState();
  const { search } = useLocation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screens = screensOf(editor.doc, editor.pageId);
  const wanted = search.get('frame');
  const [current, setCurrent] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [hint, setHint] = useState(0);
  const [copied, setCopied] = useState(false);
  const anim = useRef<Anim | null>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const ready = editor.collab?.status === 'connected' || editor.collab?.status === 'reconnecting';

  // Start where asked (the frame in the link), else on the first screen.
  useEffect(() => {
    if (!ready || current) return;
    const first = (wanted && screenOf(editor.doc, wanted)) || screens[0] || null;
    if (first) setCurrent(first);
  }, [ready, current, wanted, screens, editor.doc]);

  // A screen deleted by someone else while presenting.
  const shown = current && editor.doc.nodes[current] ? current : (screens[0] ?? null);

  const layout = (id: string) => {
    const { w, h } = size.current;
    const f = editor.doc.nodes[id];
    const scale = Math.min(w / f.width, h / f.height);
    return { scale, ox: (w - f.width * scale) / 2, oy: (h - f.height * scale) / 2, frame: f };
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !shown) return;
    const { w, dpr } = size.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d0d10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const paint = (id: string, dx: number, alpha: number) => {
      const f = editor.doc.nodes[id];
      if (!f) return;
      const { scale, ox, oy } = layout(id);
      ctx.save();
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + dx), dpr * oy);
      ctx.translate(-f.x, -f.y);
      ctx.beginPath();
      ctx.rect(f.x, f.y, f.width, f.height);
      ctx.clip();
      ctx.globalAlpha = alpha;
      drawNode(ctx, editor.doc, id);
      ctx.restore();
    };
    const a = anim.current;
    if (a && editor.doc.nodes[a.from]) {
      const t = Math.min(1, (performance.now() - a.start) / ANIMATION_MS);
      const e = 1 - (1 - t) ** 3;
      if (a.transition === 'slide') {
        paint(a.from, -w * e, 1);
        paint(a.to, w * (1 - e), 1);
      } else {
        paint(a.from, 0, 1);
        paint(a.to, 0, e);
      }
      if (t < 1) requestAnimationFrame(draw);
      else anim.current = null;
    } else {
      paint(shown, 0, 1);
    }
    // Clickable areas, shown briefly after a click that led nowhere.
    if (hint && performance.now() - hint < 900) {
      const { scale, ox, oy, frame } = layout(shown);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = 'rgba(123, 123, 240, 0.25)';
      ctx.strokeStyle = '#7b7bf0';
      ctx.lineWidth = 2;
      for (const l of linksOnPage(editor.doc, editor.pageId)) {
        if (screenOf(editor.doc, l.from) !== shown) continue;
        const n = editor.doc.nodes[l.from];
        const p = apply(worldMatrix(editor.doc, l.from), { x: 0, y: 0 });
        const x = ox + (p.x - frame.x) * scale;
        const y = oy + (p.y - frame.y) * scale;
        ctx.fillRect(x, y, n.width * scale, n.height * scale);
        ctx.strokeRect(x, y, n.width * scale, n.height * scale);
      }
      setTimeout(() => requestAnimationFrame(draw), 950);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, shown, hint]);

  // Size the canvas to the window.
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: window.innerWidth, h: window.innerHeight, dpr };
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      draw();
    };
    resize();
    window.addEventListener('resize', resize);
    setImageLoadListener(draw);
    const unsubscribe = editor.subscribe(draw);
    return () => {
      window.removeEventListener('resize', resize);
      setImageLoadListener(null);
      unsubscribe();
    };
  }, [editor, draw]);

  useEffect(draw, [draw, shown, ready]);

  const go = useCallback(
    (to: string, transition: Transition = 'instant', push = true) => {
      if (!shown || to === shown) return;
      if (transition !== 'instant') anim.current = { from: shown, to, transition, start: performance.now() };
      if (push) setHistory((h) => [...h, shown]);
      setCurrent(to);
      requestAnimationFrame(draw);
    },
    [shown, draw],
  );

  const back = useCallback(() => {
    const prev = history[history.length - 1];
    if (!prev || !editor.doc.nodes[prev]) return;
    setHistory((h) => h.slice(0, -1));
    go(prev, 'instant', false);
  }, [history, editor, go]);

  const exit = useCallback(() => navigate(`/file/${fileId}`), [fileId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shown) return;
      if (e.key === 'Escape') exit();
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        const next = stepScreen(editor.doc, editor.pageId, shown, 1);
        if (next) go(next);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        const prev = stepScreen(editor.doc, editor.pageId, shown, -1);
        if (prev) go(prev);
      } else if (e.key === 'Backspace') back();
      else if (e.key === 'Home' && screens[0]) {
        setHistory([]);
        go(screens[0], 'instant', false);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, editor, screens, go, back, exit]);

  const click = (e: React.PointerEvent) => {
    if (!shown) return;
    const { scale, ox, oy, frame } = layout(shown);
    const point = { x: frame.x + (e.clientX - ox) / scale, y: frame.y + (e.clientY - oy) / scale };
    const hit = nextScreen(editor.doc, shown, point);
    if (hit) go(hit.to, hit.transition);
    else setHint(performance.now());
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/file/${fileId}/present?frame=${shown ?? ''}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      editor.notify('Copy the address from the browser bar');
    }
  };

  const index = shown ? screens.indexOf(shown) : -1;
  return (
    <div className="present">
      <canvas ref={canvasRef} className="present-canvas" onPointerDown={click} />
      {ready && !screens.length && <div className="overlay-page">This page has no screens. Draw a frame in the editor to present it.</div>}
      <div className="present-bar">
        <button type="button" className="small-button" disabled={!history.length} onClick={back} title="Back (Backspace)">
          Back
        </button>
        <span className="hint">
          {shown ? editor.doc.nodes[shown].name : ''} {index >= 0 ? `· ${index + 1}/${screens.length}` : ''}
        </span>
        <button type="button" className="small-button" onClick={copyLink}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <button type="button" className="small-button" onClick={exit} title="Exit (Esc)">
          Exit
        </button>
      </div>
    </div>
  );
}
