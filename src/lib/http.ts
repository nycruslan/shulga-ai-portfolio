import type { ZodType } from 'zod';

export type ParsedJson<T> = { ok: true; data: T } | { ok: false; response: Response };

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('Content-Type')) {
    responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  }
  if (!responseHeaders.has('Cache-Control')) responseHeaders.set('Cache-Control', 'no-store');
  if (!responseHeaders.has('X-Content-Type-Options')) {
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
  }
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

/** Parse and validate a small JSON API request without trusting TypeScript casts. */
export async function readJson<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes = 64 * 1024,
): Promise<ParsedJson<T>> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) {
    return { ok: false, response: json({ error: 'Content-Type must be application/json.' }, 415) };
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: json({ error: 'Request body is too large.' }, 413) };
  }

  let text = '';
  const reader = request.body?.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let received = 0;
  try {
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          return { ok: false, response: json({ error: 'Request body is too large.' }, 413) };
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    }
  } catch {
    return { ok: false, response: json({ error: 'Could not read request body.' }, 400) };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, response: json({ error: 'Invalid JSON.' }, 400) };
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.');
    return {
      ok: false,
      response: json(
        { error: field ? `${field}: ${issue?.message ?? 'Invalid value.'}` : 'Invalid request.' },
        400,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

/** Compose caller cancellation with a hard upstream deadline. */
export function withTimeout(signal?: AbortSignal | null, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
