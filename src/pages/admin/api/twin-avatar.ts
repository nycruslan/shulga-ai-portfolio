import type { APIRoute } from 'astro';
import { ANAM_API_KEY } from 'astro:env/server';
import { readTwinConfig, writeTwinConfig } from '../../../lib/twin-config';

export const prerender = false;

// Creates a one-shot Anam avatar from an uploaded photo, then stores the
// resulting avatar id. Auth: the /admin middleware gates this.
//
// The photo is proxied straight through to Anam as multipart rather than
// being hosted first. Anam's JSON variant takes an `imageUrl`, which would
// require the image to be publicly reachable — impossible from localhost and
// an unnecessary storage dependency in production.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// Anam's stated limits. Enforced here too so a bad file fails fast with a
// message that says what to fix, rather than a generic upstream 400.
const MAX_BYTES = 4.5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const POST: APIRoute = async ({ request }) => {
  if (!ANAM_API_KEY) {
    return json({ error: 'ANAM_API_KEY is not set.' }, 503);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data.' }, 400);
  }

  const file = form.get('photo');
  const displayName = String(form.get('displayName') || 'Twin').slice(0, 50);

  if (!(file instanceof File)) return json({ error: 'No photo uploaded.' }, 400);
  if (!ALLOWED.has(file.type)) {
    return json(
      { error: `Unsupported format ${file.type || 'unknown'}. Use JPEG, PNG or WebP.` },
      400,
    );
  }
  if (file.size > MAX_BYTES) {
    return json(
      { error: `Photo is ${(file.size / 1024 / 1024).toFixed(1)}MB. Max is 4.5MB.` },
      400,
    );
  }
  if (displayName.length < 3) {
    return json({ error: 'Avatar name must be at least 3 characters.' }, 400);
  }

  const upstream = new FormData();
  upstream.append('displayName', displayName);
  upstream.append('imageFile', file, file.name || 'photo.jpg');

  let res: Response;
  try {
    res = await fetch('https://api.anam.ai/v1/avatars', {
      method: 'POST',
      // No Content-Type header: fetch sets the multipart boundary itself.
      headers: { Authorization: `Bearer ${ANAM_API_KEY}` },
      body: upstream,
    });
  } catch (err) {
    console.error('[twin-avatar] network', err);
    return json({ error: 'Could not reach Anam.' }, 502);
  }

  const text = await res.text();
  if (!res.ok) {
    console.error('[twin-avatar] anam', res.status, text.slice(0, 400));
    return json({ error: `Anam rejected the photo (${res.status}): ${text.slice(0, 300)}` }, 502);
  }

  let avatar: { id?: string; imageUrl?: string; displayName?: string };
  try {
    avatar = JSON.parse(text);
  } catch {
    return json({ error: 'Anam returned a response we could not read.' }, 502);
  }
  if (!avatar.id) return json({ error: 'Anam did not return an avatar id.' }, 502);

  const config = await writeTwinConfig({
    avatarId: avatar.id,
    avatarProvider: 'anam',
    avatarPreviewUrl: avatar.imageUrl ?? null,
  });

  return json({ config });
};

/**
 * Remove the custom avatar: delete it at Anam, then clear it locally.
 *
 * Hard delete (`?hard=true`), not the default soft delete. Anam's free tier
 * allows exactly one custom avatar, and a soft-deleted avatar is "hidden but
 * restorable" — which would leave the slot occupied and make replacing your
 * photo impossible. Hard delete is irreversible; the UI says so.
 */
export const DELETE: APIRoute = async () => {
  const current = await readTwinConfig();

  if (!current.avatarId) {
    return json({ error: 'No avatar to remove.' }, 400);
  }

  // Only Anam avatars are ours to delete. A LiveAvatar id was created in their
  // dashboard, so we just forget it here.
  if (current.avatarProvider === 'anam') {
    if (!ANAM_API_KEY) return json({ error: 'ANAM_API_KEY is not set.' }, 503);

    let res: Response;
    try {
      res = await fetch(
        `https://api.anam.ai/v1/avatars/${encodeURIComponent(current.avatarId)}?hard=true`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${ANAM_API_KEY}` } },
      );
    } catch (err) {
      console.error('[twin-avatar] delete network', err);
      return json({ error: 'Could not reach Anam.' }, 502);
    }

    // 404 means it is already gone upstream — fall through and clear locally
    // rather than stranding a config that points at nothing.
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '');
      console.error('[twin-avatar] delete', res.status, text.slice(0, 300));
      if (res.status === 409) {
        return json(
          { error: 'Anam still has a persona using this avatar. Remove it there first.' },
          409,
        );
      }
      return json({ error: `Anam refused the delete (${res.status}): ${text.slice(0, 200)}` }, 502);
    }
  }

  const config = await writeTwinConfig({
    avatarId: null,
    avatarProvider: null,
    avatarPreviewUrl: null,
  });

  return json({ config });
};
