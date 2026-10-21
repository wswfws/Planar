import { useCallback, useEffect, useState } from 'react';
import { admin, type AdminFile, type AdminOverview, type AdminSettings, type AdminUser, type LinkAccess } from '../collab/session';
import { navigate, useServer } from './router';

type Tab = 'overview' | 'users' | 'files' | 'settings';

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function ago(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** A small area chart of the last 24 hours (one point per minute). */
function Sparkline({ title, values, format = String, color = 'var(--accent)' }: { title: string; values: number[]; format?: (n: number) => string; color?: string }) {
  const w = 300;
  const h = 64;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${values.length > 1 ? (i / (values.length - 1)) * w : w},${h - (v / max) * (h - 4)}`);
  const last = values[values.length - 1] ?? 0;
  return (
    <div className="chart">
      <div className="chart-head">
        <span>{title}</span>
        <b>{format(last)}</b>
      </div>
      {values.length > 1 ? (
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${title}, last 24 hours, peak ${format(max)}`}>
          <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={color} opacity="0.15" />
          <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <div className="chart-empty hint">Collecting data — one point a minute</div>
      )}
      <div className="chart-foot hint">
        <span>24 h</span>
        <span>peak {format(max)}</span>
      </div>
    </div>
  );
}

/** Daily bars for the last 30 days. */
function Bars({ title, days, field }: { title: string; days: AdminOverview['days']; field: 'registrations' | 'active' | 'edits' | 'errors' }) {
  const max = Math.max(1, ...days.map((d) => d[field]));
  const total = days.reduce((a, d) => a + d[field], 0);
  return (
    <div className="chart">
      <div className="chart-head">
        <span>{title}</span>
        <b>{days[days.length - 1]?.[field] ?? 0} today</b>
      </div>
      <div className="bars">
        {days.map((d) => (
          <span key={d.day} title={`${d.day}: ${d[field]}`} style={{ height: `${Math.max(2, (d[field] / max) * 100)}%` }} />
        ))}
      </div>
      <div className="chart-foot hint">
        <span>{days.length} days</span>
        <span>total {total}</span>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, warn }: { label: string; value: string | number; sub?: string; warn?: boolean }) {
  return (
    <div className={`tile${warn ? ' warn' : ''}`}>
      <span className="hint">{label}</span>
      <b>{value}</b>
      {sub && <span className="hint">{sub}</span>}
    </div>
  );
}

function Overview({ data }: { data: AdminOverview }) {
  const g = data.gauges;
  const s = data.series;
  const today = data.days[data.days.length - 1];
  const errors24 = s.reduce((a, p) => a + p.errors, 0);
  const diskLow = g.disk ? g.disk.free / g.disk.total < 0.1 : false;
  return (
    <>
      <div className="tiles">
        <Tile label="Users" value={g.users} sub={`${g.usersOnline} online now${g.blockedUsers ? ` · ${g.blockedUsers} blocked` : ''}`} />
        <Tile label="Files" value={g.files} sub={`${g.openFiles} open · ${g.trashedFiles} in trash`} />
        <Tile label="Connections" value={g.sockets} sub={`${g.mcpSessions} agent (MCP) sessions`} />
        <Tile label="Today" value={today?.edits ?? 0} sub={`edit batches · ${today?.active ?? 0} active · ${today?.registrations ?? 0} new`} />
        <Tile label="Errors, 24 h" value={errors24} sub={`${data.counters.rate_limited ?? 0} rate-limited since start`} warn={errors24 > 0} />
        <Tile label="Memory" value={bytes(g.rss)} sub={`${bytes(g.memFree)} free of ${bytes(g.memTotal)}`} />
        <Tile label="Disk" value={g.disk ? bytes(g.disk.free) : '—'} sub={g.disk ? `free of ${bytes(g.disk.total)} · data ${bytes(g.dataBytes)}` : 'in-memory'} warn={diskLow} />
        <Tile label="Uptime" value={duration(g.uptime)} sub={`load ${g.load[0].toFixed(2)} / ${g.cpus} CPU · ${g.node}`} />
      </div>
      <div className="charts">
        <Sparkline title="People online" values={s.map((p) => p.online)} />
        <Sparkline title="Edits per minute" values={s.map((p) => p.ops)} color="#4cc38a" />
        <Sparkline title="Requests per minute" values={s.map((p) => p.requests)} color="#3e9bf0" />
        <Sparkline title="Server errors per minute" values={s.map((p) => p.errors)} color="var(--danger)" />
        <Sparkline title="Memory (RSS)" values={s.map((p) => p.rss)} format={bytes} color="#f2a65a" />
        <Bars title="New users per day" days={data.days} field="registrations" />
        <Bars title="Active users per day" days={data.days} field="active" />
        <Bars title="Edits per day" days={data.days} field="edits" />
      </div>
      <h3 className="admin-h">Recent events</h3>
      <div className="events">
        {data.events.length ? (
          data.events.map((e, i) => (
            <div key={i} className={`event ${e.kind}`}>
              <span className="hint">{new Date(e.t).toLocaleString()}</span>
              <span className="event-kind">{e.kind}</span>
              <span>{e.text}</span>
            </div>
          ))
        ) : (
          <p className="hint">Nothing yet.</p>
        )}
      </div>
    </>
  );
}

