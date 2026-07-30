import { z } from 'zod';

// Shared contract for Trade Playground configs. The dashboard writes these to
// Turso; the trading VPS syncs them down, clamps again server-side
// (copilot/playground.py normalize_params — the authoritative rails), and runs
// them as deterministic paper portfolios. Limits here mirror the Python side
// so the UI can't author a config the runner would reinterpret.

export const LIMITS = {
  capital: { min: 1_000, max: 1_000_000 },
  topN: { min: 1, max: 25 },
  sizePct: { min: 0.5, max: 25 },
  maxPositions: { min: 1, max: 50 },
  sectorCap: { min: 1, max: 10 },
  stopPct: { min: 0.1, max: 100 },
  takeProfitPct: { min: 0.1, max: 100 },
  timeLimitDays: { min: 1, max: 120 },
  maxActive: 10,
} as const;

export const buyRuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('top_n'),
    n: z.number().int().min(LIMITS.topN.min).max(LIMITS.topN.max),
  }),
  z.object({ type: z.literal('all') }),
  z.object({
    type: z.literal('min_score'),
    min_score: z.number().min(0).max(100),
  }),
]);

export const stopSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('engine') }),
  z.object({
    mode: z.literal('cap'),
    pct: z.number().min(LIMITS.stopPct.min).max(LIMITS.stopPct.max),
  }),
  z.object({
    mode: z.literal('fixed'),
    pct: z.number().min(LIMITS.stopPct.min).max(LIMITS.stopPct.max),
  }),
]);

export const exitModeSchema = z.enum(['managed', 'bracket']);

export const paramsSchema = z.object({
  buy_rule: buyRuleSchema,
  // managed: mechanical stack (breakeven/trail/ratchet/+2R partial) + optional TP.
  // bracket: sell EACH position ONLY at its own profit % / stop / time limit —
  // no trail, no ratchet, no partial. TP is enforced tick-level by the monitor.
  exit_mode: exitModeSchema.default('managed'),
  include_plain_buys: z.boolean().default(false),
  size_pct: z.number().min(LIMITS.sizePct.min).max(LIMITS.sizePct.max).default(5),
  max_positions: z
    .number()
    .int()
    .min(LIMITS.maxPositions.min)
    .max(LIMITS.maxPositions.max)
    .default(20),
  sector_cap: z
    .number()
    .int()
    .min(LIMITS.sectorCap.min)
    .max(LIMITS.sectorCap.max)
    .nullable()
    .default(null),
  stop: stopSchema.default({ mode: 'engine' }),
  take_profit_pct: z
    .number()
    .min(LIMITS.takeProfitPct.min)
    .max(LIMITS.takeProfitPct.max)
    .nullable()
    .default(null),
  time_limit_days: z
    .number()
    .int()
    .min(LIMITS.timeLimitDays.min)
    .max(LIMITS.timeLimitDays.max)
    .default(25),
});

export const createPortfolioSchema = z.object({
  name: z.string().trim().min(1).max(60),
  capital: z.number().min(LIMITS.capital.min).max(LIMITS.capital.max),
  params: paramsSchema,
});

export const statusSchema = z.enum(['active', 'paused', 'archived']);

export type PlaygroundParams = z.infer<typeof paramsSchema>;
export type CreatePortfolioInput = z.infer<typeof createPortfolioSchema>;
export type PlaygroundStatus = z.infer<typeof statusSchema>;

export type PlaygroundConfig = {
  id: string;
  name: string;
  params: PlaygroundParams;
  status: PlaygroundStatus;
  capital: number;
  created_at?: string;
  updated_at?: string;
};

/** One human sentence describing what a config DOES — shown live in the create
 * form and on every card, so a portfolio is never a mystery of sliders. */
