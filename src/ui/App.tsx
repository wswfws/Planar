import { useEffect, useMemo, useRef, useState } from 'react';
import { createDocument } from '../core/document';
import { Editor, type Tool } from '../core/editor';
import { Canvas, readImageFile } from './Canvas';
import { ContextMenuProvider } from './ContextMenu';
import { EditorContext, useEditorState } from './EditorContext';
import { LayersPanel } from './LayersPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { Toolbar } from './Toolbar';
import { VariablesDialog } from './VariablesDialog';
import { ShareDialog } from './ShareDialog';
import { VersionsDialog } from './VersionsDialog';
import { watchFonts } from './fontLoader';
import { looksLikeSvg } from '../core/svg';
import { openServerFile } from '../collab/session';
import { AccountDialog } from './AccountDialog';
import { navigate, useServer } from './router';

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'hand',
  f: 'frame',
  a: 'frame',
  r: 'rectangle',
  o: 'ellipse',
  l: 'line',
  p: 'pen',
  t: 'text',
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function useShortcuts(editor: Editor, openFile: () => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('.dialog')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (e.key === ' ') {
        e.preventDefault();
        if (!editor.spaceDown) {
          editor.spaceDown = true;
          editor.emit();
        }
        return;
      }

      if (mod) {
        let handled = true;
        if (key === 'z' && !e.shiftKey) editor.undo();
        else if ((key === 'z' && e.shiftKey) || key === 'y') editor.redo();
        else if (key === 'd') editor.duplicateSelection();
        else if (key === 'a') editor.selectAll();
        else if (key === 'k' && e.altKey) editor.createComponent();
        else if (key === 'b' && e.altKey) editor.detachInstances();
        else if (key === 'g' && e.altKey) editor.frameSelection();
        else if (key === 'g' && e.shiftKey) editor.ungroup();
        else if (key === 'g') editor.group();
        else if (e.code === 'BracketRight') editor.reorder(e.shiftKey ? 'front' : 'forward');
        else if (e.code === 'BracketLeft') editor.reorder(e.shiftKey ? 'back' : 'backward');
        else if (key === 'h' && e.shiftKey) editor.toggleVisible();
        else if (key === 'l' && e.shiftKey) editor.toggleLocked();
        else if (key === 'r' && !e.shiftKey && editor.selection.length === 1) editor.requestRename(editor.selection[0]);
        else if (key === 's') editor.saveFile();
        else if (key === 'o') openFile();
        else if (key === 'e' && e.shiftKey) editor.exportAs('png', 2);
        else if (key === '=' || key === '+') editor.zoomBy(2);
        else if (key === '-') editor.zoomBy(0.5);
        else if (key === '0') editor.zoomTo(1);
        else handled = false;
        if (handled) e.preventDefault();
        return;
      }

      if (e.shiftKey && (e.code === 'Digit0' || e.code === 'Digit1' || e.code === 'Digit2')) {
        e.preventDefault();
        if (e.code === 'Digit0') editor.zoomTo(1);
        if (e.code === 'Digit1') editor.zoomToFit();
        if (e.code === 'Digit2') editor.zoomToSelection();
        return;
      }

      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          editor.deleteSelection();
          return;
        case 'Escape':
          if (editor.tool === 'pen' && editor.overlay.pen?.points.length) editor.finishPen(false);
          else if (editor.tool !== 'select') editor.setTool('select');
          else editor.selectParent();
          return;
        case 'Enter':
          if (editor.tool === 'pen') editor.finishPen(false);
          else if (e.shiftKey) editor.selectParent();
          else if (editor.selection.length === 1 && editor.selectedNodes[0].type === 'text') editor.startTextEditing(editor.selection[0]);
          else editor.selectChildren();
          e.preventDefault();
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          editor.nudge(dx, dy);
          return;
        }
      }

      if (key === 'a' && e.shiftKey) {
        e.preventDefault();
        if (e.altKey) editor.removeAutoLayout();
        else editor.addAutoLayout();
        return;
      }

      if (!e.altKey && !e.shiftKey && TOOL_KEYS[key]) editor.setTool(TOOL_KEYS[key]);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && editor.spaceDown) {
        editor.spaceDown = false;
        editor.emit();
      }
    };

    const onCopy = (e: ClipboardEvent) => {
      if (isTyping(e.target) || !editor.selection.length) return;
      const text = e.type === 'cut' ? editor.cutSelection() : editor.copySelection();
      if (text) {
        e.clipboardData?.setData('text/plain', text);
        e.preventDefault();
      }
    };

    const onPaste = async (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const data = e.clipboardData;
      if (!data) return;
      e.preventDefault();
      const center = editor.screenToWorld({ x: editor.canvasSize.width / 2, y: editor.canvasSize.height / 2 });
      const svgFile = Array.from(data.files).find((f) => f.type === 'image/svg+xml');
      if (svgFile) {
        editor.importSvg(await svgFile.text(), center, svgFile.name.replace(/\.svg$/i, ''));
        return;
      }
      const image = Array.from(data.files).find((f) => f.type.startsWith('image/'));
      if (image) {
        const img = await readImageFile(image);
        const c = editor.screenToWorld({ x: editor.canvasSize.width / 2, y: editor.canvasSize.height / 2 });
        editor.placeImage(img.src, img.width, img.height, c);
        return;
      }
      const text = data.getData('text/plain');
      if (looksLikeSvg(text)) {
        editor.importSvg(text, center);
        return;
      }
      if (!editor.paste(text) && !text) editor.paste();
    };

    const onBlur = () => {
      editor.spaceDown = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCopy);
    window.addEventListener('paste', onPaste);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCopy);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('blur', onBlur);
    };
  }, [editor, openFile]);
}

