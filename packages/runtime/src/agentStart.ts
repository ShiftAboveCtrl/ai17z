import type { Blocker } from '@xbam/shared/contracts';
import { noBrowserWorker, noWorkerRunning } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  pipelines as pipelinesRepo,
  providers as providersRepo,
  workers as workersRepo,
  WORKER_PRESENT_SECONDS,
} from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';

/*
  Here rather than beside the route that first needed it, because starting an
  agent is now asked for from two places: the Start button, and a linked AI17Z
  Studio. Two copies of this list would agree until somebody added a blocker to
  one of them.
*/

/**
 * What is stopping this agent from running.
 *
 * The shape lives in contracts because the browser renders it: four screens
 * used to declare their own `{ what, fix }[]` inline, and all four dropped the
 * `where` this computes -- so nothing could take somebody to the panel holding
 * the fix.
 */
export async function startPreflight(agentId: string): Promise<Blocker[]> {
  const blockers: Blocker[] = [];

  const [persona, policy, pipeline, models, links] = await Promise.all([
    agentsRepo.getActivePersona(agentId),
    agentsRepo.getActivePolicy(agentId),
    pipelinesRepo.getActivePipeline(agentId),
    providersRepo.listModelConfigs(agentId),
    accountsRepo.listAgentAccounts(agentId),
  ]);

  if (!persona) {
    blockers.push({ what: 'This agent has no character yet.', fix: 'Set a name and a personality.', where: 'persona' });
  }
  if (!policy) {
    blockers.push({ what: 'This agent has no rules yet.', fix: 'Finish the setup.', where: 'persona' });
  }
  if (!pipeline) {
    // The old text said "reopen the agent page, which creates one". Nothing
    // on that path ever did, so anybody who followed it was sent in a circle
    // by their own software. Start now creates it, so this only appears if
    // that failed -- and then it says so rather than giving an instruction.
    blockers.push({
      what: 'This agent has no pipeline, and one could not be created.',
      fix: 'This is a fault in AI17Z rather than something you have missed. Press Start again, and report it if it persists.',
      where: null,
    });
  }

  const primary = models.find((m) => m.role === 'primary');
  if (!primary) {
    blockers.push({
      what: 'No AI model is connected.',
      fix: 'Choose a provider and a model.',
      where: 'models',
    });
  } else {
    const credential = await providersRepo.getProvider(primary.providerCredentialId);
    if (!credential?.enabled) {
      blockers.push({
        what: `The ${credential?.provider ?? 'model'} provider is switched off.`,
        fix: 'Turn it back on in Settings, or choose a different one.',
        where: 'models',
      });
    }
  }

  const enabledLinks = links.filter((l) => l.enabled);
  if (enabledLinks.length === 0) {
    blockers.push({
      what: 'No account is connected, so there is nothing for it to read.',
      fix: 'Connect an X account.',
      where: 'account',
    });
  }

  let needsBrowser = false;
  for (const link of enabledLinks) {
    const account = await accountsRepo.getAccount(link.accountId);
    if (!account) continue;
    if (account.channel === 'x') needsBrowser = true;

    // Only a channel that signs in through a browser can be signed out of. The
    // mock channel has no session, and telling somebody to sign in to it is
    // advice they cannot act on.
    const signsIn = getChannelAdapter(account.channel).requiresBrowser;
    if (signsIn && account.status !== 'CONNECTED') {
      blockers.push({
        what:
          account.status === 'NEEDS_AUTH' || account.status === 'SESSION_EXPIRED'
            ? `The ${account.channel.toUpperCase()} session for @${account.handle} has expired.`
            : `@${account.handle} is not connected (${account.status.toLowerCase().replace(/_/g, ' ')}).`,
        fix: 'Sign in again.',
        where: 'account',
      });
    } else if (!signsIn && account.status === 'ERROR') {
      blockers.push({
        what: `@${account.handle} is in an error state: ${account.lastError ?? 'no reason recorded'}.`,
        fix: 'Clear it from the account panel, or connect a different account.',
        where: 'account',
      });
    }

    const grants = await capabilitiesRepo.grantsFor(agentId, link.accountId);
    if (!grants.has('REPLY')) {
      blockers.push({
        what: `This agent is not permitted to reply through @${account.handle}.`,
        fix: 'Grant it the reply capability on the account.',
        where: 'capabilities',
      });
    }
  }

  if (needsBrowser) {
    const workers = await workersRepo.present();
    if (!workers.some((w) => w.browserCapable)) {
      // Said differently depending on which of the two it is, because they look
      // identical from the outside and only one of them is confusing.
      //
      // The containerised worker polls, ingests and logs, so somebody watching
      // it work is told "nothing is running that can open a browser" and
      // reasonably concludes the message is wrong. It is not: that worker runs
      // with AI17Z_WORKER_ROLE=jobs because a container has no display, and the
      // browser work is deliberately left to a second worker on this machine.
      //
      // The old advice was `npm run dev:worker`, which is a developer command
      // that an installed copy has no way to run.
      blockers.push(
        workers.length > 0
          ? { ...noBrowserWorker(), where: 'worker' }
          : { ...noWorkerRunning(WORKER_PRESENT_SECONDS), where: 'worker' },
      );
    }
  }

  return blockers;
}
