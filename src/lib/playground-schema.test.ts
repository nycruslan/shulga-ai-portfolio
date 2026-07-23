import { describe, expect, it } from 'vitest';
import {
  createPortfolioSchema,
  describeParams,
  paramsSchema,
  statusSchema,
} from './playground-schema';

describe('createPortfolioSchema', () => {
  const good = {
    name: 'Top 5 tight stops',
    capital: 25_000,
    params: {
      buy_rule: { type: 'top_n', n: 5 },
      size_pct: 5,
      max_positions: 20,
      sector_cap: null,
      stop: { mode: 'cap', pct: 8 },
      take_profit_pct: null,
      time_limit_days: 25,
    },
  };

  it('accepts a sane config and fills defaults', () => {
    const r = createPortfolioSchema.safeParse(good);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.params.include_plain_buys).toBe(false);
  });

  it('rejects out-of-range values instead of guessing', () => {
    expect(createPortfolioSchema.safeParse({ ...good, capital: 500 }).success).toBe(false);
    expect(createPortfolioSchema.safeParse({ ...good, name: '' }).success).toBe(false);
    expect(
      createPortfolioSchema.safeParse({
        ...good,
        params: { ...good.params, buy_rule: { type: 'top_n', n: 100 } },
      }).success,
    ).toBe(false);
    expect(
      createPortfolioSchema.safeParse({
        ...good,
        params: { ...good.params, size_pct: 90 },
      }).success,
    ).toBe(false);
  });

  it('validates stop modes and take-profit ranges', () => {
    const ok = (stop: unknown) =>
      createPortfolioSchema.safeParse({ ...good, params: { ...good.params, stop } }).success;
    expect(ok({ mode: 'engine' })).toBe(true);
    expect(ok({ mode: 'fixed', pct: 8 })).toBe(true);
    expect(ok({ mode: 'fixed', pct: 1 })).toBe(false); // below 2% floor
    expect(ok({ mode: 'tight' })).toBe(false);
    expect(
      createPortfolioSchema.safeParse({
        ...good,
        params: { ...good.params, take_profit_pct: 150 },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown buy-rule types', () => {
    expect(
      createPortfolioSchema.safeParse({
        ...good,
        params: { ...good.params, buy_rule: { type: 'yolo' } },
      }).success,
    ).toBe(false);
  });
});

describe('bracket exits + 1% floor', () => {
  const base = {
    name: 'Bracket 1%',
    capital: 25_000,
    params: {
      buy_rule: { type: 'all' },
      exit_mode: 'bracket',
      take_profit_pct: 1,
      stop: { mode: 'fixed', pct: 5 },
    },
  };
  it('accepts a 1% take-profit bracket config', () => {
    const r = createPortfolioSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.params.exit_mode).toBe('bracket');
  });
  it('rejects sub-1% targets and unknown modes', () => {
    expect(
      createPortfolioSchema.safeParse({
        ...base,
        params: { ...base.params, take_profit_pct: 0.5 },
      }).success,
    ).toBe(false);
    expect(
      createPortfolioSchema.safeParse({
        ...base,
        params: { ...base.params, exit_mode: 'yolo' },
      }).success,
    ).toBe(false);
  });
  it('defaults to managed and describes bracket plainly', () => {
    expect(paramsSchema.parse({ buy_rule: { type: 'all' } }).exit_mode).toBe('managed');
    const s = describeParams(
      paramsSchema.parse({
        buy_rule: { type: 'all' },
        exit_mode: 'bracket',
        take_profit_pct: 1,
        stop: { mode: 'fixed', pct: 5 },
      }),
    );
    expect(s).toContain('sells ONLY at +1% profit');
    expect(s).toContain('no trailing');
  });
});

describe('statusSchema', () => {
  it('allows exactly the three lifecycle states', () => {
    for (const s of ['active', 'paused', 'archived']) {
      expect(statusSchema.safeParse(s).success).toBe(true);
    }
    expect(statusSchema.safeParse('deleted').success).toBe(false);
  });
});

describe('describeParams — the plain-English contract', () => {
  it('reads like a sentence a human wrote', () => {
    const p = paramsSchema.parse({
      buy_rule: { type: 'top_n', n: 5 },
      size_pct: 5,
      stop: { mode: 'cap', pct: 8 },
      take_profit_pct: 15,
    });
    const s = describeParams(p);
    expect(s).toContain('top 5 strong buys by score');
    expect(s).toContain('5% of capital per position');
    expect(s).toContain('stops capped at 8%');
    expect(s).toContain('take profit at +15% (tick-level)');
  });

  it('describes the all/min_score variants and engine stops', () => {
    expect(describeParams(paramsSchema.parse({ buy_rule: { type: 'all' } }))).toContain(
      'every strong buy',
    );
    const s = describeParams(
      paramsSchema.parse({ buy_rule: { type: 'min_score', min_score: 95 } }),
    );
    expect(s).toContain('scoring ≥ 95');
    expect(s).toContain('engine structural stops');
    expect(
      describeParams(
        paramsSchema.parse({ buy_rule: { type: 'all' }, stop: { mode: 'fixed', pct: 10 } }),
      ),
    ).toContain('fixed 10% stop');
  });
});
