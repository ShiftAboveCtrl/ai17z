import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

/**
 * A guard nobody can satisfy, and a switch nobody can reach.
 *
 * Two settings were enforced by code and absent from the interface, which is a
 * particular kind of bad: the system works exactly as designed, says so, and
 * leaves the owner with no move.
 *
 * The address guard refuses any address the agent was not given -- correctly,
 * because a model asked for one it does not have invents it. But the only place
 * to give it one was `policy.output.verifiedAddresses`, which the policies
 * screen did not render. An owner with a real contract address got a refusal
 * naming a field they could not open.
 *
 * Posting had the same shape from the other direction: the Content section
 * showed the schedule, the reason it last stayed quiet, and when it might next
 * speak -- while the only control that could turn it on lived in Easy Mode.
 */
describe('a setting the runtime enforces can be reached from the interface', () => {
  const policies = read('apps/web/src/routes/sections/PoliciesSection.tsx');
  const content = read('apps/web/src/routes/sections/ContentSection.tsx');
  const api = read('apps/api/src/routes/agentConfig.ts');
  const validator = read('packages/runtime/src/validator.ts');

  it('lets an owner give the agent an address it may state', () => {
    // The guard is what makes the field necessary, so both halves are pinned:
    // removing either one restores the dead end.
    expect(validator).toContain('policy.output.verifiedAddresses');
    expect(policies).toContain('n.output.verifiedAddresses = list(e.target.value)');
  });

  it('turns posting on from the screen that reports it', () => {
    expect(content).toContain("put(`/api/agents/${agentId}/posting`");
    expect(content).toContain('label="Post without being asked"');
    expect(api).toContain("'/api/agents/:id/posting'");
  });

  it('grants POST when posting is turned on', () => {
    // Capabilities are separate from what an agent attempts, and linking an
    // account grants only READ, GENERATE and the reply action. Without the
    // grant the scheduler comes due, finds no permission, and writes a reason
    // into a column nobody reads -- indistinguishable from having nothing to
    // say. Easy Mode learned this already; this is the second door in.
    const route = api.slice(api.indexOf("'/api/agents/:id/posting'"));
    expect(route.slice(0, 2600)).toContain("capabilitiesRepo.grant(agent.id, accountId, 'POST')");
  });

  it('refuses to enable a schedule with no account to post through', () => {
    const route = api.slice(api.indexOf("'/api/agents/:id/posting'"));
    expect(route.slice(0, 2600)).toContain('a schedule with none never fires');
  });
});
