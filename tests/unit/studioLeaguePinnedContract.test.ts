import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson, leagueRulesHash } from '../../packages/runtime/src/leagueSeason';
import { LeagueSeasonDocument } from '@xbam/shared/contracts';
import * as studio from '../support/pinnedStudioLeagueContract';
import { leagueRules, seasonDocument, seasonTimes } from '../support/leagueStudioServer';

describe('the Studio forge contract pinned at e42c31f', () => {
  it('matches core from the Zod import down, independently of the fake server implementation', () => {
    const body = (path: string) => {
      const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      return text.slice(text.indexOf("import { z }"));
    };
    expect(body('packages/shared/src/contracts/studioLeague.ts')).toBe(body('tests/support/pinnedStudioLeagueContract.ts'));
  });

  it('matches Studio canonical JSON and hash vectors for Unicode and fractions', () => {
    expect(canonicalJson({ b: 12.5, a: '動' })).toBe('{"a":"動","b":12.5}');
    const rules = studio.LeagueRules.parse(leagueRules({
      capital: 333.33,
      minEntrants: 1,
      strategies: [{ id: 'momentum', title: 'Momentum Ünï 動量 🚀', summary: 'Buys strength, sells weakness: café “quoted”.' }],
      bounds: { maxOpenPositions: 3, maxTradePct: 12.5, minLiquidityUsd: 50_000 },
    }));
    // This vector is pinned by Studio's league-bridge-contract test.
    expect(leagueRulesHash(rules)).toBe('5b50fb2db8436430a6a2bda714844f2724960daee55120da5bd88d7a7fea0227');
  });

  it('accepts the same season and rejects live figures and unknown fields on both sides', () => {
    const now = new Date('2026-11-09T10:00:00.000Z');
    const doc = seasonDocument('week-45', now, seasonTimes(now), leagueRules());
    for (const schema of [LeagueSeasonDocument, studio.LeagueSeasonDocument]) {
      expect(schema.safeParse(doc).success).toBe(true);
      expect(schema.safeParse({ ...doc, simulated: false }).success).toBe(false);
      expect(schema.safeParse({ ...doc, command: 'SIGN' }).success).toBe(false);
    }
  });
});
