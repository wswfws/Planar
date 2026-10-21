import { useState, type FormEvent } from 'react';
import { accounts } from '../collab/session';
import { navigate, useServer } from './router';

/** Sign in or create an account. `next` is where to go afterwards (a path on this site). */
export function AuthScreen({ next }: { next: string | null }) {
  const server = useServer()!;
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user =
        mode === 'login'
          ? await accounts.login(username.trim(), password)
          : await accounts.register(username.trim(), password, displayName.trim());
      server.setMe(user);
      // Only paths on this site, never other addresses.
      if (next && /^\/(?!\/)/.test(next)) navigate(next, true);
      else navigate('/', true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>Planar</h1>
        <p className="hint">{mode === 'login' ? 'Sign in to your files.' : 'Create an account to keep your files on this server and share them.'}</p>
        <label className="stacked-field">
          <span>Username</span>
          <input
            className="text-field"
            autoFocus
            autoComplete="username"
            value={username}
            maxLength={32}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        {mode === 'register' && (
          <label className="stacked-field">
            <span>Display name (optional)</span>
            <input className="text-field" value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        )}
        <label className="stacked-field">
          <span>Password{mode === 'register' ? ' (at least 8 characters)' : ''}</span>
          <input
            className="text-field"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="share-error">{error}</p>}
        <button type="submit" className="primary-button" disabled={busy || !username.trim() || !password}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'No account yet? Create one' : 'Have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
