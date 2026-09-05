import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { json, readJson } from './http';

const schema = z.object({ name: z.string().min(1) });

describe('json', () => {
  it('sets safe defaults and preserves Headers overrides', async () => {
    const response = json(
      { ok: true },
      201,
      new Headers({ 'Cache-Control': 'private', 'X-Test': 'yes' }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('private');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-test')).toBe('yes');
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe('readJson', () => {
  it('parses and validates a bounded JSON object', async () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    const result = await readJson(request, schema);
    expect(result).toEqual({ ok: true, data: { name: 'Ada' } });
  });

  it('rejects invalid JSON and oversized bodies', async () => {
    const invalid = await readJson(
      new Request('https://example.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      schema,
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.response.status).toBe(400);

    const oversized = await readJson(
      new Request('https://example.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(100) }),
      }),
      schema,
      32,
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.response.status).toBe(413);
  });
});
