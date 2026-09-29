/**
 * Runs Agent Foundry's "Improve existing agent" against a real agent, in a
 * COPY of an installation's database, and writes what it proposed.
 *
 * The acceptance test for the Foundry: does research recover what an owner
 * spent weeks tuning by hand? The agent's own persona source stands in for X
 * (it was read from X by the canonical reader, so it is primary evidence), a
 * headless Chromium that is not anybody's profile runs the web searches, and
 * the mirrors are asked for real, so a bot check shows up as the gap it is.
 *
 * It writes a run and its proposal items into the database, so it refuses any
 * database whose name does not say it is a copy. Nothing it does can reach a
 * live installation, X, or anybody's signed-in browser, and it applies nothing.
 *
 *   DATABASE_URL=postgres://.../xbam_<name>_dryrun \
 *     npx tsx tools/foundry-dry-run.mts --agent MEADGod --handle MEADGod \
 *       --brief "Build an Agent modeled on @MEADGod ..." --out ./report.md
 *
 * The report holds the agent's own configuration and excerpts of what the
 * persona wrote. Write it somewhere private: it is not a fixture and it is
 * never committed.
 */
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { FOUNDRY_SECTION_LABELS, FoundryBrief, readBrief, type ResearchObservation } from '@xbam/shared/contracts';
import { agents as agentsRepo, closePool, foundry as foundryRepo, personaSources, research as researchRepo } from '@xbam/database';
import { isChallengePage, MIRROR_PROFILE_URLS, observationsFromMirrorArticles, webSearch } from '@xbam/channels';
import { advanceFoundryRun, foundryReport, type FabricSource, type FoundryDeps } from '@xbam/runtime';

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
}

const url = process.env.DATABASE_URL ?? '';
const database = url.replace(/\?.*$/, '').split('/').pop() ?? '';
if (!/(dryrun|copy|scratch)/i.test(database)) {
  console.error(`Refusing: "${database}" does not look like a copy. This tool writes a run into the database it is given.`);
  process.exit(2);
}

const agentName = arg('agent');
const handle = arg('handle');
const briefText = arg('brief') ?? '';
const out = arg('out');
if (!agentName || !handle || !out) {
  console.error('Usage: --agent <name> --handle <x handle> --brief "<owner brief>" --out <report.md>');
  process.exit(2);
}

const agent = (await agentsRepo.allAgents()).find((a) => a.name.toLowerCase() === agentName.toLowerCase());
if (!agent) {
  console.error(`No agent called ${agentName} in ${database}.`);
  process.exit(2);
}

// The persona source's items, as the platform's own reading.
const sources = await personaSources.listSources(agent.id);
const source = sources.find((s) => s.kind === 'x_public' && s.handle?.toLowerCase() === handle.toLowerCase());
const items = source ? (await personaSources.listItems({ sourceId: source.id, view: 'useful', limit: 2_000 })).items : [];
const observations: ResearchObservation[] = items
  .map((i) => ({
    objectKey: `x:status:${i.remoteId}`,
    family: 'X' as const,
    kind: i.itemKind === 'reply' ? ('REPLY' as const) : i.itemKind === 'quote' ? ('QUOTE' as const) : ('POST' as const),
    tier: 'PRIMARY_PLATFORM' as const,
    completeness: 'FULL' as const,
    canonicalUrl: i.url ?? `https://x.com/${handle}/status/${i.remoteId}`,
    originalUrl: i.url,
    platform: 'x',
    externalId: i.remoteId,
    author: handle,
    inReplyTo: i.itemKind === 'reply' ? 'unknown' : null,
    publishedAt: i.remoteCreatedAt,
    fetchedAt: i.ingestedAt,
    content: i.rawText,
    language: null,
    meta: { personaItemId: i.id },
  }));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const platform: FabricSource = {
  family: 'X',
  tier: 'PRIMARY_PLATFORM',
  label: 'X (the persona source already read)',
  roles: ['PERSONA_RESEARCH'],
  optional: false,
  collect: async () => ({ state: 'AVAILABLE', detail: `${observations.length} posts and replies from the persona source.`, observations, requests: 0 }),
};
const mirror = (family: 'TWSTALKER' | 'SOTWE', label: string): FabricSource => ({
  family,
  tier: 'PUBLIC_MIRROR',
  label,
  roles: ['SOCIAL_HISTORY'],
  optional: true,
  async collect(request) {
    const response = await page.goto(MIRROR_PROFILE_URLS[family](request.handle ?? handle), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => null);
    const title = await page.title().catch(() => '');
    const text = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    if (isChallengePage({ title, text, status: response?.status() ?? null })) {
      return { state: 'UNAVAILABLE', detail: `${label} answered with a bot check, so it was left alone.`, observations: [], requests: 1, challenged: true };
    }
    const articles = await page
      .$$eval('a[href*="/status/"]', (as) => as.slice(0, 100).map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.closest('article, li') as HTMLElement | null)?.innerText ?? '' })))
      .catch(() => []);
    const found = observationsFromMirrorArticles(articles, family, new Date().toISOString());
    return { state: found.length ? 'AVAILABLE' : 'DEGRADED', detail: `${found.length} posts.`, observations: found, requests: 1 };
  },
});

