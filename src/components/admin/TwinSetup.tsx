import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * Twin configurator: face, voice, facts.
 *
 * The completeness meter is borrowed from Delphi's "Mind Score" — a running
 * number makes "how much is enough?" answerable, which is the hardest part of
 * persona setup. Without it a form is either submitted or not, and a
 * half-filled brief looks finished.
 */

export interface TwinFacts {
  name: string;
  bio: string;
  speech: string;
  opinions: string;
  avoid: string;
  history: string;
}

export interface TwinConfig {
  avatarId: string | null;
  avatarProvider: string | null;
  avatarPreviewUrl: string | null;
  voiceId: string | null;
  voiceName: string | null;
  facts: TwinFacts;
  updatedAt: string | null;
}

interface Props {
  initial: TwinConfig;
  anamEnabled: boolean;
  elevenEnabled: boolean;
}

// Mirrors completeness() in src/lib/twin-config.ts. Duplicated rather than
// imported so the meter updates as you type, before anything is saved.
const WEIGHTS: Array<[keyof TwinFacts, number]> = [
  ['name', 5],
  ['bio', 15],
  ['speech', 10],
  ['opinions', 10],
  ['history', 7],
  ['avoid', 3],
];

function scoreOf(c: TwinConfig, facts: TwinFacts): number {
  let n = 0;
  if (c.avatarId) n += 25;
  if (c.voiceId) n += 25;
  for (const [k, w] of WEIGHTS) if (facts[k]?.trim()) n += w;
  return n;
}

export default function TwinSetup({ initial, anamEnabled, elevenEnabled }: Props) {
  const [config, setConfig] = useState<TwinConfig>(initial);
  const [facts, setFacts] = useState<TwinFacts>(initial.facts);

  const score = useMemo(() => scoreOf(config, facts), [config, facts]);

  return (
    <div className="mt-8 space-y-8">
      <Meter score={score} />
      <FaceSection config={config} onChange={setConfig} enabled={anamEnabled} />
      <VoiceSection config={config} onChange={setConfig} enabled={elevenEnabled} />
      <FactsSection facts={facts} onChange={setFacts} onSaved={setConfig} />
    </div>
  );
}

function Meter({ score }: { score: number }) {
  const label =
    score === 0
      ? 'nothing set up yet'
      : score < 50
        ? 'the basics are missing'
        : score < 80
          ? 'usable, still generic'
          : score < 100
            ? 'good — fill the rest for a sharper twin'
            : 'complete';

  return (
    <div className="border-border bg-bg-elevated/40 rounded-xl border p-5">
      <div className="flex items-baseline justify-between">
        <span className="text-text-subtle font-mono text-[10px] tracking-widest uppercase">
          Completeness
        </span>
        <span className="font-mono text-sm">{score}/100</span>
      </div>
      <div className="bg-border mt-3 h-1 overflow-hidden rounded-full">
        <div
          className="bg-accent h-full rounded-full transition-all duration-500"
          style={{ width: `${score}%` }}
        />
      </div>
      <p className="text-text-muted mt-2.5 text-xs">{label}</p>
    </div>
  );
}

