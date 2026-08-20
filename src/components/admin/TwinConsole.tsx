import { useCallback, useEffect, useMemo, useState } from 'react';
import { ParticipantKind, Room, RoomEvent } from 'livekit-client';
import {
  BarVisualizer,
  RoomAudioRenderer,
  RoomContext,
  StartAudio,
  VideoTrack,
  useLocalParticipant,
  useVoiceAssistant,
} from '@livekit/components-react';

/**
 * Realtime video-avatar console.
 *
 * Deliberately not a port of LiveKit's agent-starter-react: that app ships a
 * large shadcn component tree (~450 kB of first-load JS) for chat, screen
 * share, and device pickers this console does not need. Everything here is
 * the avatar tile, a mic toggle, and connection state.
 *
 * The avatar's video arrives via useVoiceAssistant(), which pairs the agent
 * participant with a second `agent`-kind participant carrying
 * `lk.publish_on_behalf`. If the avatar ever joins without that attribute you
 * hear it but never see it — that pairing is the whole mechanism.
 */

type Status = 'idle' | 'connecting' | 'live' | 'error';

interface ConnectionDetails {
  serverUrl: string;
  roomName: string;
  participantToken: string;
}

export default function TwinConsole() {
  const room = useMemo(() => new Room(), []);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  // Disconnect on unmount so navigating away never leaves a session (and its
  // avatar concurrency slot) held open.
  useEffect(() => {
    return () => {
      room.disconnect();
    };
  }, [room]);

  useEffect(() => {
    const onDisconnected = () => {
      setStatus((prev) => (prev === 'error' ? prev : 'idle'));
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room]);

  // Fail loudly when nothing answers the dispatch. A dead worker, a crashed
  // job, and an avatar provider at its concurrency limit all used to look
  // like the same spinner forever. If no agent-kind participant is in the
  // room after 20s, end the session and say so.
  useEffect(() => {
    if (status !== 'live') return;
    const timer = setTimeout(() => {
      const hasAgent = Array.from(room.remoteParticipants.values()).some(
        (p) => p.kind === ParticipantKind.AGENT,
      );
      if (!hasAgent) {
        setError(
          'No agent joined within 20 seconds. The worker may be down, or the avatar provider is at its session limit. Wait a moment and try again.',
        );
        setStatus('error');
        room.disconnect().catch(() => {});
      }
    }, 20_000);
    return () => clearTimeout(timer);
  }, [status, room]);

  const connect = useCallback(async () => {
    setStatus('connecting');
    setError(null);
    try {
      const res = await fetch('/admin/api/twin-token', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);

      const details = body as ConnectionDetails;
      await room.connect(details.serverUrl, details.participantToken);
      await room.localParticipant.setMicrophoneEnabled(true);
      setStatus('live');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect.');
      setStatus('error');
      await room.disconnect().catch(() => {});
    }
  }, [room]);

  const disconnect = useCallback(async () => {
    await room.disconnect();
    setStatus('idle');
  }, [room]);

  return (
    <RoomContext.Provider value={room}>
      <div className="mt-8">
        {status === 'live' ? (
          <LiveSession onEnd={disconnect} />
        ) : (
          <Idle status={status} error={error} onStart={connect} />
        )}
        <RoomAudioRenderer />
        <StartAudio label="Enable audio" className="sr-only" />
      </div>
    </RoomContext.Provider>
  );
}

function Idle({
  status,
  error,
  onStart,
}: {
  status: Status;
  error: string | null;
  onStart: () => void;
}) {
  const connecting = status === 'connecting';
  return (
    <div className="border-border bg-bg-elevated/40 flex flex-col items-center rounded-xl border px-6 py-16 text-center">
      <div className="border-border-strong text-text-subtle flex size-16 items-center justify-center rounded-full border border-dashed font-mono text-xs">
        off
      </div>
      <h2 className="font-display mt-6 text-xl" style={{ letterSpacing: '-0.01em' }}>
        Twin is not running
      </h2>
      <p className="text-text-muted mt-2 max-w-md text-sm leading-relaxed">
        Starts a live video session with the avatar. Your microphone turns on when the session
        opens, and the agent worker must already be registered with LiveKit.
      </p>

      {error && (
        <p className="text-accent mt-5 max-w-md font-mono text-xs leading-relaxed">{error}</p>
      )}

      <button
        type="button"
        onClick={onStart}
        disabled={connecting}
        className="border-border-strong hover:border-accent-dim mt-7 rounded-lg border px-5 py-2.5 font-mono text-xs tracking-wide transition-colors disabled:opacity-50"
      >
        {connecting ? 'connecting…' : 'Start session'}
      </button>
    </div>
  );
}

function LiveSession({ onEnd }: { onEnd: () => void }) {
  const { videoTrack, audioTrack, state } = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();
  const [micOn, setMicOn] = useState(true);

  const toggleMic = useCallback(async () => {
    const next = !micOn;
    await localParticipant.setMicrophoneEnabled(next);
    setMicOn(next);
  }, [localParticipant, micOn]);

  return (
    <div className="space-y-4">
      <div className="border-border bg-bg-elevated/40 relative aspect-video w-full overflow-hidden rounded-xl border">
        {videoTrack ? (
          <VideoTrack trackRef={videoTrack} className="h-full w-full object-cover" />
        ) : (
          <div className="text-text-subtle absolute inset-0 flex flex-col items-center justify-center gap-3">
            <span className="font-mono text-xs">
              {audioTrack ? 'voice-only session' : 'waiting for the avatar to join…'}
            </span>
            {audioTrack && (
              <span className="font-mono text-[10px]">
                the video could not start this time — you can still talk, or end the session and try
                again
              </span>
            )}
          </div>
        )}

        <div className="absolute top-3 left-3 flex items-center gap-2 rounded-full bg-black/50 px-2.5 py-1 backdrop-blur-sm">
          <span className="bg-accent size-1.5 animate-pulse rounded-full" aria-hidden="true" />
          <span className="font-mono text-[10px] tracking-widest text-white uppercase">
            {state}
          </span>
        </div>

        {audioTrack && (
          <div className="absolute right-3 bottom-3 left-3 h-8 opacity-70">
            <BarVisualizer
              track={audioTrack}
              barCount={7}
              options={{ minHeight: 8 }}
              className="h-full"
            />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={toggleMic}
          className="border-border-strong hover:border-accent-dim rounded-lg border px-4 py-2 font-mono text-xs tracking-wide transition-colors"
          aria-pressed={micOn}
        >
          {micOn ? 'mute mic' : 'unmute mic'}
        </button>
        <button
          type="button"
          onClick={onEnd}
          className="border-border-strong hover:border-accent-dim text-accent rounded-lg border px-4 py-2 font-mono text-xs tracking-wide transition-colors"
        >
          End session
        </button>
      </div>

      <Transcript />
    </div>
  );
}

/**
 * Live transcript of what the avatar says.
 *
 * Segments stream in and are revised in place as speech recognition settles,
 * so entries are keyed by segment id and replaced rather than appended.
 * Only the agent side is shown; the user's own speech is not transcribed here.
 */
function Transcript() {
  const { agentTranscriptions, state } = useVoiceAssistant();

  // Derived, not mirrored into state: the hook already hands back the full
  // segment list with stable ids, and revised segments reuse their id. Keeping
  // a copy in state would mean a setState inside an effect for no gain.
  const lines = useMemo(() => {
    const byId = new Map<string, { id: string; who: string; text: string }>();
    for (const seg of agentTranscriptions ?? []) {
      byId.set(seg.id, { id: seg.id, who: 'twin', text: seg.text });
    }
    return [...byId.values()].slice(-30);
  }, [agentTranscriptions]);

  if (!lines.length) {
    return (
      <p className="text-text-subtle font-mono text-[11px]">
        {state === 'listening' ? 'listening…' : 'transcript will appear here'}
      </p>
    );
  }

  return (
    <div className="border-border bg-bg-elevated/40 max-h-56 overflow-y-auto rounded-xl border p-4">
      <ul className="space-y-2">
        {lines.map((l) => (
          <li key={l.id} className="text-sm leading-relaxed">
            <span className="text-text-subtle mr-2 font-mono text-[10px] tracking-widest uppercase">
              {l.who}
            </span>
            <span className="text-text-muted">{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
