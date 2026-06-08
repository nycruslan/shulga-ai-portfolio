import { useState } from 'react';
import { authClient } from '../../lib/auth-client';

type Props = { signedIn?: boolean; email?: string };

export default function AdminLogin({ signedIn = false, email: initialEmail = '' }: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function go(label: string, fn: () => Promise<{ error?: { message?: string } | null }>) {
    setBusy(true);
    setMsg(label);
    try {
      const { error } = await fn();
      if (error) setMsg(error.message || 'Failed');
      else location.href = '/admin';
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    setBusy(true);
    setMsg('Follow your device prompt…');
    try {
      const { error } = (await authClient.passkey.addPasskey({ name: 'owner-device' })) ?? {};
      setMsg(error ? error.message || 'Failed' : '✓ Passkey registered. Use it next time.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  // Signed in: let the owner register a passkey, then jump to the dashboard.
  if (signedIn) {
    return (
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        <p>Signed in as <b>{email}</b>.</p>
        <button onClick={addPasskey} disabled={busy}>Add a passkey</button>
        <a href="/admin" style={{ textAlign: 'center' }}>Open dashboard →</a>
        <button
          onClick={async () => {
            await authClient.signOut();
            location.href = '/admin/login';
          }}
          disabled={busy}
          style={{ opacity: 0.7, fontSize: '0.85rem' }}
        >
          Sign out
        </button>
        {msg && <p style={{ fontSize: '0.85rem' }}>{msg}</p>}
      </div>
    );
  }

  // Signed out: passkey, then email/password, then first-run account creation.
  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      <button onClick={() => go('Follow your device prompt…', () => authClient.signIn.passkey())} disabled={busy}>
        Sign in with passkey
      </button>

      <div style={{ opacity: 0.6, fontSize: '0.85rem', textAlign: 'center' }}>or email + password</div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          go('Signing in…', () => authClient.signIn.email({ email, password }));
        }}
        style={{ display: 'grid', gap: '0.5rem' }}
      >
        <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button type="submit" disabled={busy}>Sign in</button>
      </form>

      <button
        onClick={() => go('Creating account…', () => authClient.signUp.email({ email, password, name: 'Owner' }))}
        disabled={busy}
        style={{ opacity: 0.7, fontSize: '0.85rem' }}
      >
        First time? Create the owner account (requires ADMIN_ALLOW_SIGNUP)
      </button>

      {msg && <p style={{ fontSize: '0.85rem' }}>{msg}</p>}
    </div>
  );
}
