import { useCallback, useEffect, useState } from 'react';
import { accounts, fileLink, files, type FileInfo, type LinkAccess, type Me } from '../collab/session';
import { IconButton } from './controls';
import { useEditorState } from './EditorContext';
import { navigate, useServer } from './router';

type Suggestion = Omit<Me, 'id'>;

const LINK_LABEL: Record<LinkAccess, string> = {
  none: 'Only people invited',
  view: 'Anyone with the link can view',
  edit: 'Anyone with the link can edit',
};

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditorState();
  const server = useServer()!;
  const me = server.me;
  const fileId = editor.collab!.fileId;
  const [file, setFile] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const load = useCallback(() => {
    files.get(fileId).then(setFile, (e: Error) => setError(e.message));
  }, [fileId]);
  useEffect(load, [load, editor.collab?.role]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Username suggestions while typing.
  useEffect(() => {
    const q = username.trim().replace(/^@/, '');
    if (!me || !q) return setSuggestions([]);
    const timer = setTimeout(() => void accounts.findUsers(q).then(setSuggestions, () => setSuggestions([])), 150);
    return () => clearTimeout(timer);
  }, [username, me]);

  const act = async (fn: () => Promise<FileInfo | void>) => {
    setError(null);
    try {
      const next = await fn();
      if (next) setFile(next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const invite = (name = username) =>
    act(async () => {
      const next = await files.setMember(fileId, name.trim().replace(/^@/, ''), role);
      setUsername('');
      setSuggestions([]);
      return next;
    });

  const role_ = file?.role ?? editor.collab?.role ?? null;
  const canShare = !!me && (role_ === 'owner' || role_ === 'editor');
  const link = fileLink(fileId);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      editor.notify('Copy the link from the field');
    }
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog share-dialog" role="dialog" aria-label="Share">
        <header className="dialog-header">
          <h2>Share “{file?.name ?? editor.doc.name}”</h2>
          <IconButton icon="close" title="Close (Esc)" onClick={onClose} />
        </header>
        <div className="dialog-body share-body">
          {canShare && (
            <div className="stacked-field">
              <span>Invite by username</span>
              <div className="link-row invite-row">
                <div className="suggest">
                  <input
                    placeholder="@username"
                    value={username}
                    autoComplete="off"
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && username.trim()) void invite();
                    }}
                  />
                  {suggestions.length > 0 && (
                    <div className="menu suggest-list" role="listbox">
                      {suggestions.map((s) => (
                        <button key={s.username} type="button" onClick={() => setUsername(s.username)}>
                          <span>
                            <span className="peer-dot" style={{ background: s.color }} /> {s.displayName}
                          </span>
                          <span className="hint">@{s.username}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')} aria-label="Role">
                  <option value="editor">Can edit</option>
                  <option value="viewer">Can view</option>
                </select>
                <button type="button" className="primary-button" disabled={!username.trim()} onClick={() => invite()}>
                  Invite
                </button>
              </div>
            </div>
          )}
          {!me && (
            <p className="hint">
              <button type="button" className="link-button" onClick={() => navigate(`/login?next=${encodeURIComponent(`/file/${fileId}`)}`)}>
                Sign in
              </button>{' '}
              to invite people or copy this file to your own files.
            </p>
          )}

          {file && (
            <div className="people">
              {file.owner && (
                <div className="person">
                  <span className="peer-dot" style={{ background: file.owner.color }} />
                  <span className="person-name">
                    {file.owner.displayName} <span className="hint">@{file.owner.username}</span>
                  </span>
                  <span className="hint">Owner</span>
                </div>
              )}
              {file.members?.map((m) => (
                <div className="person" key={m.id}>
                  <span className="peer-dot" style={{ background: m.color }} />
                  <span className="person-name">
                    {m.displayName} <span className="hint">@{m.username}</span>
                  </span>
                  {canShare ? (
                    <>
                      <select value={m.role} onChange={(e) => act(() => files.setMember(fileId, m.username, e.target.value as 'editor' | 'viewer'))} aria-label={`Role of ${m.username}`}>
                        <option value="editor">Can edit</option>
                        <option value="viewer">Can view</option>
                      </select>
                      <button type="button" className="link-button" onClick={() => act(() => files.setMember(fileId, m.username, null))}>
                        Remove
                      </button>
                    </>
                  ) : (
                    <span className="hint">{m.role === 'editor' ? 'Can edit' : 'Can view'}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          <label className="stacked-field">
            <span>Link access</span>
            {canShare ? (
              <select value={file?.linkAccess ?? 'none'} onChange={(e) => act(() => files.setLinkAccess(fileId, e.target.value as LinkAccess))}>
                {(Object.keys(LINK_LABEL) as LinkAccess[]).map((k) => (
                  <option key={k} value={k}>
                    {LINK_LABEL[k]}
                  </option>
                ))}
              </select>
            ) : (
              <span>{LINK_LABEL[file?.linkAccess ?? 'none']}</span>
            )}
          </label>
          <span className="link-row">
            <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Link to this file" />
            <button type="button" className="small-button" onClick={copyLink}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </span>
          {file?.linkAccess === 'none' && <p className="hint">This link only works for people you invited.</p>}

          {role_ === 'viewer' && <p className="hint">You can view this file but not change it.</p>}
          {error && <p className="share-error">{error}</p>}
        </div>
        <footer className="dialog-footer">
          {me && role_ !== 'owner' && (
            <button
              type="button"
              className="small-button"
              onClick={() =>
                act(async () => {
                  const copy = await files.duplicate(fileId);
                  onClose();
                  navigate(`/file/${copy.id}`);
                })
              }
            >
              Copy to my files
            </button>
          )}
          {role_ === 'owner' && (
            <button
              type="button"
              className="small-button"
              onClick={() => {
                const to = prompt('Make this person the owner (username):');
                if (to && confirm(`Hand over “${file?.name}” to @${to.replace(/^@/, '')}? You will become an editor.`)) {
                  void act(() => files.transfer(fileId, to.trim().replace(/^@/, '')));
                }
              }}
            >
              Transfer ownership…
            </button>
          )}
          <button type="button" className="primary-button done" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
