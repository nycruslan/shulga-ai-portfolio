import { useState } from 'react';
import { authClient } from '../../lib/auth-client';

type Props = { signedIn?: boolean; email?: string; googleReady?: boolean };

const PRIMARY =
  'w-full rounded-lg bg-text px-3.5 py-2.5 text-sm font-medium text-bg transition-colors hover:bg-white disabled:opacity-50';
const GHOST =
  'w-full rounded-lg border border-border-strong bg-white/[0.03] px-3.5 py-2.5 text-sm text-text transition-colors hover:bg-white/[0.06] disabled:opacity-50';
const SUBTLE =
  'w-full rounded-lg px-3.5 py-2 text-xs text-text-subtle transition-colors hover:text-text-muted disabled:opacity-50';
const INPUT =
  'w-full rounded-lg border border-border-strong bg-white/[0.03] px-3.5 py-2.5 text-sm text-text placeholder:text-text-subtle outline-none transition-colors focus:border-text/40';

type Note = { text: string; error?: boolean } | null;

function Feedback({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={'text-center text-xs ' + (note.error ? 'text-rose-300' : 'text-text-muted')}
    >
      {note.text}
    </p>
  );
}

export default function AdminLogin({
  signedIn = false,
  email: initialEmail = '',
  googleReady = false,
}: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [note, setNote] = useState<Note>(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('denied')
      ? { text: 'That account is not on the admin allowlist.', error: true }
      : null,
  );
  const [busy, setBusy] = useState(false);
  // Open the password fallback by default when Google isn't wired, so there's
  // always a visible way in.
  const [showPassword, setShowPassword] = useState(!googleReady);

  async function go(label: string, fn: () => Promise<{ error?: { message?: string } | null }>) {
    setBusy(true);
    setNote({ text: label });
    try {
      const { error } = await fn();
      if (error) setNote({ text: error.message || 'Failed', error: true });
      else {
        // Remember the owner on this device so ⌘K can surface an admin link.
        try {
          localStorage.setItem('bridge-owner', '1');
        } catch {
          /* private mode — the Konami shortcut still works */
        }
        location.href = '/admin';
      }
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Failed', error: true });
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    setNote({ text: 'Redirecting to Google…' });
    try {
      // Redirects the browser to Google, then back to /admin on success. The
      // allowlist is enforced server-side, so a non-invited Google email is
      // bounced with an error rather than getting an account.
      await authClient.signIn.social({
        provider: 'google',
        callbackURL: '/admin',
        errorCallbackURL: '/admin/login?denied=1',
      });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Failed', error: true });
      setBusy(false);
    }
  }

  async function addPasskey() {
    setBusy(true);
    setNote({ text: 'Follow your device prompt…' });
    try {
      const { error } = (await authClient.passkey.addPasskey({ name: 'owner-device' })) ?? {};
      setNote(
        error
          ? { text: error.message || 'Failed', error: true }
          : { text: '✓ Passkey registered. Use it next time.' },
      );
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Failed', error: true });
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
        <button className={PRIMARY} onClick={addPasskey} disabled={busy}>
          Add a passkey
        </button>
        <a className={GHOST + ' text-center'} href="/admin">
          Open dashboard →
        </a>
        <button
          className={SUBTLE}
          disabled={busy}
          onClick={async () => {
            await authClient.signOut();
            location.href = '/admin/login';
          }}
        >
          Sign out
        </button>
        <Feedback note={note} />
      </div>
    );
  }

  // Signed out: Google one-click and passkey are the two real doors. Email +
  // password is kept only as an owner break-glass, tucked behind a toggle.
  return (
    <div className="grid gap-3">
      {googleReady && (
        <button className={PRIMARY} disabled={busy} onClick={google}>
          Continue with Google
        </button>
      )}
      <button
        className={googleReady ? GHOST : PRIMARY}
        disabled={busy}
        onClick={() => go('Follow your device prompt…', () => authClient.signIn.passkey())}
      >
        Sign in with a passkey
      </button>

      <button
        className={SUBTLE}
        disabled={busy}
        onClick={() => setShowPassword((v) => !v)}
        aria-expanded={showPassword}
      >
        {showPassword ? 'Hide password sign-in' : 'Use email & password instead'}
      </button>

      {showPassword && (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            go('Signing in…', () => authClient.signIn.email({ email, password }));
          }}
        >
          <input
            className={INPUT}
            type="email"
            placeholder="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className={INPUT}
            type="password"
            placeholder="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className={GHOST} type="submit" disabled={busy}>
            Sign in
          </button>
        </form>
      )}

      <Feedback note={note} />
    </div>
  );
}
