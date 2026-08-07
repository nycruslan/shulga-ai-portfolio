import { describe, expect, it } from 'vitest';
import {
  createPortfolioSchema,
  describeParams,
  describePlan,
  describeRatchet,
  DEFAULT_RATCHET_STEPS,
  paramsSchema,
  paramsSpec,
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
    expect(ok({ mode: 'fixed', pct: 1 })).toBe(true); // tight stops allowed (floor 0.1)
    expect(ok({ mode: 'fixed', pct: 0.05 })).toBe(false); // below the 0.1 floor
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
  it('rejects sub-0.1% targets and unknown modes', () => {
    expect(
      createPortfolioSchema.safeParse({
        ...base,
        params: { ...base.params, take_profit_pct: 0.05 },
      }).success,
    ).toBe(false);
    expect(
      createPortfolioSchema.safeParse({
        ...base,
        params: { ...base.params, take_profit_pct: 0.1 },
      }).success,
    ).toBe(true);
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

describe('describePlan', () => {
  it('caps position count by cash when size is large — the "score 50 but only 4 buys" case', () => {
    const p = paramsSchema.parse({ buy_rule: { type: 'min_score', min_score: 50 }, size_pct: 25 });
    const s = describePlan(p, 25_000);
    expect(s).toContain('~4 positions'); // 100/25 = 4, the whole account
    expect(s).toContain('fills the whole account after 4 buys');
    expect(s).toContain('Skips any name it already owns');
  });

  it('caps by the max-open limit when size is small', () => {
    const p = paramsSchema.parse({ buy_rule: { type: 'all' }, size_pct: 1, max_positions: 30 });
    const s = describePlan(p, 25_000);
    expect(s).toContain('~30 positions'); // 100/1 = 100, but max_positions 30 binds first
    expect(s).toContain('30-open limit caps it');
  });

  it('warns about a price ceiling only when the slot is small enough to bite', () => {
    // $250 slot (1% of $25k) drops pricey names.
    const small = describePlan(
      paramsSchema.parse({ buy_rule: { type: 'all' }, size_pct: 1 }),
      25_000,
    );
    expect(small).toContain("Won't buy any stock priced over $250");
    // $6,250 slot (25% of $25k) is above any real share price — no warning.
    const big = describePlan(
      paramsSchema.parse({ buy_rule: { type: 'all' }, size_pct: 25 }),
      25_000,
    );
    expect(big).not.toContain("Won't buy any stock priced over");
  });

  it('describes equal-split as fully-invested with per-count slices', () => {
    const p = paramsSchema.parse({
      buy_rule: { type: 'top_n', n: 10 },
      size_mode: 'equal_split',
      size_pct: 5,
    });
    const s = describePlan(p, 25_000);
    expect(s).toContain('always ~fully invested');
    expect(s).toContain('~10 names'); // top_n 10 → 10 slices
    expect(s).toContain('$2,500 each'); // 25k / 10
    expect(s).not.toContain("Won't buy any stock priced over"); // no per-name ceiling
  });
});

describe('size_mode', () => {
  it('defaults to fixed_pct and accepts equal_split', () => {
    expect(paramsSchema.parse({ buy_rule: { type: 'all' } }).size_mode).toBe('fixed_pct');
    expect(
      paramsSchema.parse({ buy_rule: { type: 'all' }, size_mode: 'equal_split' }).size_mode,
    ).toBe('equal_split');
  });

  it('rejects an unknown size mode', () => {
    expect(
      createPortfolioSchema.safeParse({
        name: 'X',
        capital: 25_000,
        params: { buy_rule: { type: 'all' }, size_mode: 'yolo' },
      }).success,
    ).toBe(false);
  });

  it('describeParams and paramsSpec reflect equal-split', () => {
    const p = paramsSchema.parse({ buy_rule: { type: 'all' }, size_mode: 'equal_split' });
    expect(describeParams(p)).toContain('split equally');
    expect(paramsSpec(p, 25_000)).toContainEqual(['size', 'equal split']);
  });
});

describe('ratchet exit mode', () => {
  it('defaults to the classic ladder and accepts the mode', () => {
    const p = paramsSchema.parse({ buy_rule: { type: 'all' }, exit_mode: 'ratchet' });
    expect(p.exit_mode).toBe('ratchet');
    expect(p.ratchet_steps).toEqual(DEFAULT_RATCHET_STEPS);
  });

  it('rejects an unknown exit mode and out-of-range / empty ladders', () => {
    const bad = (params: unknown) =>
      createPortfolioSchema.safeParse({ name: 'X', capital: 25_000, params }).success;
    expect(bad({ buy_rule: { type: 'all' }, exit_mode: 'yolo' })).toBe(false);
    expect(bad({ buy_rule: { type: 'all' }, ratchet_steps: [] })).toBe(false); // min 1
    expect(bad({ buy_rule: { type: 'all' }, ratchet_steps: [{ at: 99, lock: 0 }] })).toBe(false); // at > 20
  });

  it('describeRatchet reads as a ladder', () => {
    expect(
      describeRatchet([
        { at: 1, lock: 0 },
        { at: 2, lock: 0.5 },
      ]),
    ).toBe('+1R → breakeven, +2R → lock +0.5R');
  });

  it('describeParams and paramsSpec surface the ratchet', () => {
    const p = paramsSchema.parse({ buy_rule: { type: 'all' }, exit_mode: 'ratchet' });
    const s = describeParams(p);
    expect(s).toContain('milestone ratchet');
    expect(s).toContain('no fixed take-profit');
    expect(paramsSpec(p, 25_000)).toContainEqual(['exits', 'ratchet (3 steps)']);
  });
});

describe('tickers buy mode', () => {
  it('accepts a hand-picked list and upper-cases it', () => {
    const p = paramsSchema.parse({ buy_rule: { type: 'tickers', symbols: ['aapl', 'msft'] } });
    expect(p.buy_rule).toEqual({ type: 'tickers', symbols: ['AAPL', 'MSFT'] });
  });

  it('rejects an empty or oversized list', () => {
    const bad = (symbols: string[]) =>
      createPortfolioSchema.safeParse({
        name: 'X',
        capital: 25_000,
        params: { buy_rule: { type: 'tickers', symbols } },
      }).success;
    expect(bad([])).toBe(false); // min 1
    expect(bad(Array(21).fill('AAA'))).toBe(false); // max 20
    expect(bad(['AAPL'])).toBe(true);
  });

  it('describeParams and paramsSpec name the picks', () => {
    const p = paramsSchema.parse({ buy_rule: { type: 'tickers', symbols: ['AAPL', 'NVDA'] } });
    expect(describeParams(p)).toContain('your picked names (AAPL, NVDA)');
    expect(paramsSpec(p, 25_000)).toContainEqual(['buys', 'picked: AAPL, NVDA']);
  });
});
