import type { AstroCookies } from 'astro';
import { describe, expect, it } from 'vitest';
import { bridgeIdentity } from './identity';

function cookieJar(initial?: string) {
  let value = initial;
  let options: Record<string, unknown> | undefined;
  const cookies = {
    get: () => (value ? { value } : undefined),
    set: (_name: string, next: string, nextOptions: Record<string, unknown>) => {
      value = next;
      options = nextOptions;
    },
  } as unknown as AstroCookies;
  return { cookies, value: () => value, options: () => options };
}

describe('bridgeIdentity', () => {
  it('issues a durable token and returns a stable anonymous identity', () => {
    const jar = cookieJar();
    const first = bridgeIdentity(jar.cookies);
    const second = bridgeIdentity(jar.cookies);
    expect(second).toEqual(first);
    expect(first.ownerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.visitorId).toBe(`vis-${first.ownerHash.slice(0, 16)}`);
    expect(jar.value()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jar.options()).toMatchObject({
      httpOnly: true,
      sameSite: 'strict',
      path: '/api/bridge',
    });
  });

  it('replaces malformed cookie values', () => {
    const jar = cookieJar('not-valid');
    bridgeIdentity(jar.cookies);
    expect(jar.value()).not.toBe('not-valid');
  });
});
