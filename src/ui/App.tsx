import { useEffect, useMemo, useRef, useState } from 'react';
import { Editor, type Tool } from '../core/editor';
import { Canvas, readImageFile } from './Canvas';
import { ContextMenuProvider } from './ContextMenu';
import { EditorContext, useEditorState } from './EditorContext';
import { LayersPanel } from './LayersPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { Toolbar } from './Toolbar';
import { VariablesDialog } from './VariablesDialog';

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
      const image = Array.from(data.files).find((f) => f.type.startsWith('image/'));
      if (image) {
        const img = await readImageFile(image);
        const c = editor.screenToWorld({ x: editor.canvasSize.width / 2, y: editor.canvasSize.height / 2 });
        editor.placeImage(img.src, img.width, img.height, c);
        return;
      }
      const text = data.getData('text/plain');
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

export function App() {
  const editor = useMemo(() => new Editor(), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const openFile = useMemo(() => () => fileInput.current?.click(), []);
  const [variablesOpen, setVariablesOpen] = useState(false);
  useShortcuts(editor, openFile);

  useEffect(() => {
    (window as unknown as { planar: Editor }).planar = editor; // handy for debugging
  }, [editor]);

  return (
    <EditorContext.Provider value={editor}>
      <ContextMenuProvider>
      <div className="app">
        <Toolbar onOpen={openFile} onVariables={() => setVariablesOpen(true)} />
        <div className="workspace">
          <LayersPanel />
          <main className="stage">
            <Canvas onOpenVariables={() => setVariablesOpen(true)} />
          </main>
          <PropertiesPanel />
        </div>
        <Toast />
        {variablesOpen && <VariablesDialog onClose={() => setVariablesOpen(false)} />}
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
