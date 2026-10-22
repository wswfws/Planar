import { useCallback, useEffect, useMemo, useState } from 'react';
import { versions, type VersionInfo } from '../collab/session';
import { exportSvg } from '../core/export';
import { diffDocs } from '../core/ops';
import type { PlanarDocument } from '../core/types';
import { IconButton } from './controls';
import { useEditorState } from './EditorContext';

const KIND_LABEL: Record<VersionInfo['kind'], string> = {
  auto: 'Autosaved',
  named: 'Saved',
  agent: 'Before an agent',
  restore: 'Before a restore',
};

function when(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/** What restoring `version` would do to `current`, in layers (pages are not counted). */
export function restoreSummary(current: PlanarDocument, version: PlanarDocument) {
  const removed: string[] = [];
  const brought: string[] = [];
  const reverted: string[] = [];
  for (const op of diffDocs(current, version)) {
    if (op.o !== 'node') continue;
    if (op.node === null) {
      const n = current.nodes[op.id];
      if (n && n.type !== 'page') removed.push(n.name);
    } else if (op.node.type !== 'page') {
      (current.nodes[op.id] ? reverted : brought).push(op.node.name);
    }
  }
  return { removed, brought, reverted };
}

function preview(doc: PlanarDocument, pageId: string): string | null {
  const page = doc.nodes[pageId] ?? doc.nodes[doc.pageIds[0]];
  if (!page) return null;
  try {
    const svg = exportSvg(doc, [...page.children]);
    return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
  } catch {
    return null;
  }
}

function Names({ label, names }: { label: string; names: string[] }) {
  if (!names.length) return null;
  const shown = names.slice(0, 6).join(', ');
  return (
    <p className="version-line">
      <b>{names.length}</b> layer{names.length === 1 ? "" : "s"} {label}: <span className="hint">{shown}{names.length > 6 ? `, and ${names.length - 6} more` : ''}</span>
    </p>
  );
}

export function VersionsDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditorState();
  const fileId = editor.collab!.fileId;
  const [list, setList] = useState<VersionInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<PlanarDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');

  const load = useCallback(() => {
    versions.list(fileId).then(setList, (e: Error) => setError(e.message));
  }, [fileId]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setDoc(null);
    if (!selected) return;
    let live = true;
    versions.get(fileId, selected).then(
      (r) => live && setDoc(r.doc),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [fileId, selected]);

  const info = list?.find((v) => v.id === selected) ?? null;
  const summary = useMemo(() => (doc ? restoreSummary(editor.doc, doc) : null), [doc, editor.doc]);
  const image = useMemo(() => (doc ? preview(doc, editor.pageId) : null), [doc, editor.pageId]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      await versions.save(fileId, label.trim() || 'Saved version');
      setLabel('');
      load();
    });

  const restore = () =>
    act(async () => {
      if (!selected) return;
      await new Promise((r) => setTimeout(r, 150)); // let unsent edits reach the server first
      await versions.restore(fileId, selected);
      load();
      onClose();
    });

  const nothingToChange = !!summary && !summary.removed.length && !summary.brought.length && !summary.reverted.length;

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog versions-dialog" role="dialog" aria-label="Version history">
        <header className="dialog-header">
          <h2>Version history</h2>
          <IconButton icon="close" title="Close (Esc)" onClick={onClose} />
        </header>
        <div className="versions-body">
          <div className="versions-list">
            <div className="link-row">
              <input
                placeholder="Name the current state…"
                value={label}
                maxLength={120}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') void save();
                }}
              />
              <button type="button" className="small-button" disabled={busy} onClick={save}>
                Save
              </button>
            </div>
            {list === null && !error && <p className="hint">Loading…</p>}
            {list?.length === 0 && <p className="hint">No earlier versions yet. They appear while you work, and before an AI agent edits this file.</p>}
            {list?.map((v) => (
              <button type="button" key={v.id} className={`version-item${v.id === selected ? ' selected' : ''}`} onClick={() => setSelected(v.id)}>
                <span className="version-title">
                  {v.label || KIND_LABEL[v.kind]}
                  {(v.kind === 'agent' || v.kind === 'restore') && <span className="badge">{KIND_LABEL[v.kind]}</span>}
                </span>
                <span className="hint">
                  {when(v.createdAt)}
                  {v.authorName && v.kind !== 'auto' ? ` · ${v.authorName}` : ''}
                </span>
              </button>
            ))}
          </div>
          <div className="versions-detail">
            {!info && <p className="hint">Pick a version to look at it and bring it back.</p>}
            {info && (
              <>
                <div className="version-preview">{image ? <img src={image} alt="Preview of this version" /> : <span className="hint">{doc ? 'Nothing to show on this page' : 'Loading…'}</span>}</div>
                {summary && (
                  <div className="version-summary">
                    {nothingToChange ? (
                      <p className="version-line">This is the same as the file now.</p>
                    ) : (
                      <>
                        <p className="version-line">Restoring this version will change the file:</p>
                        <Names label="made since then (will be removed)" names={summary.removed} />
                        <Names label="deleted (will come back)" names={summary.brought} />
                        <Names label="changed (will go back to how they were)" names={summary.reverted} />
                      </>
                    )}
                    <p className="hint">The file as it is now is saved first, so you can undo a restore from this list.</p>
                  </div>
                )}
              </>
            )}
            {error && <p className="share-error">{error}</p>}
          </div>
        </div>
        <footer className="dialog-footer">
          <span className="hint">Autosaved versions are kept for 30 days.</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="primary-button" disabled={busy || !doc || nothingToChange} onClick={restore}>
            Restore this version
          </button>
        </footer>
      </div>
    </div>
  );
}
