import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Editor } from '../core/editor';

export const EditorContext = createContext<Editor | null>(null);

export function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error('EditorContext is missing');
  return editor;
}

/** Re-renders the calling component whenever the editor changes. */
export function useEditorState(): Editor {
  const editor = useEditor();
  useSyncExternalStore(editor.subscribe, editor.getVersion);
  return editor;
}
