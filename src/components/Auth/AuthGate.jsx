import { useEffect, useState } from 'react';
import './AuthGate.css';

export default function AuthGate({ children }) {
  const [state, setState] = useState({ phase: 'checking', username: '' });
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');

  const refreshSession = async () => {
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) {
        if (import.meta.env.DEV) {
          setState({ phase: 'ready', username: 'dev' });
          return;
        }
        setState({ phase: 'login', username: '' });
        return;
      }
      const payload = await response.json();
      if (!payload.enabled || payload.authenticated) {
        setState({ phase: 'ready', username: payload.username || '' });
      } else {
        setState({
          phase: 'login',
          username: '',
          configured: payload.configured !== false,
        });
      }
    } catch {
      if (import.meta.env.DEV) {
        setState({ phase: 'ready', username: 'dev' });
      } else {
        setState({ phase: 'login', username: '' });
      }
    }
  };

  useEffect(() => {
    refreshSession();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setState((current) => ({ ...current, phase: 'submitting' }));
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(form),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.authenticated) {
        setError(payload.error === 'auth_not_configured'
          ? 'Sunucuda henuz kullanici tanimli degil.'
          : 'Kullanici adi veya sifre hatali.');
        setState({ phase: 'login', username: '' });
        return;
      }
      setForm({ username: '', password: '' });
      setState({ phase: 'ready', username: payload.username || form.username });
    } catch {
      setError('Giris servisine ulasilamadi.');
      setState({ phase: 'login', username: '' });
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => {});
    setState({ phase: 'login', username: '' });
  };

  if (state.phase === 'checking') {
    return (
      <div className="auth-screen">
        <div className="auth-panel">
          <div className="auth-brand">BorsaMan</div>
          <p>Oturum kontrol ediliyor...</p>
        </div>
      </div>
    );
  }

  if (state.phase !== 'ready') {
    return (
      <div className="auth-screen">
        <form className="auth-panel" onSubmit={submit}>
          <div className="auth-brand">BorsaMan</div>
          <p>Devam etmek icin yetkili kullanici ile giris yap.</p>
          {error ? <div className="auth-error">{error}</div> : null}
          {state.configured === false ? (
            <div className="auth-error">Sunucuda kullanici tanimli degil.</div>
          ) : null}
          <label htmlFor="auth-username">Kullanici adi</label>
          <input
            id="auth-username"
            value={form.username}
            onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
            autoComplete="username"
            required
            autoFocus
          />
          <label htmlFor="auth-password">Sifre</label>
          <input
            id="auth-password"
            type="password"
            value={form.password}
            onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
            autoComplete="current-password"
            required
          />
          <button type="submit" disabled={state.phase === 'submitting'}>
            {state.phase === 'submitting' ? 'Giris yapiliyor...' : 'Giris yap'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <>
      <button className="auth-logout" type="button" onClick={logout}>
        Cikis
      </button>
      {children}
    </>
  );
}