function Toast() {
  const editor = useEditorState();
  return editor.message ? (
    <div className="toast" role="status">
      {editor.message}
    </div>
  ) : null;
}

/** Shown over the editor while a server file loads, or when it cannot be opened. */
function ConnectionOverlay() {
  const editor = useEditorState();
  const server = useServer();
  const collab = editor.collab;
  if (collab?.status === 'connected' || collab?.status === 'reconnecting') return null;
  if (collab?.status === 'error') {
    const needsLogin = !server?.me && /sign in/i.test(collab.error ?? '');
    return (
      <div className="overlay-page">
        <div className="auth-card">
          <h2>Cannot open this file</h2>
          <p className="share-error">{collab.error}</p>
          {needsLogin && (
            <button type="button" className="primary-button" onClick={() => navigate(`/login?next=${encodeURIComponent(location.pathname)}`)}>
              Sign in
            </button>
          )}
          <button type="button" className="small-button" onClick={() => navigate('/')}>
            Back to files
          </button>
        </div>
      </div>
    );
  }
  return <div className="overlay-page">Opening…</div>;
}

export function App({ fileId }: { fileId?: string }) {
  const editor = useMemo(() => (fileId ? new Editor(createDocument('Loading…'), { autosave: false }) : new Editor()), [fileId]);
  const fileInput = useRef<HTMLInputElement>(null);
  const openFile = useMemo(() => () => fileInput.current?.click(), []);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // A file on the server is edited live.
  useEffect(() => (fileId ? openServerFile(editor, fileId) : undefined), [editor, fileId]);
  useShortcuts(editor, openFile);

  useEffect(() => {
    (window as unknown as { planar: Editor }).planar = editor; // handy for debugging
  }, [editor]);

  useEffect(() => watchFonts(editor), [editor]);

  return (
    <EditorContext.Provider value={editor}>
      <ContextMenuProvider>
      <div className={`app${editor.readOnly ? ' read-only' : ''}`}>
        <Toolbar onOpen={openFile} onVariables={() => setVariablesOpen(true)} onShare={() => setShareOpen(true)} onHistory={() => setHistoryOpen(true)} onAccount={() => setAccountOpen(true)} />
        <div className="workspace">
          <LayersPanel />
          <main className="stage">
            <Canvas onOpenVariables={() => setVariablesOpen(true)} />
          </main>
          <PropertiesPanel />
        </div>
        <Toast />
        {fileId && <ConnectionOverlay />}
        {accountOpen && <AccountDialog onClose={() => setAccountOpen(false)} />}
        {variablesOpen && <VariablesDialog onClose={() => setVariablesOpen(false)} />}
        {shareOpen && fileId && <ShareDialog onClose={() => setShareOpen(false)} />}
        {historyOpen && fileId && <VersionsDialog onClose={() => setHistoryOpen(false)} />}
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) editor.openFile(await file.text());
          }}
        />
      </div>
      </ContextMenuProvider>
    </EditorContext.Provider>
  );
}
