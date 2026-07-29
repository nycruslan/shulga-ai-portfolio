import type { APIRoute } from 'astro';
import { ELEVENLABS_API_KEY } from 'astro:env/server';
import { readTwinConfig, writeTwinConfig } from '../../../lib/twin-config';

export const prerender = false;

// Clones a voice from a recording via ElevenLabs Instant Voice Cloning, then
// stores the voice id. Auth: the /admin middleware gates this.
//
// Consent: the EU AI Act, Tennessee's ELVIS Act, California publicity rights
// and a dozen other US state laws make consent a legal requirement, and
// ElevenLabs enforces it at their end too. The client must send consent=true,
// which it only enables after the owner ticks the statement. Cloning your own
// voice is the easy case; this keeps the record honest anyway.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// ElevenLabs recommends 1-2 minutes and warns that beyond ~3 minutes quality
// can degrade. Sizes are a proxy for length; generous bounds either side.
const MIN_BYTES = 40 * 1024;
const MAX_BYTES = 25 * 1024 * 1024;

export const POST: APIRoute = async ({ request }) => {
  if (!ELEVENLABS_API_KEY) {
    return json({ error: 'ELEVENLABS_API_KEY is not set.' }, 503);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data.' }, 400);
  }

  if (String(form.get('consent')) !== 'true') {
    return json({ error: 'Consent is required before a voice can be cloned.' }, 400);
  }

  const sample = form.get('sample');
  const name = String(form.get('name') || 'Twin voice').slice(0, 60);

  if (!(sample instanceof File)) return json({ error: 'No recording uploaded.' }, 400);
  if (sample.size < MIN_BYTES) {
    return json({ error: 'Recording is too short. Aim for at least 60 seconds.' }, 400);
  }
  if (sample.size > MAX_BYTES) {
    return json({ error: 'Recording is too large. Keep it under about 3 minutes.' }, 400);
  }

  const upstream = new FormData();
  upstream.append('name', name);
  upstream.append('files', sample, sample.name || 'sample.webm');
  upstream.append('remove_background_noise', 'true');

  let res: Response;
  try {
    res = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      body: upstream,
    });
  } catch (err) {
    console.error('[twin-voice] network', err);
    return json({ error: 'Could not reach ElevenLabs.' }, 502);
  }

  const text = await res.text();
  if (!res.ok) {
    console.error('[twin-voice] elevenlabs', res.status, text.slice(0, 400));
    return json(
      { error: `ElevenLabs rejected the sample (${res.status}): ${text.slice(0, 300)}` },
      502,
    );
  }

  let voice: { voice_id?: string; requires_verification?: boolean };
  try {
    voice = JSON.parse(text);
  } catch {
    return json({ error: 'ElevenLabs returned a response we could not read.' }, 502);
  }
  if (!voice.voice_id) return json({ error: 'ElevenLabs did not return a voice id.' }, 502);

  const config = await writeTwinConfig({ voiceId: voice.voice_id, voiceName: name });

  // requires_verification means the clone exists but ElevenLabs wants the
  // voice-captcha completed in their dashboard before it can be used.
  return json({ config, requiresVerification: voice.requires_verification === true });
};

/**
 * Remove the cloned voice: delete it at ElevenLabs, then clear it locally.
 *
 * Deleting upstream matters for more than tidiness. Voice slots are finite
 * (10 on Starter), and a clone of a real person that is no longer used should
 * not sit in the account — the consent you recorded was for using it.
 */
export const DELETE: APIRoute = async () => {
  const current = await readTwinConfig();

  if (!current.voiceId) {
    return json({ error: 'No voice to remove.' }, 400);
  }
  if (!ELEVENLABS_API_KEY) {
    return json({ error: 'ELEVENLABS_API_KEY is not set.' }, 503);
  }

  let res: Response;
  try {
    res = await fetch(
      `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(current.voiceId)}`,
      { method: 'DELETE', headers: { 'xi-api-key': ELEVENLABS_API_KEY } },
    );
  } catch (err) {
    console.error('[twin-voice] delete network', err);
    return json({ error: 'Could not reach ElevenLabs.' }, 502);
  }

  // 404 means it is already gone upstream — clear locally rather than
  // stranding a config that points at nothing.
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    console.error('[twin-voice] delete', res.status, text.slice(0, 300));
    return json(
      { error: `ElevenLabs refused the delete (${res.status}): ${text.slice(0, 200)}` },
      502,
    );
  }

  const config = await writeTwinConfig({ voiceId: null, voiceName: null });
  return json({ config });
};
