import { useState } from 'react';
import { authClient } from '../../lib/auth-client';

export default function AdminLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(label: string, fn: () => Promise<{ error?: { message?: string } | null }>) {
    setBusy(true);
    setMsg(label);
    try {
      const { error } = await fn();
      if (error) {
        setMsg(error.message || 'Failed');
      } else {
        location.href = '/admin';
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      <button onClick={() => run('Waiting for passkey…', () => authClient.signIn.passkey())} disabled={busy}>
        Sign in with passkey
      </button>

      <div style={{ opacity: 0.6, fontSize: '0.85rem', textAlign: 'center' }}>or email + password</div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run('Signing in…', () => authClient.signIn.email({ email, password }));
        }}
        style={{ display: 'grid', gap: '0.5rem' }}
      >
        <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button type="submit" disabled={busy}>Sign in</button>
      </form>

      <button
        onClick={() => run('Creating account…', () => authClient.signUp.email({ email, password, name: 'Owner' }))}
        disabled={busy}
        style={{ opacity: 0.7, fontSize: '0.85rem' }}
      >
        First time? Create the owner account (requires ADMIN_ALLOW_SIGNUP)
      </button>

      <button
        onClick={() => run('Registering passkey…', async () => {
          const r = await authClient.passkey.addPasskey({ name: 'owner-device' });
          return { error: r?.error ?? null };
        })}
        disabled={busy}
        style={{ opacity: 0.7, fontSize: '0.85rem' }}
      >
        Add a passkey (after signing in)
      </button>

      {msg && <p style={{ fontSize: '0.85rem' }}>{msg}</p>}
    </div>
  );
}
