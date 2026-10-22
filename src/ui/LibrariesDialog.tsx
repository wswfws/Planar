import { useCallback, useEffect, useMemo, useState } from 'react';
import { libraries, type LibraryInfo, type PublishedInfo } from '../collab/session';
import { buildLibrarySnapshot, snapshotSummary } from '../core/library';
import { IconButton } from './controls';
import { useEditorState } from './EditorContext';

/** Opens the libraries dialog from anywhere (e.g. the Assets tab). */
export function openLibraries(): void {
  window.dispatchEvent(new Event('planar:libraries'));
}

function counts(c: { components: number; variables: number; styles: number }): string {
  const part = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [part(c.components, 'component'), part(c.variables, 'variable'), part(c.styles, 'style')].join(' · ');
}

function date(t: number): string {
  return new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Team libraries: publish this file's components, variables and styles, and
 * use (add, update, remove) libraries published by others.
 */
export function LibrariesDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditorState();
  const fileId = editor.collab?.fileId ?? '';
  const canEdit = !editor.readOnly;
  const [published, setPublished] = useState<PublishedInfo | null | undefined>(undefined);
  const [available, setAvailable] = useState<LibraryInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    libraries.status(fileId).then(setPublished, (e: Error) => setError(e.message));
    libraries.list().then(setAvailable, (e: Error) => setError(e.message));
  }, [fileId]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // What publishing now would share (computed locally from the open document).
  const local = useMemo(() => snapshotSummary(buildLibrarySnapshot(editor.doc, fileId, editor.doc.name, 0)), [editor.doc, editor.version, fileId]);
  const used = editor.doc.libraries ?? [];
  const others = (available ?? []).filter((l) => l.fileId !== fileId);
  const info = (id: string) => others.find((l) => l.fileId === id);

  const use = (id: string) => run(async () => editor.useLibrary(await libraries.get(id)));

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog libraries-dialog" role="dialog" aria-label="Team libraries">
        <header className="dialog-header">
          <h2>Team libraries</h2>
          <IconButton icon="close" title="Close (Esc)" onClick={onClose} />
        </header>
        <div className="libraries-body">
          <section>
            <h3>This file</h3>
            {published === undefined ? (
              <p className="hint">Loading…</p>
            ) : published ? (
              <p className="version-line">
                Published as a library, version {published.version} ({date(published.publishedAt)}): {counts(published)}.
              </p>
            ) : (
              <p className="hint">Publish this file to let your team use its components, variables and styles in their files.</p>
            )}
            <p className="hint">Now in this file: {counts(local)}.</p>
            {canEdit && (
              <div className="row">
                <button type="button" className="primary-button" disabled={busy} onClick={() => run(() => libraries.publish(fileId))}>
                  {published ? 'Publish changes' : 'Publish library'}
                </button>
                {published && (
                  <button type="button" className="small-button" disabled={busy} onClick={() => confirm('Stop sharing this library? Files that use it keep their copies.') && run(() => libraries.unpublish(fileId))}>
                    Unpublish
                  </button>
                )}
              </div>
            )}
          </section>

          <section>
            <h3>Used in this file</h3>
            {!used.length && <p className="hint">No libraries yet.</p>}
            <ul className="library-list">
              {used.map((l) => {
                const latest = info(l.fileId);
                const update = latest && latest.version > l.version;
                return (
                  <li key={l.fileId}>
                    <span className="library-name">
                      {l.name}
                      <span className="hint"> · version {l.version}</span>
                      {update && <span className="badge">Update to {latest.version}</span>}
                      {!latest && available && <span className="hint"> · no longer published</span>}
                    </span>
                    {canEdit && update && (
                      <button type="button" className="small-button" disabled={busy} onClick={() => use(l.fileId)}>
                        Update
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className="small-button"
                        disabled={busy}
                        onClick={() => confirm(`Stop using "${l.name}"? Its instances in this file become ordinary layers.`) && editor.removeLibrary(l.fileId)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section>
            <h3>Available</h3>
            {available === null && !error && <p className="hint">Loading…</p>}
            {available && !others.some((l) => !used.some((u) => u.fileId === l.fileId)) && (
              <p className="hint">Libraries published in files you own, are invited to or share a project with appear here.</p>
            )}
            <ul className="library-list">
              {others
                .filter((l) => !used.some((u) => u.fileId === l.fileId))
                .map((l) => (
                  <li key={l.fileId}>
                    <span className="library-name">
                      {l.name}
                      <span className="hint">
                        {' '}
                        · {counts(l)} · v{l.version}
                        {l.publishedBy ? ` by ${l.publishedBy}` : ''}
                      </span>
                    </span>
                    {canEdit && (
                      <button type="button" className="small-button" disabled={busy} onClick={() => use(l.fileId)}>
                        Add to file
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          </section>
          {error && <p className="share-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
