import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { shipNoteSurvivesReview, writeShipNote } from './ship-note';

const REPO = 'nycruslan/portfolio-copilot';
const TITLES = ['feat(strategy): trial 50 opens after the range', 'fix: settle queued orders'];

const usage = {
  inputTokens: { total: 150, noCache: 150, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 40, text: 40, reasoning: undefined },
  totalTokens: 190,
} as const;

const noteModel = (note: string) =>
  new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: 'text', text: JSON.stringify({ note }) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
  });

describe('shipNoteSurvivesReview', () => {
  it('accepts a grounded, plain note that names the repo', () => {
    expect(
      shipNoteSurvivesReview(
        'portfolio-copilot got smarter about order settlement today.',
        REPO,
        TITLES,
      ),
    ).toBe(true);
  });

  it('rejects notes that skip the repo name', () => {
    expect(shipNoteSurvivesReview('Some trading fixes shipped today.', REPO, TITLES)).toBe(false);
  });

  it('rejects invented numbers but keeps numbers lifted from commits', () => {
    expect(
      shipNoteSurvivesReview('portfolio-copilot ran 900 experiments today.', REPO, TITLES),
    ).toBe(false);
    expect(shipNoteSurvivesReview('Trial 50 landed in portfolio-copilot.', REPO, TITLES)).toBe(
      true,
    );
  });

  it('rejects notes that fail the house-style rules', () => {
    expect(
      shipNoteSurvivesReview('portfolio-copilot shipped a robust upgrade.', REPO, TITLES),
    ).toBe(false);
    expect(
      shipNoteSurvivesReview(
        'portfolio-copilot now opens, settles, and reports trades.',
        REPO,
        TITLES,
      ),
    ).toBe(false);
  });
});

describe('writeShipNote', () => {
  it('returns a reviewed note with usage accounted', async () => {
    const result = await writeShipNote(
      { repo: REPO, titles: TITLES },
      noteModel('Trial 50 landed in portfolio-copilot: buys now wait out the opening range.'),
    );
    expect(result).not.toBeNull();
    expect(result!.note).toContain('portfolio-copilot');
    expect(result!.usage.outputTokens).toBeGreaterThan(0);
  });

  it('repairs em dashes mechanically before review', async () => {
    const result = await writeShipNote(
      { repo: REPO, titles: TITLES },
      noteModel('Order settlement got a fix in portfolio-copilot — queued orders now settle.'),
    );
    expect(result).not.toBeNull();
    expect(result!.note).not.toMatch(/[—–]/);
  });

  it('drops a note the review rejects instead of filing it', async () => {
    const result = await writeShipNote(
      { repo: REPO, titles: TITLES },
      noteModel('A seamless day of shipping across 12 repos.'),
    );
    expect(result).toBeNull();
  });

  it('skips silently with no commit subjects', async () => {
    expect(await writeShipNote({ repo: REPO, titles: [] }, noteModel('anything'))).toBeNull();
  });
});
