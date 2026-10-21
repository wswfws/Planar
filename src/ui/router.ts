import { createContext, useContext, useEffect, useState } from 'react';
import type { Me } from '../collab/session';

// A tiny client-side router: the server answers every unknown path with the editor.

const EVENT = 'planar:navigate';

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new Event(EVENT));
}

export function useLocation(): { path: string; search: URLSearchParams } {
  const [, tick] = useState(0);
  useEffect(() => {
    const update = () => tick((n) => n + 1);
    window.addEventListener('popstate', update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return { path: location.pathname, search: new URLSearchParams(location.search) };
}

/** Present when the page is served by a Planar server, with the signed-in person (or null). */
export interface ServerSession {
  me: Me | null;
  setMe: (me: Me | null) => void;
}

export const ServerContext = createContext<ServerSession | null>(null);

export function useServer(): ServerSession | null {
  return useContext(ServerContext);
}
