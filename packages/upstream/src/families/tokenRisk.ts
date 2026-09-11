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

/**
 * What a known-malicious-address database holds about one address.
 *
 * ### This is a list of known bad, not an assessment
 *
 * That distinction is the whole reason this file treats the answer the way it
 * does, and it was established by probing rather than assumed. Asked about the
 * Ronin bridge exploiter -- still on the OFAC list -- the service answers
 * `sanctioned: 1`, `stealing_attack: 1`, `data_source: "SlowMist,BlockSec"`.
 * Asked about the Uniswap V2 router, which every security service on earth has
 * looked at, it answers every field `0` and `data_source: ""`. Asked about an
 * address with no history at all, the same.
 *
 * So an empty answer means "not in the lists we hold". It does **not** mean
 * "we checked and it is fine", and there is no field that would let anybody
 * tell those apart, because the service only speaks when it has something to
 * say. `matched` carries that: false is the absence of a match, and the
 * capability is required to say so in those words rather than report a clean
 * bill nobody issued.
 *
 * ### Sharing GoPlus's allowance rather than inventing a second one
 *
 * Same origin as `token_security`, and machine-scoped windows are keyed on the
 * origin -- so these two families spend one budget between them, which is what
 * the service actually meters. A second set of numbers here would be two halves
 * of an allowance each believing it held all of it.
 *
 * Free, no key, checked September 2026.
 */
export interface AddressRisk {
  /**
   * Whether any source has an entry for this address.
   *
   * Derived from `data_source` being non-empty or any flag being set, because
   * a record of all noughts and no source is the shape of "no match" and must
   * never be rendered as "clean".
   */
  matched: boolean;
  /** Who said so, as the service names them -- "SlowMist,BlockSec". */
  dataSource: string | null;
  sanctioned: Reported<boolean>;
  stealingAttack: Reported<boolean>;
  phishingActivities: Reported<boolean>;
  blackmailActivities: Reported<boolean>;
  darkwebTransactions: Reported<boolean>;
  cybercrime: Reported<boolean>;
  moneyLaundering: Reported<boolean>;
  financialCrime: Reported<boolean>;
  maliciousMiningActivities: Reported<boolean>;
  honeypotRelatedAddress: Reported<boolean>;
  fakeKyc: Reported<boolean>;
  fakeToken: Reported<boolean>;
  fakeStandardInterface: Reported<boolean>;
  gasAbuse: Reported<boolean>;
  blacklistDoubt: Reported<boolean>;
  mixer: Reported<boolean>;
  isContract: Reported<boolean>;
  maliciousContractsCreated: Reported<number>;
}

function goplusAddress(): Upstream<TokenRiskQuery, AddressRisk> {
  return defineUpstream<TokenRiskQuery, AddressRisk>({
    id: 'address_risk.goplus',
    family: 'address_risk',
    name: 'goplus',
    description: 'Whether an address appears in databases of known malicious addresses.',
    origin: 'api.gopluslabs.io',
    limit: {
      concurrentPerProcess: 2,
      // The same published 30 a minute as `token_security`, and deliberately
      // the same origin, so the two share it rather than each taking it.
      windows: [perSecond(1, { scope: 'MACHINE' }), perMinute(30, { scope: 'MACHINE', source: 'PUBLISHED' })],
    },
    timeoutMs: 20_000,
    // An address joins one of these lists after somebody investigates, which is
    // a slow process. An hour is soon enough and keeps a shared budget for the
    // questions nobody has asked yet.
    freshMs: 60 * 60_000,
    rank: 1,
    cacheKey: (query) => `${query.chainId}:${query.address.toLowerCase()}`,
    async fetch(query, ctx) {
      try {
        const url =
          `https://api.gopluslabs.io/api/v1/address_security/${encodeURIComponent(query.address)}` +
          `?chain_id=${query.chainId}`;
        const response = await safeFetch(url, {
          signal: ctx.signal,
          headers: { accept: 'application/json' },
          // Measured at 491 bytes for both a flagged address and a clean one.
          maxBytes: 50_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = JSON.parse(response.text) as { result?: Record<string, unknown> };
        const row = body.result ?? {};

        const dataSource = typeof row.data_source === 'string' && row.data_source.trim() !== '' ? row.data_source : null;
        // `contract_address` says what an address is, not that anything is wrong
        // with it, so it is excluded from what counts as a match. Including it
        // would make every contract on the chain look like a hit.
        const anyFlag = Object.entries(row).some(([key, value]) => key !== 'contract_address' && value === '1');
        const created = count(row.number_of_malicious_contracts_created);

        return {
          matched: dataSource !== null || anyFlag || (created.known && created.value > 0),
          dataSource,
          sanctioned: flag(row.sanctioned),
          stealingAttack: flag(row.stealing_attack),
          phishingActivities: flag(row.phishing_activities),
          blackmailActivities: flag(row.blackmail_activities),
          darkwebTransactions: flag(row.darkweb_transactions),
          cybercrime: flag(row.cybercrime),
          moneyLaundering: flag(row.money_laundering),
          financialCrime: flag(row.financial_crime),
          maliciousMiningActivities: flag(row.malicious_mining_activities),
          honeypotRelatedAddress: flag(row.honeypot_related_address),
          fakeKyc: flag(row.fake_kyc),
          fakeToken: flag(row.fake_token),
          fakeStandardInterface: flag(row.fake_standard_interface),
          gasAbuse: flag(row.gas_abuse),
          blacklistDoubt: flag(row.blacklist_doubt),
          mixer: flag(row.mixer),
          isContract: flag(row.contract_address),
          maliciousContractsCreated: created,
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerTokenRiskUpstreams(): void {
  registerUpstream(goplus());
  registerUpstream(goplusAddress());
  registerUpstream(honeypotIs());
}
