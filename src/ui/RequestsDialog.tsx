import { useEffect, useState } from 'react';
import {
  entryTitle,
  formatSize,
  headerValue,
  METHODS,
  newRequest,
  prepareRequest,
  prettyBody,
  savedRequest,
  sendDirect,
  sendViaProxy,
  splitUrl,
  type HttpMethod,
  type KeyValue,
  type RequestSpec,
  type ResponseRecord,
  type SavedRequest,
} from '../core/requests';
import type { RequestBodyKind } from '../core/types';
import { IconButton } from './controls';
import { useEditorState } from './EditorContext';
import { useAuthorName } from './NoteSection';
import { useServer } from './router';

type RequestTab = 'params' | 'headers' | 'body';
type ResponseTab = 'body' | 'headers';

const BODY_KINDS: { kind: RequestBodyKind; label: string }[] = [
  { kind: 'none', label: 'None' },
  { kind: 'json', label: 'JSON' },
  { kind: 'text', label: 'Text' },
  { kind: 'form', label: 'Form' },
];

function when(t: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

function statusClass(status: number): string {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  if (status >= 300) return 'info';
  return 'ok';
}

/** Rows of key/value inputs; typing in the empty last row adds a row. */
function KeyValueRows({ rows, onChange, keyLabel = 'Key' }: { rows: KeyValue[]; onChange: (rows: KeyValue[]) => void; keyLabel?: string }) {
  const shown = [...rows, { key: '', value: '', enabled: true }];
  const set = (i: number, patch: Partial<KeyValue>) => {
    const next = shown.map((r, j) => (j === i ? { ...r, ...patch } : r));
    onChange(next.filter((r, j) => j < next.length - 1 || r.key || r.value));
  };
  return (
    <table className="kv-table">
      <tbody>
        {shown.map((r, i) => {
          const last = i === shown.length - 1;
          return (
            <tr key={i} className={r.enabled ? undefined : 'off'}>
              <td className="narrow">
                {!last && <input type="checkbox" aria-label="Send this row" checked={r.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />}
              </td>
              <td>
                <input className="cell-input" aria-label={keyLabel} placeholder={keyLabel} value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
              </td>
              <td>
                <input className="cell-input" aria-label="Value" placeholder="Value" value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
              </td>
              <td className="narrow">{!last && <IconButton icon="close" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))} />}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HistoryItem({ entry, selected, readOnly, onOpen }: { entry: SavedRequest; selected: boolean; readOnly: boolean; onOpen: () => void }) {
  const editor = useEditorState();
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <div className={`request-item${selected ? ' selected' : ''}`} onClick={onOpen} onDoubleClick={() => !readOnly && setRenaming(entryTitle(entry))}>
      <span className={`method-badge ${entry.request.method.toLowerCase()}`}>{entry.request.method}</span>
      <span className="request-item-main">
        {renaming !== null ? (
          <input
            className="cell-input"
            aria-label="Request name"
            autoFocus
            value={renaming}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => {
              // Keeping the shown default title leaves the entry unnamed.
              editor.renameSavedRequest(entry.id, renaming === entryTitle({ ...entry, name: undefined }) ? '' : renaming);
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(null);
            }}
          />
        ) : (
          <span className="request-item-title" title={entry.request.url}>
            {entry.name || entry.request.url.replace(/^https?:\/\//, '') || '(no URL)'}
          </span>
        )}
        <span className="hint">
          {entry.response ? <span className={`status-text ${statusClass(entry.response.status)}`}>{entry.response.status}</span> : <span className="status-text error">Error</span>}
          {' · '}
          {when(entry.at)}
          {entry.author ? ` · ${entry.author}` : ''}
        </span>
      </span>
      {!readOnly && (
        <span className="request-item-actions" onClick={(e) => e.stopPropagation()}>
          <IconButton icon="trash" title="Delete from history" onClick={() => editor.deleteSavedRequest(entry.id)} />
        </span>
      )}
    </div>
  );
}

function ResponseView({ response, error }: { response: ResponseRecord | null; error: string | null }) {
  const [tab, setTab] = useState<ResponseTab>('body');
  if (error) return <div className="response-error">{error}</div>;
  if (!response) return <div className="empty-hint">Send a request to see the response here.</div>;
  return (
    <div className="response-view">
      <div className="response-meta">
        <span className={`status-pill ${statusClass(response.status)}`}>
          {response.status} {response.statusText}
        </span>
        <span className="hint">{response.time} ms</span>
        <span className="hint">{formatSize(response.size)}</span>
        {headerValue(response.headers, 'content-type') && <span className="hint">{headerValue(response.headers, 'content-type')}</span>}
        <span className="segmented response-tabs">
          <button type="button" className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>
            Body
          </button>
          <button type="button" className={tab === 'headers' ? 'active' : ''} onClick={() => setTab('headers')}>
            Headers ({response.headers.length})
          </button>
        </span>
      </div>
      {response.truncated && <p className="hint">The body is long: only the beginning is shown.</p>}
      {tab === 'body' ? (
        <pre className="response-body">{prettyBody(response) || <span className="hint">(empty body)</span>}</pre>
      ) : (
        <table className="kv-table response-headers">
          <tbody>
            {response.headers.map(([k, v], i) => (
              <tr key={i}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** A small HTTP client: build a request, send it, and keep it with its response in the file's history. */
export function RequestsDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditorState();
  const server = useServer();
  const author = useAuthorName();
  const history = editor.doc.requests ?? [];
  const canProxy = !!server?.me;

  const [spec, setSpec] = useState<RequestSpec>(() => (history[0] ? structuredClone(history[0].request) : newRequest()));
  const [selectedId, setSelectedId] = useState<string | null>(history[0]?.id ?? null);
  const [tab, setTab] = useState<RequestTab>('params');
  const [viaProxy, setViaProxy] = useState(canProxy);
  const [sending, setSending] = useState(false);
  const [shown, setShown] = useState<{ response: ResponseRecord | null; error: string | null }>(() => ({
    response: history[0]?.response ?? null,
    error: history[0]?.error ?? null,
  }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const update = (patch: Partial<RequestSpec>) => setSpec((s) => ({ ...s, ...patch }));

  const open = (entry: SavedRequest) => {
    setSelectedId(entry.id);
    setSpec(structuredClone(entry.request));
    setShown({ response: entry.response, error: entry.error ?? null });
  };

  const startNew = () => {
    setSelectedId(null);
    setSpec(newRequest());
    setShown({ response: null, error: null });
    setTab('params');
  };

  const send = async () => {
    if (sending) return;
    let prepared;
    try {
      prepared = prepareRequest(spec);
    } catch (e) {
      setShown({ response: null, error: (e as Error).message });
      return;
    }
    const via = canProxy && viaProxy ? 'proxy' : 'direct';
    setSending(true);
    let response: ResponseRecord | null = null;
    let error: string | undefined;
    try {
      response = via === 'proxy' ? await sendViaProxy(prepared) : await sendDirect(prepared);
    } catch (e) {
      error = (e as Error).message;
    }
    setSending(false);
    setShown({ response, error: error ?? null });
    const entry = savedRequest({ request: spec, response, error, via, author });
    if (editor.addSavedRequest(entry)) setSelectedId(entry.id);
    else setSelectedId(null);
  };

  const hasBody = spec.bodyKind !== 'none' && spec.method !== 'GET' && spec.method !== 'HEAD';
  const count = (rows: KeyValue[]) => rows.filter((r) => r.enabled && r.key.trim()).length;

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog requests-dialog" role="dialog" aria-label="API requests">
        <header className="dialog-header">
          <h2>API requests</h2>
          <IconButton icon="close" title="Close (Esc)" onClick={onClose} />
        </header>
        <div className="requests-body">
          <aside className="requests-history">
            <button type="button" className="small-button" onClick={startNew}>
              + New request
            </button>
            {history.map((entry) => (
              <HistoryItem key={entry.id} entry={entry} selected={entry.id === selectedId} readOnly={editor.readOnly} onOpen={() => open(entry)} />
            ))}
            {!history.length && <p className="empty-hint">Sent requests and their responses are kept here, in this file.</p>}
          </aside>
          <section className="requests-main">
            <form
              className="request-line"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <select aria-label="Method" value={spec.method} onChange={(e) => update({ method: e.target.value as HttpMethod })}>
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <input
                className="cell-input request-url"
                aria-label="URL"
                placeholder="https://api.example.com/items"
                value={spec.url}
                autoFocus
                onChange={(e) => update({ url: e.target.value })}
                onBlur={() => {
                  // A pasted query string becomes params, so it can be edited row by row.
                  const { url, params } = splitUrl(spec.url);
                  if (params.length) update({ url, params: [...spec.params, ...params] });
                }}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <button type="submit" className="primary-button" disabled={sending}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </form>
            <div className="request-options">
              <span className="segmented">
                <button type="button" className={tab === 'params' ? 'active' : ''} onClick={() => setTab('params')}>
                  Params{count(spec.params) ? ` (${count(spec.params)})` : ''}
                </button>
                <button type="button" className={tab === 'headers' ? 'active' : ''} onClick={() => setTab('headers')}>
                  Headers{count(spec.headers) ? ` (${count(spec.headers)})` : ''}
                </button>
                <button type="button" className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>
                  Body{hasBody ? ' •' : ''}
                </button>
              </span>
              {canProxy ? (
                <label className="checkbox" title="The Planar server makes the call, so APIs that do not allow browsers (CORS) work too">
                  <input type="checkbox" checked={viaProxy} onChange={(e) => setViaProxy(e.target.checked)} />
                  Send through the Planar server
                </label>
              ) : (
                <span className="hint" title="Without a signed-in Planar server, requests go straight from the browser">
                  Sent from the browser: the API must allow CORS
                </span>
              )}
            </div>
            <div className="request-editor">
              {tab === 'params' && <KeyValueRows rows={spec.params} onChange={(params) => update({ params })} keyLabel="Param" />}
              {tab === 'headers' && <KeyValueRows rows={spec.headers} onChange={(headers) => update({ headers })} keyLabel="Header" />}
              {tab === 'body' && (
                <>
                  <span className="segmented body-kinds">
                    {BODY_KINDS.map((b) => (
                      <button key={b.kind} type="button" className={spec.bodyKind === b.kind ? 'active' : ''} onClick={() => update({ bodyKind: b.kind })}>
                        {b.label}
                      </button>
                    ))}
                  </span>
                  {(spec.method === 'GET' || spec.method === 'HEAD') && spec.bodyKind !== 'none' && <p className="hint">{spec.method} requests are sent without a body.</p>}
                  {(spec.bodyKind === 'json' || spec.bodyKind === 'text') && (
                    <textarea
                      className="request-body-input"
                      aria-label="Body"
                      spellCheck={false}
                      placeholder={spec.bodyKind === 'json' ? '{\n  "name": "value"\n}' : 'Text to send'}
                      value={spec.body}
                      onChange={(e) => update({ body: e.target.value })}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
                      }}
                    />
                  )}
                  {spec.bodyKind === 'form' && <KeyValueRows rows={spec.form} onChange={(form) => update({ form })} keyLabel="Field" />}
                </>
              )}
            </div>
            <div className="request-response">
              <ResponseView key={selectedId ?? 'new'} response={shown.response} error={shown.error} />
            </div>
          </section>
        </div>
        <footer className="dialog-footer">
          <span className="hint">
            {editor.readOnly
              ? 'View only: requests you send here are not saved to the file.'
              : 'History is saved in this file and visible to everyone who can open it, headers and tokens included.'}
          </span>
          {!editor.readOnly && history.length > 0 && (
            <button
              type="button"
              className="small-button requests-clear"
              onClick={() => {
                if (confirm('Delete all requests and responses from this file?')) {
                  editor.clearSavedRequests();
                  startNew();
                }
              }}
            >
              Clear history
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
