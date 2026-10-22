import { useRef, useState } from 'react';
import type { PlanarDocument } from '../core/types';
import { figmaFileKey, figmaToPlanar } from '../import/figma';
import { IconButton } from './controls';

const API = 'https://api.figma.com/v1';

/** True for the JSON of GET /v1/files/:key (rather than a Planar document). */
export function looksLikeFigmaFile(data: unknown): boolean {
  const d = data as { document?: { type?: string; children?: unknown } } | null;
  return !!d && typeof d === 'object' && d.document?.type === 'DOCUMENT' && Array.isArray(d.document.children);
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function figmaGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { 'X-Figma-Token': token } });
  const body = (await res.json().catch(() => ({}))) as { err?: string; message?: string } & T;
  if (res.status === 403) throw new Error('Figma refused the token (check it, and that it can read files)');
  if (res.status === 404) throw new Error('Figma has no file with this link, or the token’s account cannot open it');
  if (res.status === 429) throw new Error('Figma asks to slow down; try again in a minute');
  if (!res.ok) throw new Error(body.err ?? body.message ?? `Figma answered ${res.status}`);
  return body;
}

/**
 * Imports a Figma file through the Figma REST API with the user's own token.
 * Everything happens in this browser: the token goes only to api.figma.com and
 * is not stored; Planar receives the converted document.
 */
export function FigmaImportDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (doc: PlanarDocument) => Promise<void> }) {
  const [tab, setTab] = useState<'link' | 'json'>('link');
  const [link, setLink] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ doc: PlanarDocument; report: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const key = figmaFileKey(link);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const fromLink = () =>
    run(async () => {
      if (!key) throw new Error('Paste a link to a Figma design file');
      setStatus('Reading the file from Figma…');
      const file = await figmaGet<Record<string, unknown>>(`/files/${encodeURIComponent(key)}?geometry=paths`, token.trim());
      const first = figmaToPlanar(file);
      const images: Record<string, string> = {};
      if (first.imageRefs.length) {
        setStatus(`Downloading ${first.imageRefs.length} image${first.imageRefs.length === 1 ? '' : 's'}…`);
        const urls = (await figmaGet<{ meta?: { images?: Record<string, string> } }>(`/files/${encodeURIComponent(key)}/images`, token.trim())).meta?.images ?? {};
        for (const ref of first.imageRefs) {
          const url = urls[ref];
          if (!url) continue;
          try {
            const res = await fetch(url);
            if (res.ok) images[ref] = await dataUrl(await res.blob());
          } catch {
            // Left grey and listed in the report.
          }
        }
      }
      setResult(Object.keys(images).length ? figmaToPlanar(file, images) : first);
    });

  const fromJson = (f: File) =>
    run(async () => {
      let data: unknown;
      try {
        data = JSON.parse(await f.text());
      } catch {
        throw new Error('That file is not JSON');
      }
      if (!looksLikeFigmaFile(data)) throw new Error('This JSON is not a Figma file (expected the answer of GET /v1/files/:key)');
      setResult(figmaToPlanar(data as Record<string, unknown>));
    });

  const pages = result ? result.doc.pageIds.length : 0;
  const layers = result ? Object.keys(result.doc.nodes).length - pages : 0;

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog figma-dialog" role="dialog" aria-label="Import a Figma file">
        <header className="dialog-header">
          <h2>Import a Figma file</h2>
          <IconButton icon="close" title="Close (Esc)" onClick={onClose} />
        </header>
        <div className="figma-body">
          <div className="tabs">
            <button type="button" className={tab === 'link' ? 'active' : ''} onClick={() => setTab('link')}>
              From a link
            </button>
            <button type="button" className={tab === 'json' ? 'active' : ''} onClick={() => setTab('json')}>
              From a JSON file
            </button>
          </div>
          {tab === 'link' ? (
            <>
              <label className="field">
                <span>Link to your Figma file</span>
                <input value={link} placeholder="https://www.figma.com/design/…" onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              </label>
              <label className="field">
                <span>
                  Your personal access token (Figma → Settings → Security →{' '}
                  <a href="https://www.figma.com/developers/api#access-tokens" target="_blank" rel="noopener noreferrer">
                    Personal access tokens
                  </a>
                  , with read access to files)
                </span>
                <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              </label>
              <p className="hint">The file is read through the Figma REST API right from this browser. The token is sent only to api.figma.com and is not saved anywhere.</p>
              <button type="button" className="primary-button" disabled={busy || !key || !token.trim()} onClick={fromLink}>
                Read from Figma
              </button>
            </>
          ) : (
            <>
              <p className="hint">Save the file’s JSON with your own token, then choose it here (images arrive grey this way):</p>
              <pre className="code-block">{`curl -H "X-Figma-Token: <token>" "https://api.figma.com/v1/files/${key ?? '<file key>'}?geometry=paths" -o design.json`}</pre>
              <button type="button" className="primary-button" disabled={busy} onClick={() => fileRef.current?.click()}>
                Choose JSON…
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void fromJson(f);
                }}
              />
            </>
          )}
          {status && <p className="hint">{status}</p>}
          {error && <p className="share-error">{error}</p>}
          {result && (
            <div className="figma-result">
              <p className="version-line">
                “{result.doc.name}”: {pages} page{pages === 1 ? '' : 's'}, {layers} layers, {result.doc.styles.length} styles.
              </p>
              {result.report.length > 0 && (
                <>
                  <p className="hint">Simplified or left out:</p>
                  <ul className="hint">
                    {result.report.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </>
              )}
              <button type="button" className="primary-button" disabled={busy} onClick={() => run(() => onCreate(result.doc))}>
                Create Planar file
              </button>
            </div>
          )}
        </div>
        <footer className="dialog-footer">
          <span className="hint">Planar is not affiliated with Figma. Import only files you are allowed to copy.</span>
        </footer>
      </div>
    </div>
  );
}
