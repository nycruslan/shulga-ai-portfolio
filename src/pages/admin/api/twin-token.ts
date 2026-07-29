import type { APIRoute } from 'astro';
import {
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_URL,
  TWIN_AGENT_NAME,
} from 'astro:env/server';
import { AccessToken, AgentDispatchClient, type VideoGrant } from 'livekit-server-sdk';
import { buildPersona, readTwinConfig } from '../../../lib/twin-config';

export const prerender = false;

// Twin session bootstrap. Auth: the /admin middleware gates this — only the
// allowlisted owner session reaches the handler.
//
// This mints a room token for the browser and dispatches the agent worker into
// that room. It deliberately does NOT start the avatar: the avatar joins as a
// participant of kind `agent` carrying `lk.publish_on_behalf` set to the
// agent's identity (`agent-<job id>`), and that identity does not exist until
// a job is assigned. The worker's LiveAvatar plugin owns that step. An avatar
// started from here would play audio but stay invisible to the UI, because
// useVoiceAssistant() matches video by that attribute.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const AGENT_NAME = TWIN_AGENT_NAME || 'my-agent';

export const POST: APIRoute = async () => {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return json(
      { error: 'Twin is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.' },
      503,
    );
  }

  const roomName = `twin-${crypto.randomUUID().slice(0, 8)}`;
  const identity = `owner-${crypto.randomUUID().slice(0, 8)}`;

  try {
    // Dispatch explicitly rather than via RoomConfiguration on the token:
    // room config only fires when its participant *creates* the room, which
    // is not guaranteed once the agent or avatar gets there first.
    const dispatcher = new AgentDispatchClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

    // The twin's face, voice and persona ride along as dispatch metadata.
    // The worker reads it from ctx.job.metadata, so it needs no database
    // credentials and never polls — config is whatever was saved the moment
    // the session started. Fields left null mean "use the worker's default".
    const config = await readTwinConfig();
    const metadata = JSON.stringify({
      avatar_provider: config.avatarProvider,
      avatar_id: config.avatarId,
      voice_id: config.voiceId,
      persona: buildPersona(config),
      name: config.facts.name || null,
    });

    await dispatcher.createDispatch(roomName, AGENT_NAME, { metadata });

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: 'owner',
      ttl: '15m',
    });
    const grant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    };
    at.addGrant(grant);

    return json({ serverUrl: LIVEKIT_URL, roomName, participantToken: await at.toJwt() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[admin/api/twin-token]', err);
    // Nearly always "no worker registered under this agent name".
    return json({ error: `Could not start a session: ${message}` }, 502);
  }
};
