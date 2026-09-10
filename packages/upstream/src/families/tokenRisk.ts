import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { classifyStatus, classifyThrown } from '../failures';

/**
 * What two security services observe about a token contract.
 *
 * ### Observations, never a verdict
 *
 * Neither of these says "safe" and neither should be read as saying it. They
 * report attributes -- a tax figure, a mintable flag, how much the creator
 * holds, whether a simulated trade could be sold again -- and the useful thing
 * is the attribute with its source attached. "GoPlus reports a 15% sell tax" is
 * evidence somebody can act on; "this token is a scam" is a claim AI17Z is not
 * in a position to make and would be believed anyway.
 *
 * ### Nought and nothing are different answers
 *
 * The fields come back as `"0"`, `"1"` and, for anything the service did not
 * check, an **empty string**. Reading that empty as nought turns "we did not
 * look" into "it is fine", which is the worst possible direction for this
 * particular error. So an unchecked field is carried as unknown and reported as
 * not checked, and never as a clean result.
 *
 * Two services rather than one, because they look at different things: one
 * reads the contract, the other simulates a trade. Neither is a fallback for
 * the other, so they are separate families and a capability asks both.
 *
 * Free, no key, checked September 2026.
 */

export const TokenRiskQuery = z.object({
  /** The chain id, because a contract address means nothing without one. */
  chainId: z.number().int().positive(),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
export type TokenRiskQuery = z.infer<typeof TokenRiskQuery>;

/** A value a service either reported, reported as absent, or did not check. */
export type Reported<T> = { known: true; value: T } | { known: false };

function known<T>(value: T): Reported<T> {
  return { known: true, value };
}

const UNKNOWN: Reported<never> = { known: false };

/**
 * Reads one of GoPlus's string fields.
 *
 * `"1"` and `"0"` are answers; an empty string or a missing key is not.
 */
function flag(value: unknown): Reported<boolean> {
  if (value === '1') return known(true);
  if (value === '0') return known(false);
  return UNKNOWN;
}

function percent(value: unknown): Reported<number> {
  if (typeof value !== 'string' || value.trim() === '') return UNKNOWN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? known(parsed) : UNKNOWN;
}

function count(value: unknown): Reported<number> {
  if (typeof value === 'number' && Number.isFinite(value)) return known(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return known(Number(value));
  return UNKNOWN;
}

export interface ContractSecurity {
  found: boolean;
  name: Reported<string>;
  symbol: Reported<string>;
  /** As a fraction: 0.15 is fifteen per cent. */
  buyTax: Reported<number>;
  sellTax: Reported<number>;
  isHoneypot: Reported<boolean>;
  isMintable: Reported<boolean>;
  isOpenSource: Reported<boolean>;
  isProxy: Reported<boolean>;
  transferPausable: Reported<boolean>;
  canTakeBackOwnership: Reported<boolean>;
  hiddenOwner: Reported<boolean>;
  selfDestruct: Reported<boolean>;
  isBlacklisted: Reported<boolean>;
  holderCount: Reported<number>;
  /** What the creator still holds, as a fraction of supply. */
  creatorPercent: Reported<number>;
  ownerPercent: Reported<number>;
}

function goplus(): Upstream<TokenRiskQuery, ContractSecurity> {
  return defineUpstream<TokenRiskQuery, ContractSecurity>({
    id: 'token_security.goplus',
    family: 'token_security',
    name: 'goplus',
    description: 'Contract attributes a token security service reports.',
    origin: 'api.gopluslabs.io',
    limit: {
      concurrentPerProcess: 2,
      // GoPlus publishes 30 calls a minute for the free, keyless tier --
      // checked September 2026. Theirs, not ours, and marked as such so a
      // maintainer updating published limits can tell it apart from a number
      // AI17Z chose.
      windows: [perSecond(1, { scope: 'MACHINE' }), perMinute(30, { scope: 'MACHINE', source: 'PUBLISHED' })],
    },
    timeoutMs: 20_000,
    // Contract attributes change only when somebody changes the contract, and
    // an hour is soon enough to notice an ownership renounce.
    freshMs: 60 * 60_000,
    rank: 1,
    cacheKey: (query) => `${query.chainId}:${query.address.toLowerCase()}`,
    async fetch(query, ctx) {
      try {
        const url =
          `https://api.gopluslabs.io/api/v1/token_security/${query.chainId}` +
          `?contract_addresses=${encodeURIComponent(query.address)}`;
        const response = await safeFetch(url, {
          signal: ctx.signal,
          headers: { accept: 'application/json' },
          maxBytes: 500_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = JSON.parse(response.text) as { result?: Record<string, Record<string, unknown>> };
        // Keyed by lower-cased address, which is not necessarily how it was
        // asked -- so the lookup is case-insensitive rather than exact.
        const row = Object.entries(body.result ?? {}).find(
          ([key]) => key.toLowerCase() === query.address.toLowerCase(),
        )?.[1];

        if (!row || Object.keys(row).length === 0) {
          // A contract it has never seen. An answer, not a fault -- and one
          // worth saying, because "nobody has looked at this" is itself a
          // finding about a token somebody is being offered.
          return {
            found: false,
            name: UNKNOWN,
            symbol: UNKNOWN,
            buyTax: UNKNOWN,
            sellTax: UNKNOWN,
            isHoneypot: UNKNOWN,
            isMintable: UNKNOWN,
            isOpenSource: UNKNOWN,
            isProxy: UNKNOWN,
            transferPausable: UNKNOWN,
            canTakeBackOwnership: UNKNOWN,
            hiddenOwner: UNKNOWN,
            selfDestruct: UNKNOWN,
            isBlacklisted: UNKNOWN,
            holderCount: UNKNOWN,
            creatorPercent: UNKNOWN,
            ownerPercent: UNKNOWN,
          };
        }

        return {
          found: true,
          name: typeof row.token_name === 'string' && row.token_name ? known(row.token_name) : UNKNOWN,
          symbol: typeof row.token_symbol === 'string' && row.token_symbol ? known(row.token_symbol) : UNKNOWN,
          buyTax: percent(row.buy_tax),
          sellTax: percent(row.sell_tax),
          isHoneypot: flag(row.is_honeypot),
          isMintable: flag(row.is_mintable),
          isOpenSource: flag(row.is_open_source),
          isProxy: flag(row.is_proxy),
          transferPausable: flag(row.transfer_pausable),
          canTakeBackOwnership: flag(row.can_take_back_ownership),
          hiddenOwner: flag(row.hidden_owner),
          selfDestruct: flag(row.selfdestruct),
          isBlacklisted: flag(row.is_blacklisted),
          holderCount: count(row.holder_count),
          creatorPercent: percent(row.creator_percent),
          ownerPercent: percent(row.owner_percent),
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export interface TradeSimulation {
  simulated: boolean;
  isHoneypot: Reported<boolean>;
  buyTax: Reported<number>;
  sellTax: Reported<number>;
  /** What the service itself said, when it said anything. */
  note: string | null;
}

function honeypotIs(): Upstream<TokenRiskQuery, TradeSimulation> {
  return defineUpstream<TokenRiskQuery, TradeSimulation>({
    id: 'token_tradeable.honeypotis',
    family: 'token_tradeable',
    name: 'honeypotis',
    description: 'Whether a simulated buy could be sold again.',
    origin: 'api.honeypot.is',
    limit: {
      concurrentPerProcess: 1,
      // No published figure -- checked September 2026. A simulation is
      // expensive for whoever runs it, so this is deliberately modest.
      windows: [perSecond(1, { scope: 'MACHINE' }), perMinute(20, { scope: 'MACHINE' })],
    },
    timeoutMs: 25_000,
    freshMs: 30 * 60_000,
    rank: 1,
    cacheKey: (query) => `${query.chainId}:${query.address.toLowerCase()}`,
    async fetch(query, ctx) {
      try {
        const url = `https://api.honeypot.is/v2/IsHoneypot?address=${encodeURIComponent(query.address)}&chainID=${query.chainId}`;
        const response = await safeFetch(url, {
          signal: ctx.signal,
          headers: { accept: 'application/json' },
          maxBytes: 200_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = JSON.parse(response.text) as {
          simulationSuccess?: boolean;
          honeypotResult?: { isHoneypot?: boolean };
          simulationResult?: { buyTax?: number; sellTax?: number };
          summary?: { risk?: string };
        };

        // A simulation that did not run tells us nothing, and nothing is what it
        // must report -- not "not a honeypot".
        if (body.simulationSuccess !== true) {
          return {
            simulated: false,
            isHoneypot: UNKNOWN,
            buyTax: UNKNOWN,
            sellTax: UNKNOWN,
            note: 'The trade could not be simulated, so nothing was learned either way.',
          };
        }

        return {
          simulated: true,
          isHoneypot:
            typeof body.honeypotResult?.isHoneypot === 'boolean' ? known(body.honeypotResult.isHoneypot) : UNKNOWN,
          buyTax: typeof body.simulationResult?.buyTax === 'number' ? known(body.simulationResult.buyTax / 100) : UNKNOWN,
          sellTax:
            typeof body.simulationResult?.sellTax === 'number' ? known(body.simulationResult.sellTax / 100) : UNKNOWN,
          note: typeof body.summary?.risk === 'string' ? `The service's own summary: ${body.summary.risk}.` : null,
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerTokenRiskUpstreams(): void {
  registerUpstream(goplus());
  registerUpstream(honeypotIs());
}
