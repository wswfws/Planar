import { useEffect, useState } from 'react';
import { accounts, PEER_COLORS, type ApiKeyInfo } from '../collab/session';
import { IconButton } from './controls';
import { navigate, useServer } from './router';

function copy(text: string, done: () => void) {
  void navigator.clipboard.writeText(text).then(done, () => undefined);
}

export function AccountDialog({ onClose }: { onClose: () => void }) {
  const server = useServer()!;
  const me = server.me!;
  const [displayName, setDisplayName] = useState(me.displayName);
  const [color, setColor] = useState(me.color);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [keyName, setKeyName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [apps, setApps] = useState<Awaited<ReturnType<typeof accounts.apps>>>([]);
  const refresh = () => {
    void accounts.keys().then(setKeys, () => undefined);
    void accounts.apps().then(setApps, () => undefined);
  };
  useEffect(refresh, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setError(null);
    setMessage(null);
    try {
      await fn();
      if (ok) setMessage(ok);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveProfile = () =>
    run(async () => {
      server.setMe(await accounts.update({ displayName, color }));
    }, 'Saved');
  const changePassword = () =>
    run(async () => {
      await accounts.update({ oldPassword, newPassword });
      setOldPassword('');
      setNewPassword('');
    }, 'Password changed');

  const mcpUrl = `${location.origin}/mcp`;
  const snippet = JSON.stringify({ mcpServers: { planar: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${secret ?? 'plk_…'}` } } } }, null, 2);

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog share-dialog account-dialog" role="dialog" aria-label="Account">
        <header className="dialog-header">
          <h2>@{me.username}</h2>
          <IconButton icon="close" title="Close (Esc)" onClick={onClose} />
        </header>
        <div className="dialog-body share-body">
          <div className="grid-2">
            <label className="stacked-field">
              <span>Display name</span>
              <input className="text-field" value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            </label>
            <div className="stacked-field">
              <span>Your colour</span>
              <div className="color-swatches">
                {PEER_COLORS.map((c) => (
                  <button key={c} type="button" className={color === c ? 'active' : ''} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />
                ))}
              </div>
            </div>
          </div>
          <div>
            <button type="button" className="small-button" onClick={saveProfile}>
              Save profile
            </button>
          </div>

          <div className="grid-2">
            <label className="stacked-field">
              <span>Current password</span>
              <input className="text-field" type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            </label>
            <label className="stacked-field">
              <span>New password</span>
              <input className="text-field" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            </label>
          </div>
          <div>
            <button type="button" className="small-button" disabled={!oldPassword || newPassword.length < 8} onClick={changePassword}>
              Change password
            </button>
          </div>

          <h3 className="section-title">API keys for AI agents</h3>
          <p className="hint">
            An agent connected with a key acts with your rights: it sees your files and those shared with you. Add the key to the agent’s MCP configuration; the key is shown only once.
          </p>
          {keys.map((k) => (
            <div key={k.id} className="key-row">
              <span>
                <b>{k.name}</b> <span className="hint">{k.prefix}… · {k.lastUsed ? `used ${new Date(k.lastUsed).toLocaleDateString()}` : 'never used'}</span>
              </span>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  if (confirm(`Revoke the key “${k.name}”? Agents using it will stop working.`)) void run(async () => { await accounts.deleteKey(k.id); refresh(); });
                }}
              >
                Revoke
              </button>
            </div>
          ))}
          <div className="link-row">
            <input
              placeholder="Key name, e.g. Claude Code"
              value={keyName}
              maxLength={60}
              onChange={(e) => setKeyName(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              className="small-button"
              onClick={() =>
                run(async () => {
                  const created = await accounts.createKey(keyName.trim() || 'Agent');
                  setSecret(created.secret);
                  setKeyName('');
                  refresh();
                })
              }
            >
              Create key
            </button>
          </div>
          {secret && (
            <>
              <label className="stacked-field">
                <span>Your new key — copy it now, it will not be shown again</span>
                <span className="link-row">
                  <input readOnly value={secret} onFocus={(e) => e.target.select()} />
                  <button type="button" className="small-button" onClick={() => copy(secret, () => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </span>
              </label>
              <label className="stacked-field">
                <span>MCP configuration (Claude Code, Cursor, …)</span>
                <textarea className="text-field code-field" readOnly rows={8} value={snippet} onFocus={(e) => e.target.select()} />
              </label>
            </>
          )}
          <h3 className="section-title">Connected apps</h3>
          <p className="hint">
            Apps that signed in with your Planar account (OAuth), such as Claude: add <code>{mcpUrl}</code> as a custom connector and approve it here.
          </p>
          {apps.length ? (
            apps.map((a) => (
              <div key={a.clientId} className="key-row">
                <span>
                  <b>{a.name}</b>{' '}
                  <span className="hint">
                    connected {new Date(a.connectedAt).toLocaleDateString()} · {a.lastUsed ? `used ${new Date(a.lastUsed).toLocaleDateString()}` : 'not used yet'}
                  </span>
                </span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => confirm(`Disconnect ${a.name}? It will have to ask for access again.`) && void run(async () => { await accounts.disconnectApp(a.clientId); refresh(); })}
                >
                  Disconnect
                </button>
              </div>
            ))
          ) : (
            <p className="hint">None yet.</p>
          )}
          {error && <p className="share-error">{error}</p>}
          {message && <p className="hint">{message}</p>}
        </div>
        <footer className="dialog-footer">
          <a className="hint" href="/privacy" target="_blank" rel="noopener">
            Privacy policy
          </a>
          {me.admin && (
            <button type="button" className="small-button" onClick={() => navigate('/admin')}>
              Admin panel
            </button>
          )}
          <button
            type="button"
            className="small-button"
            onClick={async () => {
              await accounts.logout().catch(() => undefined);
              server.setMe(null);
              navigate('/', true);
            }}
          >
            Sign out
          </button>
        </footer>
      </div>
    </div>
  );
}
