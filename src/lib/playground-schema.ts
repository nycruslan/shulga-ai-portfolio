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