function Section({
  step,
  title,
  desc,
  done,
  children,
}: {
  step: number;
  title: string;
  desc: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-bg-elevated/40 rounded-xl border p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="text-text-subtle font-mono text-[10px] tracking-widest uppercase">
            Step {step}
          </span>
          <h2 className="font-display mt-1.5 text-xl" style={{ letterSpacing: '-0.01em' }}>
            {title}
          </h2>
          <p className="text-text-muted mt-1.5 max-w-xl text-sm leading-relaxed">{desc}</p>
        </div>
        <span
          className={
            'mt-1 shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase ' +
            (done
              ? 'text-accent border-accent-dim border'
              : 'text-text-subtle border-border border')
          }
        >
          {done ? 'set' : 'todo'}
        </span>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/**
 * Destructive action with an inline confirm step.
 *
 * Both removals are irreversible upstream (Anam hard delete, ElevenLabs voice
 * delete), so a stray click should not be enough. Inline rather than
 * window.confirm so it does not block the browser event loop the way a modal
 * dialog would during an open LiveKit session.
 */
function RemoveButton({
  label,
  confirmLabel,
  busy,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        disabled={busy}
        className="text-text-subtle hover:text-accent font-mono text-xs underline underline-offset-4 transition-colors disabled:opacity-40"
      >
        {label}
      </button>
    );
  }

  return (
    <span className="flex items-center gap-3">
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className="border-accent-dim text-accent rounded-lg border px-3 py-1.5 font-mono text-xs disabled:opacity-40"
      >
        {busy ? 'removing…' : confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="text-text-subtle hover:text-text font-mono text-xs"
      >
        cancel
      </button>
    </span>
  );
}

function Note({ kind, children }: { kind: 'error' | 'ok'; children: React.ReactNode }) {
  return (
    <p
      className={
        'mt-3 font-mono text-xs leading-relaxed ' +
        (kind === 'error' ? 'text-accent' : 'text-text-muted')
      }
    >
      {children}
    </p>
  );
}

/* ── Step 1: face ─────────────────────────────────────────────────────── */

function FaceSection({
  config,
  onChange,
  enabled,
}: {
  config: TwinConfig;
  onChange: (c: TwinConfig) => void;
  enabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(config.avatarPreviewUrl);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (file: File) => {
      setError(null);

      // Validate against Anam's documented limits before spending a round
      // trip: square-ish, at least 1152x1152, under 4.5MB.
      if (file.size > 4.5 * 1024 * 1024) {
        setError(`Photo is ${(file.size / 1024 / 1024).toFixed(1)}MB. Max is 4.5MB.`);
        return;
      }
      const dims = await readDimensions(file).catch(() => null);
      if (dims && (dims.w < 1152 || dims.h < 1152)) {
        setError(`Photo is ${dims.w}x${dims.h}. Anam needs at least 1152x1152.`);
        return;
      }

      setBusy(true);
      try {
        const body = new FormData();
        body.append('photo', file);
        body.append('displayName', 'Twin');
        const res = await fetch('/admin/api/twin-avatar', { method: 'POST', body });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        onChange(data.config);
        setPreview(data.config.avatarPreviewUrl ?? URL.createObjectURL(file));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed.');
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/admin/api/twin-avatar', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      onChange(data.config);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed.');
    } finally {
      setBusy(false);
    }
  }, [onChange]);

  return (
    <Section
      step={1}
      title="Your face"
      desc="One photo becomes the avatar. Square, at least 1152x1152, under 4.5MB. Face in focus, hands out of frame, clear space around your head and shoulders."
      done={!!config.avatarId}
    >
      {!enabled ? (
        <Note kind="error">Set ANAM_API_KEY to enable this step.</Note>
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <div className="border-border bg-bg size-28 shrink-0 overflow-hidden rounded-lg border">
            {preview ? (
              <img src={preview} alt="Avatar preview" className="h-full w-full object-cover" />
            ) : (
              <div className="text-text-subtle flex h-full items-center justify-center font-mono text-[10px]">
                no photo
              </div>
            )}
          </div>

          <div className="min-w-56 flex-1">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="border-border-strong hover:border-accent-dim rounded-lg border px-4 py-2 font-mono text-xs tracking-wide transition-colors disabled:opacity-50"
            >
              {busy ? 'creating avatar…' : config.avatarId ? 'Replace photo' : 'Choose photo'}
            </button>

            {error && <Note kind="error">{error}</Note>}
            {config.avatarId && !error && (
              <Note kind="ok">
                {config.avatarProvider} · {config.avatarId}
              </Note>
            )}

            {config.avatarId && (
              <div className="mt-4">
                <RemoveButton
                  label="Remove avatar"
                  confirmLabel="Delete permanently"
                  busy={busy}
                  onConfirm={remove}
                />
                <p className="text-text-subtle mt-2 text-xs leading-relaxed">
                  Deletes it at Anam too. The free tier allows one custom avatar, so removing is how
                  you free the slot to upload a different photo.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

function readDimensions(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable image'));
    };
    img.src = url;
  });
}

/* ── Step 2: voice ────────────────────────────────────────────────────── */

const CONSENT_TEXT =
  'I confirm this is my own voice, and I consent to it being cloned and used by this application.';

function VoiceSection({
  config,
  onChange,
  enabled,
}: {
  config: TwinConfig;
  onChange: (c: TwinConfig) => void;
  enabled: boolean;
}) {
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBlob(null);
    setSeconds(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = () => setBlob(new Blob(chunksRef.current, { type: rec.mimeType }));
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      setError('Could not access the microphone.');
    }
  }, []);

  const submit = useCallback(async () => {
    if (!blob) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('sample', blob, 'sample.webm');
      body.append('name', 'Twin voice');
      body.append('consent', 'true');
      const res = await fetch('/admin/api/twin-voice', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      onChange(data.config);
      setBlob(null);
      setNotice(
        data.requiresVerification
          ? 'Cloned, but ElevenLabs wants the voice captcha completed in their dashboard before it can be used.'
          : 'Voice cloned.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }, [blob, onChange]);

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/admin/api/twin-voice', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      onChange(data.config);
      setBlob(null);
      setSeconds(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed.');
    } finally {
      setBusy(false);
    }
  }, [onChange]);

  const tooShort = seconds > 0 && seconds < 60;

  return (
    <Section
      step={2}
      title="Your voice"
      desc="Read anything for 60 to 120 seconds in a quiet room. Do not go past three minutes — beyond that the clone gets worse, not better."
      done={!!config.voiceId}
    >
      {!enabled ? (
        <Note kind="error">Set ELEVENLABS_API_KEY to enable this step.</Note>
      ) : (
        <>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-text-muted text-sm leading-relaxed">{CONSENT_TEXT}</span>
          </label>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            {!recording ? (
              <button
                type="button"
                onClick={start}
                disabled={!consent || busy}
                className="border-border-strong hover:border-accent-dim rounded-lg border px-4 py-2 font-mono text-xs tracking-wide transition-colors disabled:opacity-40"
              >
                {config.voiceId ? 'Record again' : 'Start recording'}
              </button>
            ) : (
              <button
                type="button"
                onClick={stop}
                className="border-accent-dim text-accent rounded-lg border px-4 py-2 font-mono text-xs tracking-wide"
              >
                Stop ({seconds}s)
              </button>
            )}

            {blob && !recording && (
              <>
                <audio controls src={URL.createObjectURL(blob)} className="h-9" />
                <button
                  type="button"
                  onClick={submit}
                  disabled={busy || tooShort}
                  className="border-border-strong hover:border-accent-dim rounded-lg border px-4 py-2 font-mono text-xs tracking-wide transition-colors disabled:opacity-40"
                >
                  {busy ? 'cloning…' : 'Use this recording'}
                </button>
              </>
            )}
          </div>

          {recording && (
            <Note kind="ok">
              {seconds < 60
                ? `keep going — ${60 - seconds}s to the minimum`
                : 'long enough, stop whenever'}
            </Note>
          )}
          {tooShort && !recording && blob && (
            <Note kind="error">Only {seconds}s. Record at least 60 seconds.</Note>
          )}
          {error && <Note kind="error">{error}</Note>}
          {notice && <Note kind="ok">{notice}</Note>}
          {config.voiceId && !blob && !notice && (
            <Note kind="ok">
              {config.voiceName} · {config.voiceId}
            </Note>
          )}

          {config.voiceId && (
            <div className="mt-4">
              <RemoveButton
                label="Remove voice"
                confirmLabel="Delete permanently"
                busy={busy}
                onConfirm={remove}
              />
              <p className="text-text-subtle mt-2 text-xs leading-relaxed">
                Deletes the clone at ElevenLabs too, freeing a voice slot. Speech falls back to the
                default gateway voice until you record a new one.
              </p>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/* ── Step 3: facts ────────────────────────────────────────────────────── */

const FIELDS: Array<{ key: keyof TwinFacts; label: string; hint: string; rows: number }> = [
  { key: 'name', label: 'Name', hint: 'What the twin calls itself.', rows: 1 },
  {
    key: 'bio',
    label: 'Who I am',
    hint: 'A few sentences, first person. What you do, how long, what you are good at.',
    rows: 4,
  },
  {
    key: 'speech',
    label: 'How I talk',
    hint: 'Concrete habits beat adjectives. Filler words, sentence length, what you never say.',
    rows: 4,
  },
  {
    key: 'opinions',
    label: 'What I care about',
    hint: 'Things you would actually argue about. Vague values make a twin sound like a LinkedIn post.',
    rows: 4,
  },
  {
    key: 'history',
    label: 'Facts about my life',
    hint: 'Timeline, jobs, projects, cities. One per line.',
    rows: 4,
  },
  {
    key: 'avoid',
    label: "What I don't do",
    hint: 'Out of character behaviour. Topics to refuse, things never to invent.',
    rows: 3,
  },
];

function FactsSection({
  facts,
  onChange,
  onSaved,
}: {
  facts: TwinFacts;
  onChange: (f: TwinFacts) => void;
  onSaved: (c: TwinConfig) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/admin/api/twin-facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(facts),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      onSaved(data.config);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }, [facts, onSaved]);

  const filled = FIELDS.filter((f) => facts[f.key]?.trim()).length;

  return (
    <Section
      step={3}
      title="Who you are"
      desc="This becomes the twin's system prompt. Write it yourself rather than pasting something a model generated — a brief nobody edited reads generic, which is the exact failure this is meant to prevent."
      done={filled >= 4}
    >
      <div className="space-y-5">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className="flex items-baseline justify-between">
              <span className="font-mono text-[11px] tracking-wide">{f.label}</span>
              <span className="text-text-subtle font-mono text-[10px]">
                {facts[f.key]?.trim() ? 'set' : 'empty'}
              </span>
            </label>
            <p className="text-text-subtle mt-1 text-xs leading-relaxed">{f.hint}</p>
            {f.rows === 1 ? (
              <input
                value={facts[f.key] ?? ''}
                onChange={(e) => onChange({ ...facts, [f.key]: e.target.value })}
                className="border-border bg-bg focus:border-accent-dim mt-2 w-full rounded-lg border px-3 py-2 text-sm outline-none"
              />
            ) : (
              <textarea
                value={facts[f.key] ?? ''}
                rows={f.rows}
                onChange={(e) => onChange({ ...facts, [f.key]: e.target.value })}
                className="border-border bg-bg focus:border-accent-dim mt-2 w-full resize-y rounded-lg border px-3 py-2 text-sm leading-relaxed outline-none"
              />
            )}
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-4">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="border-border-strong hover:border-accent-dim rounded-lg border px-5 py-2.5 font-mono text-xs tracking-wide transition-colors disabled:opacity-50"
        >
          {busy ? 'saving…' : 'Save'}
        </button>
        {saved && <span className="text-text-muted font-mono text-xs">saved</span>}
        {error && <span className="text-accent font-mono text-xs">{error}</span>}
      </div>
    </Section>
  );
}
