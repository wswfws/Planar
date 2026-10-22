import { useCallback, useEffect, useRef, useState } from 'react';
import { files, fileLink, type FileInfo, type FileScope } from '../collab/session';
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

function Card({ file, scope, reload, onError }: { file: FileInfo; scope: FileScope; reload: () => void; onError: (m: string) => void }) {
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
  const importRef = useRef<HTMLInputElement>(null);
  const draft = (() => {
    try {
      return localStorage.getItem('planar:document');
    } catch {
      return null;
    }
  })();

  const reload = useCallback(() => {
    files.list(scope).then(
      (f) => {
        setList(f);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [scope]);
  useEffect(() => {
    setList(null);
    reload();
  }, [reload]);

  const create = async (body: Parameters<typeof files.create>[0]) => {
    try {
      const f = await files.create(body);
      navigate(`/file/${f.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const tab = TABS.find((t) => t.scope === scope)!;

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
          <button key={t.scope} type="button" role="tab" aria-selected={scope === t.scope} className={scope === t.scope ? 'active' : ''} onClick={() => setScope(t.scope)}>
            {t.label}
          </button>
        ))}
      </nav>
      {error && <p className="share-error home-error">{error}</p>}
      <main className="file-grid">
        {list?.map((f) => <Card key={f.id} file={f} scope={scope} reload={reload} onError={setError} />)}
        {list && !list.length && <p className="hint">{tab.empty}</p>}
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
            await create({ doc: JSON.parse(await file.text()), name: file.name.replace(/\.planar\.json$|\.json$/i, '') });
          } catch {
            setError('That file is not a Planar document');
          }
        }}
      />
      {account && <AccountDialog onClose={() => setAccount(false)} />}
    </div>
  );
}
