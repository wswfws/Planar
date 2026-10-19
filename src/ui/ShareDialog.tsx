import { useEffect, useState } from 'react';
import { detectServer, loadSettings, PEER_COLORS, randomRoomId, saveSettings, startSession } from '../collab/session';
import { IconButton } from './controls';
import { useEditorState } from './EditorContext';

const STATUS_LABEL = {
  connecting: 'Connecting…',
  connected: 'Live',
  reconnecting: 'Reconnecting…',
  error: 'Not connected',
} as const;

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditorState();
  const collab = editor.collab;
  const [settings, setSettings] = useState(loadSettings);
  const [detected, setDetected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void detectServer().then((origin) => {
      setDetected(origin);
      if (origin) setSettings((s) => ({ ...s, serverUrl: s.serverUrl || origin }));
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const insecure = location.protocol === 'https:' && /^(ws|http):\/\//i.test(settings.serverUrl);
  const start = () => {
    const s = { ...settings, serverUrl: settings.serverUrl.trim(), name: settings.name.trim() || 'Guest' };
    saveSettings(s);
    startSession(editor, { ...s, roomId: randomRoomId(), create: true });
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog share-dialog" role="dialog" aria-label="Share">
        <header className="dialog-header">
          <h2>Collaborate</h2>
          <IconButton icon="close" title="Close (Esc)" onClick={onClose} />
        </header>
        <div className="dialog-body share-body">
          {collab ? (
            <>
              <p className="share-status">
                <span className={`status-dot ${collab.status}`} /> {STATUS_LABEL[collab.status]}
                {collab.error && <span className="share-error"> — {collab.error}</span>}
              </p>
              <label className="stacked-field">
                <span>Link to this document</span>
                <span className="link-row">
                  <input readOnly value={collab.shareUrl} onFocus={(e) => e.target.select()} />
                  <button
                    type="button"
                    className="small-button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(collab.shareUrl);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      } catch {
                        editor.notify('Copy the link from the field');
                      }
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </span>
              </label>
              <p className="hint">Anyone with this link can view and edit. The access token, if any, is part of the link.</p>
              <div className="peer-list">
                <span className="peer-chip" style={{ borderColor: settings.color }}>
                  <span className="peer-dot" style={{ background: settings.color }} />
                  {settings.name || 'You'} (you)
                </span>
                {collab.peers.map((p) => (
                  <span key={p.id} className="peer-chip" style={{ borderColor: p.color }}>
                    <span className="peer-dot" style={{ background: p.color }} />
                    {p.name}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="hint">
                Edit this document together in real time through your own Planar server. The document is uploaded to the server and a link
                is created for others to join.
              </p>
              <label className="stacked-field">
                <span>Server address</span>
                <input
                  className="text-field"
                  placeholder="https://planar.example.com"
                  value={settings.serverUrl}
                  onChange={(e) => setSettings({ ...settings, serverUrl: e.target.value })}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </label>
              {detected && settings.serverUrl === detected && <p className="hint">This editor is served by a Planar server — it will be used.</p>}
              {insecure && <p className="share-error">This page uses HTTPS, so the server must use HTTPS (https:// or wss://) too.</p>}
              <div className="grid-2">
                <label className="stacked-field">
                  <span>Your name</span>
                  <input
                    className="text-field"
                    placeholder="Guest"
                    value={settings.name}
                    maxLength={40}
                    onChange={(e) => setSettings({ ...settings, name: e.target.value })}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </label>
                <label className="stacked-field">
                  <span>Access token (if required)</span>
                  <input
                    className="text-field"
                    type="password"
                    value={settings.token}
                    onChange={(e) => setSettings({ ...settings, token: e.target.value })}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </label>
              </div>
              <div className="stacked-field">
                <span>Your colour</span>
                <div className="color-swatches">
                  {PEER_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={settings.color === c ? 'active' : ''}
                      style={{ background: c }}
                      aria-label={`Colour ${c}`}
                      onClick={() => setSettings({ ...settings, color: c })}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <footer className="dialog-footer">
          {collab ? (
            <button type="button" className="small-button" onClick={() => collab.leave()}>
              Leave (keep a local copy)
            </button>
          ) : (
            <>
              <button type="button" className="primary-button" disabled={!settings.serverUrl.trim() || insecure} onClick={start}>
                Start collaborating
              </button>
              <a className="hint" href="https://github.com/wswfws/Planar/blob/main/docs/SELF_HOSTING.md" target="_blank" rel="noopener">
                How to run a server
              </a>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
