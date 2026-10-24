import { useState, type FormEvent } from 'react';
import { adminApi, AdminApiError } from './api';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await adminApi.login(password);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : 'Login failed');
      setBusy(false);
    }
  };

  return (
    <form className="admin-login" onSubmit={submit}>
      <div className="portrait" aria-hidden="true" />
      <h1>IpsenGPT admin</h1>
      <input
        className="admin-input"
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        aria-label="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      <button className="btn btn--primary" type="submit" disabled={!password || busy}>
        Log in
      </button>
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