function Users({ me, onError }: { me: string; onError: (m: string | null) => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<AdminUser[] | null>(null);
  const load = useCallback(() => void admin.users(q).then(setList, (e: Error) => onError(e.message)), [q, onError]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  const act = (fn: () => Promise<unknown>) => fn().then(load, (e: Error) => onError(e.message));

  const remove = (u: AdminUser) => {
    const heir = prompt(
      `Delete @${u.username}? Their ${u.files} file(s) can go to another user — type a username, or leave empty to delete the files too.`,
      '',
    );
    if (heir === null) return;
    const mode = heir.trim() ? (`transfer:${heir.trim().replace(/^@/, '')}` as const) : ('delete' as const);
    if (mode === 'delete' && u.files && !confirm(`Also delete ${u.files} file(s) forever?`)) return;
    void act(() => admin.deleteUser(u.id, mode));
  };

  return (
    <>
      <input className="text-field admin-search" placeholder="Search users" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Joined</th>
              <th>Last seen</th>
              <th>Files</th>
              <th>Keys</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list?.map((u) => (
              <tr key={u.id} className={u.blocked ? 'muted' : ''}>
                <td>
                  <span className="peer-dot" style={{ background: u.color }} /> <b>{u.displayName}</b> <span className="hint">@{u.username}</span>
                  {u.online && <span className="badge small">online</span>}
                  {u.admin && <span className="badge small">admin</span>}
                  {u.blocked && <span className="badge small danger">blocked</span>}
                </td>
                <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>{ago(u.lastSeenAt)}</td>
                <td>
                  {u.files} <span className="hint">{bytes(u.bytes)}</span>
                </td>
                <td>{u.keys}</td>
                <td className="actions">
                  {u.username !== me && (
                    <>
                      <button type="button" className="link-button" onClick={() => act(() => admin.setBlocked(u.id, !u.blocked))}>
                        {u.blocked ? 'Unblock' : 'Block'}
                      </button>
                      <button type="button" className="link-button" onClick={() => act(() => admin.signOut(u.id))}>
                        Sign out
                      </button>
                      <button type="button" className="link-button danger" onClick={() => remove(u)}>
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list && !list.length && <p className="hint">No users found.</p>}
    </>
  );
}

const LINK: Record<LinkAccess, string> = { none: 'private', view: 'link: view', edit: 'link: edit' };

function Files({ onError }: { onError: (m: string | null) => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<AdminFile[] | null>(null);
  const load = useCallback(() => void admin.files(q).then(setList, (e: Error) => onError(e.message)), [q, onError]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  const act = (fn: () => Promise<unknown>) => fn().then(load, (e: Error) => onError(e.message));

  return (
    <>
      <input className="text-field admin-search" placeholder="Search by name, id or owner" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Owner</th>
              <th>Edited</th>
              <th>Size</th>
              <th>Access</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list?.map((f) => (
              <tr key={f.id} className={f.deletedAt ? 'muted' : ''}>
                <td>
                  <b>{f.name}</b> <span className="hint">{f.id}</span>
                  {f.online > 0 && <span className="badge small">{f.online} open</span>}
                  {f.deletedAt && <span className="badge small">trash</span>}
                </td>
                <td>{f.owner ? `@${f.owner.username}` : <span className="hint">nobody</span>}</td>
                <td>{ago(f.updatedAt)}</td>
                <td>{bytes(f.bytes)}</td>
                <td>
                  {LINK[f.linkAccess]}
                  {f.members ? <span className="hint"> · {f.members} people</span> : null}
                </td>
                <td className="actions">
                  {f.linkAccess !== 'none' && (
                    <button type="button" className="link-button" onClick={() => act(() => admin.updateFile(f.id, { linkAccess: 'none' }))}>
                      Close link
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      const to = prompt(`Give "${f.name}" to (username):`);
                      if (to?.trim()) void act(() => admin.updateFile(f.id, { ownerUsername: to.trim().replace(/^@/, '') }));
                    }}
                  >
                    Give to…
                  </button>
                  <button
                    type="button"
                    className="link-button danger"
                    onClick={() => confirm(`Delete "${f.name}" forever? This cannot be undone.`) && void act(() => admin.deleteFile(f.id))}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list && !list.length && <p className="hint">No files found.</p>}
    </>
  );
}

function Settings({ data, reload, onError }: { data: AdminOverview; reload: () => void; onError: (m: string | null) => void }) {
  const [s, setS] = useState<AdminSettings>(data.settings);
  const [note, setNote] = useState<string | null>(null);
  const save = (next: Partial<AdminSettings>) =>
    admin.saveSettings(next).then(
      (saved) => {
        setS(saved);
        setNote('Saved');
        reload();
      },
      (e: Error) => onError(e.message),
    );
  return (
    <div className="admin-settings">
      <label className="switch">
        <input type="checkbox" checked={s.registrationOpen} onChange={(e) => save({ registrationOpen: e.target.checked })} />
        Anyone can create an account
      </label>
      <div className="grid-2">
        <label className="stacked-field">
          <span>Files per user</span>
          <input className="text-field" type="number" min={1} value={s.maxFilesPerUser} onChange={(e) => setS({ ...s, maxFilesPerUser: Number(e.target.value) })} />
        </label>
        <label className="stacked-field">
          <span>Largest document, MB</span>
          <input
            className="text-field"
            type="number"
            min={1}
            value={Math.round(s.maxFileBytes / 1048576)}
            onChange={(e) => setS({ ...s, maxFileBytes: Number(e.target.value) * 1048576 })}
          />
        </label>
      </div>
      <div>
        <button type="button" className="small-button" onClick={() => save({ maxFilesPerUser: s.maxFilesPerUser, maxFileBytes: s.maxFileBytes })}>
          Save limits
        </button>
      </div>
      <h3 className="admin-h">Telegram alerts</h3>
      {data.alerts.configured ? (
        <>
          <p className="hint">
            Configured. You get: server start, new users, error spikes, low disk or memory, many failed sign-ins, crashes, and a summary every morning at 09:00.
          </p>
          <div>
            <button
              type="button"
              className="small-button"
              onClick={() =>
                admin.testAlert().then(
                  () => setNote('Test message sent — check Telegram'),
                  (e: Error) => onError(e.message),
                )
              }
            >
              Send a test message
            </button>
          </div>
        </>
      ) : (
        <p className="hint">Not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the server’s .env and restart (see docs/SELF_HOSTING.md).</p>
      )}
      {note && <p className="hint">{note}</p>}
    </div>
  );
}

export function AdminPage() {
  const server = useServer()!;
  const me = server.me!;
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  const reload = useCallback(() => {
    admin.overview().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: Error & { status?: number }) => (e.status === 404 ? setDenied(true) : setError(e.message)),
    );
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [reload]);

  if (denied || !me.admin) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>Not found</h2>
          <button type="button" className="small-button" onClick={() => navigate('/')}>
            Back to files
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="home admin">
      <header className="home-header">
        <h1>Planar admin</h1>
        <div className="home-actions">
          <span className="hint">{data ? `updated ${new Date(data.now).toLocaleTimeString()}` : 'loading…'}</span>
          <button type="button" className="small-button" onClick={() => navigate('/')}>
            Back to files
          </button>
        </div>
      </header>
      <nav className="home-tabs" role="tablist">
        {(['overview', 'users', 'files', 'settings'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {error && <p className="share-error home-error">{error}</p>}
      <main className="admin-body">
        {tab === 'overview' && data && <Overview data={data} />}
        {tab === 'users' && <Users me={me.username} onError={setError} />}
        {tab === 'files' && <Files onError={setError} />}
        {tab === 'settings' && data && <Settings data={data} reload={reload} onError={setError} />}
      </main>
    </div>
  );
}
