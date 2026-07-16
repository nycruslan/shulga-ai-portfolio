import { afterEach, describe, expect, it, vi } from 'vitest';

// ALLOWLIST/isAllowed are computed from env at module load, so each case sets
// env then re-imports a fresh copy of the module.
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('./auth');
}

afterEach(() => {
  delete process.env.OWNER_EMAIL;
  delete process.env.ADMIN_ALLOWLIST;
});

describe('admin allowlist', () => {
  it('always includes the owner, even with no ADMIN_ALLOWLIST', async () => {
    const { isAllowed } = await load({ OWNER_EMAIL: 'me@x.com', ADMIN_ALLOWLIST: undefined });
    expect(isAllowed('me@x.com')).toBe(true);
    expect(isAllowed('stranger@x.com')).toBe(false);
  });

  it('admits everyone on the list plus the owner', async () => {
    const { isAllowed } = await load({
      OWNER_EMAIL: 'me@x.com',
      ADMIN_ALLOWLIST: 'a@x.com, b@y.com',
    });
    expect(isAllowed('me@x.com')).toBe(true);
    expect(isAllowed('a@x.com')).toBe(true);
    expect(isAllowed('b@y.com')).toBe(true);
    expect(isAllowed('c@z.com')).toBe(false);
  });

  it('is case- and whitespace-insensitive', async () => {
    const { isAllowed } = await load({ OWNER_EMAIL: 'me@x.com', ADMIN_ALLOWLIST: 'A@X.com' });
    expect(isAllowed('  a@x.COM ')).toBe(true);
    expect(isAllowed('ME@x.com')).toBe(true);
  });

  it('tolerates messy separators (commas, spaces, blanks)', async () => {
    const { isAllowed, ALLOWLIST } = await load({
      OWNER_EMAIL: 'me@x.com',
      ADMIN_ALLOWLIST: ' a@x.com ,, b@y.com\n c@z.com ',
    });
    expect(ALLOWLIST.size).toBe(4); // owner + 3
    for (const e of ['a@x.com', 'b@y.com', 'c@z.com']) expect(isAllowed(e)).toBe(true);
  });

  it('rejects empty / null / undefined emails (fail closed)', async () => {
    const { isAllowed } = await load({ OWNER_EMAIL: 'me@x.com', ADMIN_ALLOWLIST: undefined });
    expect(isAllowed('')).toBe(false);
    expect(isAllowed(null)).toBe(false);
    expect(isAllowed(undefined)).toBe(false);
  });

  it('lets no one in when no owner is configured', async () => {
    const { isAllowed } = await load({ OWNER_EMAIL: undefined, ADMIN_ALLOWLIST: undefined });
    expect(isAllowed('anyone@x.com')).toBe(false);
    expect(isAllowed('')).toBe(false);
  });
});
