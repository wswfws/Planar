import { useEffect, useState } from 'react';
import { accounts, detectServer, type Me } from '../collab/session';
import { AdminPage } from './AdminPage';
import { App } from './App';
import { AuthScreen } from './AuthScreen';
import { FilesHome } from './FilesHome';
import { navigate, ServerContext, useLocation } from './router';

function Splash({ text }: { text: string }) {
  return <div className="splash">{text}</div>;
}

/**
 * Chooses what to show. Without a Planar server (e.g. GitHub Pages) the editor
 * works on a local draft. With one, there are accounts, a file list and /file/<id>.
 */
export function Root() {
  const [server, setServer] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const { path, search } = useLocation();

  useEffect(() => {
    void detectServer().then(setServer);
  }, []);

  useEffect(() => {
    if (!server) return;
    accounts
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  }, [server]);

  // Links from before accounts existed (/?room=ID) open the file with that id.
  const legacy = server ? search.get('room') : null;

  // Already signed in on the way to an OAuth consent page: continue there.
  const oauthNext = me && path === '/login' ? search.get('next') : null;
  useEffect(() => {
    if (oauthNext && /^\/oauth\//.test(oauthNext)) location.replace(oauthNext);
  }, [oauthNext]);
  useEffect(() => {
    if (legacy) navigate(`/file/${encodeURIComponent(legacy)}`, true);
  }, [legacy]);

  if (server === null) return <Splash text="Loading…" />;
  if (!server) return <App />;
  if (me === undefined || legacy) return <Splash text="Loading…" />;

  const file = /^\/file\/([A-Za-z0-9_-]+)\/?$/.exec(path)?.[1];
  const session = { me, setMe };

  if (file) {
    return (
      <ServerContext.Provider value={session}>
        <App key={file} fileId={file} />
      </ServerContext.Provider>
    );
  }
  if (path === '/admin') {
    return <ServerContext.Provider value={session}>{me ? <AdminPage /> : <AuthScreen next="/admin" />}</ServerContext.Provider>;
  }
  return (
    <ServerContext.Provider value={session}>
      {me ? <FilesHome /> : <AuthScreen next={path === '/login' ? search.get('next') : null} />}
    </ServerContext.Provider>
  );
}
