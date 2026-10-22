import { FigmaImportDialog, looksLikeFigmaFile } from './FigmaImportDialog';
import { figmaToPlanar } from '../import/figma';
import { useCallback, useEffect, useRef, useState } from 'react';
import { files, fileLink, projects, type FileInfo, type FileScope, type ProjectInfo } from '../collab/session';
import { ProjectDialog } from './ProjectDialog';
import { AccountDialog } from './AccountDialog';
import { Icon } from './icons';
import { navigate, useServer } from './router';

const TABS: { scope: FileScope; label: string; empty: string }[] = [
  { scope: 'mine', label: 'My files', empty: 'No files yet. Create one or import a .planar.json.' },
  { scope: 'shared', label: 'Shared with me', empty: 'Nothing has been shared with you yet.' },
  { scope: 'trash', label: 'Trash', empty: 'The trash is empty.' },
];

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

const ROLE_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' } as const;

function CardMenu({ items }: { items: ({ label: string; action: () => void; danger?: boolean } | '-')[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="dropdown card-menu" ref={ref}>
      <button type="button" className="toolbar-button" aria-label="File actions" onClick={() => setOpen(!open)}>
        <Icon name="menu" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((item, i) =>
            item === '-' ? (
              <div key={i} className="menu-separator" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={item.danger ? 'danger' : undefined}
                onClick={() => {
                  setOpen(false);
                  item.action();
                }}
              >
                <span>{item.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function Card({ file, scope, reload, onError, onMove }: { file: FileInfo; scope: FileScope; reload: () => void; onError: (m: string) => void; onMove: (f: FileInfo) => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(file.name);
  const [noThumb, setNoThumb] = useState(false);
  const attempt = (fn: () => Promise<unknown>) => fn().then(reload, (e: Error) => onError(e.message));
  const open = () => navigate(`/file/${file.id}`);
  const canEdit = file.role === 'owner' || file.role === 'editor';

  const items: ({ label: string; action: () => void; danger?: boolean } | '-')[] =
    scope === 'trash'
      ? [
          { label: 'Restore', action: () => void attempt(() => files.restore(file.id)) },
          '-',
          {
            label: 'Delete forever',
            danger: true,
            action: () => confirm(`Delete “${file.name}” forever? This cannot be undone.`) && void attempt(() => files.deleteForever(file.id)),
          },
        ]
      : [
          { label: 'Open', action: open },
          { label: 'Open in new tab', action: () => window.open(`/file/${file.id}`, '_blank') },
          ...(canEdit ? [{ label: 'Rename', action: () => setRenaming(true) }] : []),
          { label: 'Duplicate', action: () => void attempt(() => files.duplicate(file.id)) },
          ...(file.role === 'owner' ? [{ label: 'Move to project…', action: () => onMove(file) }] : []),
          { label: 'Copy link', action: () => void navigator.clipboard.writeText(fileLink(file.id)).catch(() => undefined) },
          { label: 'Download .planar.json', action: () => (location.href = files.downloadUrl(file.id)) },
          ...(file.role === 'owner' ? ['-' as const, { label: 'Move to trash', danger: true, action: () => void attempt(() => files.trash(file.id)) }] : []),
        ];

  const commitRename = () => {
    setRenaming(false);
    const next = name.trim();
    if (next && next !== file.name) void attempt(() => files.rename(file.id, next));
    else setName(file.name);
  };

  return (
    <div className="file-card">
      <button type="button" className="file-thumb" onClick={scope === 'trash' ? undefined : open} aria-label={`Open ${file.name}`} disabled={scope === 'trash'}>
        {noThumb ? (
          <Icon name="frame" size={28} />
        ) : (
          <img src={files.thumbnailUrl(file.id, file.updatedAt)} alt="" loading="lazy" onError={() => setNoThumb(true)} onLoad={(e) => (e.currentTarget.naturalWidth ? undefined : setNoThumb(true))} />
        )}
      </button>
      <div className="file-meta">
        <div className="file-title">
          {renaming ? (
            <input
              className="text-field"
              autoFocus
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') {
                  setName(file.name);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <b title={file.name}>{file.name}</b>
          )}
          <CardMenu items={items} />
        </div>
        <span className="hint">
          {scope === 'shared' && file.owner ? `${file.owner.displayName} · ` : ''}
          {file.role && scope === 'shared' ? `${ROLE_LABEL[file.role]} · ` : ''}
          {scope === 'trash' && file.deletedAt ? `Deleted ${ago(file.deletedAt)}` : `Edited ${ago(file.updatedAt)}`}
          {file.linkAccess !== 'none' && scope !== 'trash' ? ' · Link' : ''}
          {file.unreadComments ? <span className="badge">{file.unreadComments} new comment{file.unreadComments === 1 ? '' : 's'}</span> : null}
        </span>
      </div>
    </div>
  );
}

export function FilesHome() {
  const server = useServer()!;
  const me = server.me!;
  const [scope, setScope] = useState<FileScope>('mine');
  const [list, setList] = useState<FileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState(false);
  const [projectList, setProjectList] = useState<ProjectInfo[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [projectDialog, setProjectDialog] = useState<string | null>(null);
  const [moving, setMoving] = useState<FileInfo | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const [figmaOpen, setFigmaOpen] = useState(false);
  const draft = (() => {
    try {
      return localStorage.getItem('planar:document');
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  const reloadProjects = useCallback(() => {
    projects.list().then(setProjectList, () => undefined);
  }, []);
  useEffect(reloadProjects, [reloadProjects]);

  const reload = useCallback(() => {
    // Searching looks through everything; a project shows its own files.
    const searching = !!query && scope !== 'trash';
    files.list(searching || project ? 'all' : scope, { q: query, project: project && !searching ? project : undefined }).then(
      (f) => {
        setList(f);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
    reloadProjects();
  }, [scope, query, project, reloadProjects]);
  useEffect(() => {
    setList(null);
    reload();
  }, [reload]);

  const create = async (body: Parameters<typeof files.create>[0]) => {
    try {
      const f = await files.create(body);
      if (project && projectList.find((p) => p.id === project && (p.role === 'owner' || p.role === 'editor'))) await files.move(f.id, project).catch(() => undefined);
      navigate(`/file/${f.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const tab = TABS.find((t) => t.scope === scope)!;
  const current = projectList.find((p) => p.id === project) ?? null;
  const newProject = async () => {
    const name = prompt('Project name');
    if (!name?.trim()) return;
    try {
      const p = await projects.create(name.trim());
      reloadProjects();
      setProject(p.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="home">
      <header className="home-header">
        <h1>Planar</h1>
        <div className="home-actions">
          <button type="button" className="primary-button" onClick={() => create({})}>
            + New file
          </button>
          <button type="button" className="small-button" onClick={() => importRef.current?.click()}>
            Import…
          </button>
          <button type="button" className="small-button" onClick={() => setFigmaOpen(true)}>
            Import from Figma…
          </button>
          {draft && (
            <button
              type="button"
              className="small-button"
              title="Upload the document you were editing in this browser before signing in"
              onClick={() => {
                try {
                  void create({ doc: JSON.parse(draft) });
                } catch {
                  setError('The local draft could not be read');
                }
              }}
            >
              Upload local draft
            </button>
          )}
          {me.admin && (
            <button type="button" className="small-button" onClick={() => navigate('/admin')}>
              Admin
            </button>
          )}
          <button type="button" className="avatar-chip" onClick={() => setAccount(true)} title="Account and API keys">
            <span className="avatar" style={{ background: me.color }}>
              {me.displayName.slice(0, 1).toUpperCase()}
            </span>
            {me.displayName}
          </button>
        </div>
      </header>
      <nav className="home-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.scope}
            type="button"
            role="tab"
            aria-selected={!project && scope === t.scope}
            className={!project && scope === t.scope ? 'active' : ''}
            onClick={() => {
              setProject(null);
              setScope(t.scope);
            }}
          >
            {t.label}
          </button>
        ))}
        <input className="home-search" type="search" placeholder="Search files…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search files" />
      </nav>
      <div className="home-projects">
        <span className="hint">Projects</span>
        {projectList.map((p) => (
          <button key={p.id} type="button" className={`chip${p.id === project ? ' active' : ''}`} onClick={() => setProject(p.id === project ? null : p.id)}>
            {p.name} <span className="hint">{p.files}</span>
          </button>
        ))}
        <button type="button" className="chip" onClick={newProject}>
          + New project
        </button>
        {current && (
          <button type="button" className="small-button" onClick={() => setProjectDialog(current.id)}>
            {current.role === 'owner' ? 'Share project…' : 'People'}
          </button>
        )}
      </div>
      {error && <p className="share-error home-error">{error}</p>}
      <main className="file-grid">
        {list?.map((f) => <Card key={f.id} file={f} scope={project || query ? 'mine' : scope} reload={reload} onError={setError} onMove={setMoving} />)}
        {list && !list.length && <p className="hint">{query ? 'No files match your search.' : project ? 'This project has no files yet. Move files here with “Move to project…”.' : tab.empty}</p>}
        {!list && !error && <p className="hint">Loading…</p>}
      </main>
      <input
        ref={importRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            const data = JSON.parse(await file.text());
            // The JSON of a Figma file (from its REST API) is converted on the way in.
            if (looksLikeFigmaFile(data)) await create({ doc: figmaToPlanar(data).doc });
            else await create({ doc: data, name: file.name.replace(/\.planar\.json$|\.json$/i, '') });
          } catch {
            setError('That file is not a Planar document');
          }
        }}
      />
      {account && <AccountDialog onClose={() => setAccount(false)} />}
      {figmaOpen && <FigmaImportDialog onClose={() => setFigmaOpen(false)} onCreate={(doc) => create({ doc })} />}
      {projectDialog && (
        <ProjectDialog
          id={projectDialog}
          onClose={() => setProjectDialog(null)}
          onChanged={() => {
            reloadProjects();
            reload();
          }}
          onDeleted={() => {
            setProject(null);
            setProjectDialog(null);
            reloadProjects();
          }}
        />
      )}
      {moving && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setMoving(null)}>
          <div className="dialog share-dialog" role="dialog" aria-label="Move to project">
            <header className="dialog-header">
              <h2>Move “{moving.name}”</h2>
            </header>
            <div className="dialog-body share-body">
              {[null, ...projectList.filter((p) => p.role === 'owner' || p.role === 'editor')].map((p) => (
                <button
                  key={p?.id ?? 'none'}
                  type="button"
                  className={`chip move-option${(moving.projectId ?? null) === (p?.id ?? null) ? ' active' : ''}`}
                  onClick={() => {
                    const file = moving;
                    setMoving(null);
                    void files.move(file.id, p?.id ?? null).then(reload, (e: Error) => setError(e.message));
                  }}
                >
                  {p ? p.name : 'No project'}
                </button>
              ))}
            </div>
            <footer className="dialog-footer">
              <button type="button" className="small-button" onClick={() => setMoving(null)}>
                Cancel
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