export function describeParams(p: PlaygroundParams): string {
  const rule =
    p.buy_rule.type === 'all'
      ? 'every strong buy'
      : p.buy_rule.type === 'top_n'
        ? `the top ${p.buy_rule.n} strong buy${p.buy_rule.n === 1 ? '' : 's'} by score`
        : `strong buys scoring ≥ ${p.buy_rule.min_score}`;
  const bits = [
    `Each trading day: buy ${rule}${p.include_plain_buys ? ' (plain BUYs too)' : ''}`,
    `${p.size_pct}% of capital per position`,
    `max ${p.max_positions} open`,
  ];
  if (p.exit_mode === 'bracket') {
    bits.push(
      `then each position sells ONLY at ${p.take_profit_pct != null ? `+${p.take_profit_pct}% profit, ` : ''}its stop, or the ${p.time_limit_days}d limit (simple bracket — no trailing)`,
    );
  }
  if (p.sector_cap != null) bits.push(`≤ ${p.sector_cap}/sector`);
  bits.push(
    p.stop.mode === 'fixed'
      ? `fixed ${p.stop.pct}% stop`
      : p.stop.mode === 'cap'
        ? `stops capped at ${p.stop.pct}%`
        : 'engine structural stops',
  );
  if (p.exit_mode === 'bracket') {
    return bits.join(' · ') + '.';
  }
  if (p.take_profit_pct != null) bits.push(`take profit at +${p.take_profit_pct}% (tick-level)`);
  bits.push(`${p.time_limit_days}d time limit`);
  return bits.join(' · ') + '. Exits are mechanical (stop / trail / ratchet / +2R partial / time).';
}

/** The practical consequences of a config, in plain terms: how many positions
 * it can actually hold, what it's too small to buy, and that it never
 * double-buys. Shown live in the form so size and capital choices don't turn
 * into a surprise later ("I set score 50, why only 4 buys?" — because 25% size
 * fills the account after 4). */
export function describePlan(p: PlaygroundParams, capital: number): string {
  const maxByCash = Math.floor(100 / p.size_pct);
  const effectiveMax = Math.max(1, Math.min(maxByCash, p.max_positions));
  const slotUsd = Math.round((capital * p.size_pct) / 100);
  const bits: string[] = [];
  const capReason =
    maxByCash <= p.max_positions
      ? `${p.size_pct}% size fills the whole account after ${maxByCash} buy${maxByCash === 1 ? '' : 's'}`
      : `your ${p.max_positions}-open limit caps it`;
  bits.push(
    `Holds ~${effectiveMax} position${effectiveMax === 1 ? '' : 's'} at most (${capReason}).`,
  );
  // A slot smaller than a typical share price silently drops pricey names. Below
  // ~$500 this bites real tickers (UNH, HUM, PANW all trade above it).
  if (slotUsd < 500) {
    bits.push(
      `Won't buy any stock priced over $${slotUsd.toLocaleString()} — one slot can't afford a full share, so higher-priced names drop out.`,
    );
  }
  bits.push(
    'Skips any name it already owns, so a portfolio that holds winners buys fewer new names each day.',
  );
  return bits.join(' ');
}

/**
 * The same config as scannable label/value pairs.
 *
 * `describeParams` is the right shape for the create form, where a sentence
 * reads as "here is what you are about to build". On a card in a grid it turns
 * into a wall of prose you have to parse word by word just to compare two
 * portfolios, so the cards use this instead.
 */
export function paramsSpec(p: PlaygroundParams, capital: number): Array<[string, string]> {
  const rule =
    p.buy_rule.type === 'all'
      ? 'every strong buy'
      : p.buy_rule.type === 'top_n'
        ? `top ${p.buy_rule.n} by score`
        : `score ≥ ${p.buy_rule.min_score}`;

  const spec: Array<[string, string]> = [
    ['capital', `$${capital.toLocaleString()}`],
    ['buys', rule + (p.include_plain_buys ? ' + plain' : '')],
    ['size', `${p.size_pct}%`],
    ['max open', String(p.max_positions)],
  ];
  if (p.sector_cap != null) spec.push(['sector cap', String(p.sector_cap)]);
  spec.push([
    'stop',
    p.stop.mode === 'fixed'
      ? `fixed ${p.stop.pct}%`
      : p.stop.mode === 'cap'
        ? `capped ${p.stop.pct}%`
        : 'structural',
  ]);
  spec.push(['take profit', p.take_profit_pct != null ? `+${p.take_profit_pct}%` : 'ride']);
  spec.push(['time limit', `${p.time_limit_days}d`]);
  spec.push(['exits', p.exit_mode === 'bracket' ? 'simple bracket' : 'managed']);
  return spec;
}
