#!/usr/bin/env tsx
/**
 * What one hosted tenant costs, computed rather than remembered.
 *
 *   npm run hosted:cost
 *
 * The prices were in `CONFIDENTIAL_COMPUTE.md` as a table and nowhere else, so
 * AI17Z had never computed a cost: the ledger in `hostedCost.ts` had no SKU to
 * work from and the floor existed only as a sentence. This asks the code.
 *
 * **It prints costs, never a price.** `minimumRetailUsd` is what turns a cost
 * into a floor under a price, and it refuses a sample too small to be a
 * percentile, which one measured tenant on the wrong hardware certainly is. So
 * the last section says what is still missing rather than producing a number
 * that would be quoted.
 */
import {
  COMMITMENT_USD,
  CONFIDENTIAL_SKUS,
  COST_CAVEATS,
  GOOGLE_SEV_SNP_PREMIUM_PER_VCPU_HOUR_USD,
  MEASURED_TENANT_FOOTPRINT,
  REGION_SPREAD,
  SKU_CAVEATS,
  computeFloor,
  judgeFootprint,
  pricesStillCount,
  skusForTenant,
} from '@xbam/runtime';

const now = new Date();
const say = (line = ''): void => void process.stdout.write(`${line}\n`);
const money = (usd: number): string => `$${usd.toFixed(2)}`;

say('What one hosted tenant costs. Costs, not prices.');
say();

// ---------------------------------------------------------------------------
// What is being sized
// ---------------------------------------------------------------------------

const sized = judgeFootprint(MEASURED_TENANT_FOOTPRINT, now);
say('The tenant, as measured:');
if (!sized.usable) {
  say(`  ${sized.why}`);
  say();
  say('Nothing below can be computed from a measurement that does not count.');
  process.exit(1);
}
say(`  ${MEASURED_TENANT_FOOTPRINT.memoryMb} MB used inside a guest on ${MEASURED_TENANT_FOOTPRINT.vcpus} vCPU, sized at ${sized.memoryMb} MB.`);
say(`  ${MEASURED_TENANT_FOOTPRINT.how}`);
say(`  Taken ${MEASURED_TENANT_FOOTPRINT.measuredAt.slice(0, 10)} against ${MEASURED_TENANT_FOOTPRINT.version}.`);
say();

// ---------------------------------------------------------------------------
// Whether the prices still count
// ---------------------------------------------------------------------------

const age = pricesStillCount(now);
say('The prices:');
if (!age.usable) {
  say(`  ${age.why}`);
  say();
  say('Read them again before computing anything from them.');
  process.exit(1);
}
say(`  Read ${age.days} day(s) ago, from ${CONFIDENTIAL_SKUS[0]!.priceSource}.`);
say();

// ---------------------------------------------------------------------------
// Which sizes hold a tenant
// ---------------------------------------------------------------------------

say('Which confidential size holds one tenant:');
for (const row of skusForTenant(MEASURED_TENANT_FOOTPRINT, now)) {
  const mark = row.fits ? 'holds it ' : 'too small';
  say(`  ${mark}  ${row.sku.sku.padEnd(20)} ${String(row.sku.vcpus).padStart(2)} vCPU  ${String(row.sku.memoryMb).padStart(6)} MB  ${money(row.monthlyUsd).padStart(8)}/month  ${row.sku.tee}`);
}
say();

const floor = computeFloor(MEASURED_TENANT_FOOTPRINT, now);
if (!floor.known) {
  say(`No floor: ${floor.why}`);
  process.exit(1);
}
say(`The compute floor: ${money(floor.cheapestMonthlyUsd)} a month.`);
say(`  ${floor.why}`);
say();

/*
  The fact that decides the shape of every plan, and it is not about AI17Z at
  all: the floor is set by the smallest confidential size that exists, not by
  what a tenant needs. A tenant sized at 863 MB is being given 8,192, because
  there is nothing smaller to buy.
*/
const smallest = skusForTenant(MEASURED_TENANT_FOOTPRINT, now).find((row) => row.fits);
if (smallest) {
  const spare = smallest.sku.memoryMb - sized.memoryMb;
  say(`  The floor is set by what can be bought, not by what a tenant needs: ${spare} MB of that size is spare.`);
  say('  Which is the measured argument for several of one owner\'s agents sharing a runtime, and for a browser');
  say('  living in that spare room rather than in a second size up.');
  say();
}

// ---------------------------------------------------------------------------
// The two things that move it most
// ---------------------------------------------------------------------------

say('What moves that floor, before anything about the product does:');
const cheapest = REGION_SPREAD.reduce((a, b) => (a.monthlyUsd < b.monthlyUsd ? a : b));
const dearest = REGION_SPREAD.reduce((a, b) => (a.monthlyUsd > b.monthlyUsd ? a : b));
say(`  Region, same size: ${money(cheapest.monthlyUsd)} in ${cheapest.region} to ${money(dearest.monthlyUsd)} in ${dearest.region}.`);
say(`  Commitment, same region: ${money(COMMITMENT_USD.onDemandMonthly)} on demand, ${money(COMMITMENT_USD.oneYearMonthly)} for a year, ${money(COMMITMENT_USD.threeYearMonthly)} for three.`);
say(`  So the floor is roughly ${money(COMMITMENT_USD.threeYearMonthly)} to ${money(dearest.monthlyUsd)}, and a three-year commitment is a different business from on demand.`);
say();
say(`  Google's SEV-SNP premium is $${GOOGLE_SEV_SNP_PREMIUM_PER_VCPU_HOUR_USD} per vCPU per hour, which is small. Its all-in figure is not recorded, because that needs a billing catalog credential this repository does not have.`);
say();

// ---------------------------------------------------------------------------
// What this is not
// ---------------------------------------------------------------------------

say('What this is not:');
for (const caveat of SKU_CAVEATS) say(`  - ${caveat}`);
say();
say('And what the ledger says about turning any of it into a price:');
for (const caveat of COST_CAVEATS) say(`  - ${caveat}`);
