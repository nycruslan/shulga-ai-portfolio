import { describe, expect, it } from 'vitest';
import {
  buildPersona,
  completeness,
  EMPTY_CONFIG,
  EMPTY_FACTS,
  factsSchema,
  type TwinConfig,
} from './twin-schema';

const config = (patch: Partial<TwinConfig> = {}): TwinConfig => ({
  ...EMPTY_CONFIG,
  ...patch,
  facts: { ...EMPTY_FACTS, ...(patch.facts ?? {}) },
});

describe('factsSchema', () => {
  it('fills every field so callers never handle undefined', () => {
    const parsed = factsSchema.parse({});
    expect(parsed).toEqual({
      name: '',
      bio: '',
      speech: '',
      opinions: '',
      avoid: '',
      history: '',
    });
  });

  it('trims, so whitespace does not read as filled', () => {
    expect(factsSchema.parse({ bio: '   ' }).bio).toBe('');
  });

  it('rejects a field past its limit rather than silently truncating', () => {
    expect(factsSchema.safeParse({ bio: 'x'.repeat(1501) }).success).toBe(false);
  });
});

describe('completeness', () => {
  it('is 0 for a fresh config', () => {
    expect(completeness(config())).toBe(0);
  });

  it('is 100 when everything is set', () => {
    expect(
      completeness(
        config({
          avatarId: 'a',
          voiceId: 'v',
          facts: {
            name: 'Ruslan',
            bio: 'b',
            speech: 's',
            opinions: 'o',
            avoid: 'x',
            history: 'h',
          },
        }),
      ),
    ).toBe(100);
  });

  it('weights face and voice at half the total between them', () => {
    expect(completeness(config({ avatarId: 'a' }))).toBe(25);
    expect(completeness(config({ avatarId: 'a', voiceId: 'v' }))).toBe(50);
  });

  it('does not count whitespace-only facts', () => {
    // The schema trims on the way in; this guards the scorer directly in case
    // a row was written before that rule existed.
    expect(completeness(config({ facts: { bio: '   ' } as never }))).toBe(0);
  });

  it('never exceeds 100', () => {
    const full = config({
      avatarId: 'a',
      voiceId: 'v',
      facts: { name: 'n', bio: 'b', speech: 's', opinions: 'o', avoid: 'x', history: 'h' },
    });
    expect(completeness(full)).toBeLessThanOrEqual(100);
  });
});

describe('buildPersona', () => {
  it('returns null when nothing is filled, so the worker keeps its own default', () => {
    expect(buildPersona(config())).toBeNull();
  });

  it('omits empty sections rather than emitting bare headings', () => {
    const out = buildPersona(config({ facts: { bio: 'I build things.' } as never }));
    expect(out).toContain('## Who I am');
    expect(out).toContain('I build things.');
    expect(out).not.toContain('## How I talk');
  });

  it('orders sections identity first', () => {
    const out =
      buildPersona(
        config({
          facts: { bio: 'B', speech: 'S', opinions: 'O', history: 'H', avoid: 'A' } as never,
        }),
      ) ?? '';
    const order = ['## Who I am', '## How I talk', '## What I care about'].map((h) =>
      out.indexOf(h),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it('does not leak the name field into the brief (it is passed separately)', () => {
    const out = buildPersona(config({ facts: { name: 'Ruslan', bio: 'B' } as never })) ?? '';
    expect(out).not.toContain('Ruslan');
  });
});
