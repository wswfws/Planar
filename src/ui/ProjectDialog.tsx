import { useCallback, useEffect, useState } from 'react';
import { accounts, projects, type Me, type ProjectInfo } from '../collab/session';
import { IconButton } from './controls';

type Suggestion = Omit<Me, 'id'>;

/** People and name of a project. Everyone in a project gets the same role on all its files. */
export function ProjectDialog({ id, onClose, onChanged, onDeleted }: { id: string; onClose: () => void; onChanged: () => void; onDeleted: () => void }) {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [name, setName] = useState('');
  const owner = project?.role === 'owner';

  const load = useCallback(() => {
    projects.get(id).then(
      (p) => {
        setProject(p);
        setName(p.name);
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const q = username.trim().replace(/^@/, '');
    if (!q) return setSuggestions([]);
    const timer = setTimeout(() => void accounts.findUsers(q).then(setSuggestions, () => setSuggestions([])), 150);
    return () => clearTimeout(timer);
  }, [username]);

  const act = async (fn: () => Promise<ProjectInfo | void>) => {
    setError(null);
    try {
      const next = await fn();
      if (next) setProject(next);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const invite = (who = username) =>
    act(async () => {
      const next = await projects.setMember(id, who.trim().replace(/^@/, ''), role);
      setUsername('');
      setSuggestions([]);
      return next;
    });

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog share-dialog" role="dialog" aria-label="Project">
        <header className="dialog-header">
          <h2>{project ? project.name : 'Project'}</h2>
          <IconButton icon="close" title="Close (Esc)" onClick={onClose} />
        </header>
        <div className="dialog-body share-body">
          {owner && (
            <>
              <label className="stacked-field">
                <span>Name</span>
                <input
                  className="text-field"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => name.trim() && name.trim() !== project?.name && void act(() => projects.rename(id, name.trim()))}
                />
              </label>
              <div className="stacked-field">
                <span>Invite by username (access to every file in this project)</span>
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
            </>
          )}
          {project && (
            <div className="people">
              {project.owner && (
                <div className="person">
                  <span className="peer-dot" style={{ background: project.owner.color }} />
                  <span className="person-name">
                    {project.owner.displayName} <span className="hint">@{project.owner.username}</span>
                  </span>
                  <span className="hint">Owner</span>
                </div>
              )}
              {project.members?.map((m) => (
                <div className="person" key={m.id}>
                  <span className="peer-dot" style={{ background: m.color }} />
                  <span className="person-name">
                    {m.displayName} <span className="hint">@{m.username}</span>
                  </span>
                  {owner ? (
                    <>
                      <select value={m.role} onChange={(e) => act(() => projects.setMember(id, m.username, e.target.value as 'editor' | 'viewer'))} aria-label={`Role of ${m.username}`}>
                        <option value="editor">Can edit</option>
                        <option value="viewer">Can view</option>
                      </select>
                      <button type="button" className="link-button" onClick={() => act(() => projects.setMember(id, m.username, null))}>
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
          {error && <p className="share-error">{error}</p>}
        </div>
        <footer className="dialog-footer">
          {owner && (
            <button
              type="button"
              className="small-button danger"
              onClick={() => confirm(`Delete the project “${project?.name}”? Its files are kept, just not grouped any more.`) && void projects.remove(id).then(onDeleted, (e: Error) => setError(e.message))}
            >
              Delete project
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="small-button" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
