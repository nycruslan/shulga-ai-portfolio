import { useState } from 'react';
import { authClient } from '../../lib/auth-client';

type Props = { signedIn?: boolean; email?: string };

const PRIMARY =
  'w-full rounded-lg bg-text px-3.5 py-2.5 text-sm font-medium text-bg transition-colors hover:bg-white disabled:opacity-50';
const GHOST =
  'w-full rounded-lg border border-border-strong bg-white/[0.03] px-3.5 py-2.5 text-sm text-text transition-colors hover:bg-white/[0.06] disabled:opacity-50';
const SUBTLE =
  'w-full rounded-lg px-3.5 py-2 text-xs text-text-subtle transition-colors hover:text-text-muted disabled:opacity-50';
const INPUT =
  'w-full rounded-lg border border-border-strong bg-white/[0.03] px-3.5 py-2.5 text-sm text-text placeholder:text-text-subtle outline-none transition-colors focus:border-text/40';

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

  // Signed in: register a passkey or jump to the dashboard.
  if (signedIn) {
    return (
      <div className="grid gap-3">
        <p className="text-center text-sm text-text-muted">
          Signed in as <span className="text-text">{email}</span>
        </p>
        <button className={PRIMARY} onClick={addPasskey} disabled={busy}>Add a passkey</button>
        <a className={GHOST + ' text-center'} href="/admin">Open dashboard →</a>
        <button
          className={SUBTLE}
          disabled={busy}
          onClick={async () => {
            await authClient.signOut();
            location.href = '/admin/login';
          }}
        >Sign out</button>
        {msg && <p className="text-center text-xs text-text-muted">{msg}</p>}
      </div>
    );
  }

  // Signed out: passkey, then email/password, then first-run account creation.
  return (
    <div className="grid gap-3">
      <button className={PRIMARY} disabled={busy} onClick={() => go('Follow your device prompt…', () => authClient.signIn.passkey())}>
        Sign in with passkey
      </button>

      <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-text-subtle">
        <span className="h-px flex-1 bg-border" /> or email <span className="h-px flex-1 bg-border" />
      </div>

      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          go('Signing in…', () => authClient.signIn.email({ email, password }));
        }}
      >
        <input className={INPUT} type="email" placeholder="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className={INPUT} type="password" placeholder="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className={GHOST} type="submit" disabled={busy}>Sign in</button>
      </form>

      <button
        className={SUBTLE}
        disabled={busy}
        onClick={() => go('Creating account…', () => authClient.signUp.email({ email, password, name: 'Owner' }))}
      >
        First time? Create the owner account
      </button>

      {msg && <p className="text-center text-xs text-text-muted">{msg}</p>}
    </div>
  );
}