const deps: FoundryDeps = {
  workerId: 'foundry-dry-run',
  leaseMs: 30 * 60_000,
  platform,
  searchIndex: null,
  mirrors: [mirror('TWSTALKER', 'TwStalker'), mirror('SOTWE', 'Sotwe')],
  resolveProfile: async (h) => ({ handle: h, displayName: null, bio: (source?.config.bio as string | undefined) ?? null, website: null }),
  search: async (q) => webSearch(page, q, 8).catch(() => []),
  confirmPost: async () => null,
};

const brief = FoundryBrief.parse({ ...readBrief(briefText), handle, text: briefText });
const run = await researchRepo.createRun({ ownerId: agent.ownerId, agentId: agent.id, kind: 'FOUNDRY_IMPROVE', brief });
const claimed = (await researchRepo.claimDueRun(deps.workerId, deps.leaseMs))!;
if (claimed.id !== run.id) throw new Error('Claimed a different run; is another Foundry run queued in this copy?');
const outcome = await advanceFoundryRun(claimed, deps);
await browser.close();

const finished = (await researchRepo.getRun(run.id))!;
const proposal = await foundryRepo.listItems(run.id);
const report = await foundryReport(run.id);
const lines: string[] = [
  `# Foundry dry run: ${agent.name}`,
  '',
  `Database: ${database}. Outcome: ${outcome}. Nothing was applied.`,
  '',
  '## Stages',
  ...finished.stageLog.map((s) => `- **${s.stage}**: ${s.detail}`),
  '',
  '## Coverage',
  `Corpus: ${report?.corpus.total} items (${report?.corpus.posts} posts, ${report?.corpus.replies} replies, ${report?.corpus.quotes} quotes), ${report?.corpus.from ?? '?'} to ${report?.corpus.to ?? '?'}.`,
  ...(report?.uncertainty ?? []).map((u) => `- Uncertain: ${u}`),
  '',
];
for (const section of Object.keys(FOUNDRY_SECTION_LABELS) as (keyof typeof FOUNDRY_SECTION_LABELS)[]) {
  const mine = proposal.filter((p) => p.section === section);
  if (mine.length === 0) continue;
  lines.push(`## ${FOUNDRY_SECTION_LABELS[section]}`, '');
  for (const item of mine) {
    lines.push(`### ${item.title}  \`${item.assessment}\` (${Math.round(item.confidence * 100)}%)`);
    lines.push(`- Why: ${item.rationale}`);
    lines.push(`- Now: \`${JSON.stringify(item.currentValue)?.slice(0, 600)}\``);
    lines.push(`- Proposed: \`${JSON.stringify(item.proposedValue)?.slice(0, 900)}\``);
    for (const e of item.evidence.slice(0, 3)) lines.push(`  - evidence (${e.tier}): ${e.excerpt.slice(0, 160)}`);
    for (const e of item.counterEvidence.slice(0, 2)) lines.push(`  - counter (${e.tier}): ${e.excerpt.slice(0, 160)}`);
    lines.push('');
  }
}
writeFileSync(out, lines.join('\n'));
console.log(`Wrote ${proposal.length} proposal items to ${out} (${outcome}).`);
await closePool();
