import { beforeAll, describe, expect, it } from 'vitest';
import { answeredByCapability, bootstrapRuntime, withoutWhatACapabilityAnswers } from '@xbam/runtime';
import type { CapabilityPermission } from '@xbam/shared/contracts';

/**
 * A question something here already answers does not go to a search engine.
 *
 * The failure, measured on a real job: asked the time, the agent was offered
 * `time.now` and nothing else, and answered "I couldn't check your local
 * time". The research step had already sent the question to the open web,
 * where it failed, and a failed lookup arrives in the prompt as a fact. The
 * agent was holding the answer and had been told it did not have one.
 *
 * The first version of this rule was a pattern matching "what time is it". It
 * held for the phrasing in the corpus, which carries no question mark, and not
 * for the one people actually type: `worthPlanning` consults the classifier
 * for any message with a question mark, and measured against the classifier a
 * live agent runs, "what time is it right now?" came back planned as
 * `search:what time is it right now?`.
 *
 * So the rule is stated once, where the rules and the model's plan converge,
 * in terms of the two things a capability already declares. Nothing here knows
 * what a clock is.
 */

const NOTHING_STORED = new Map<string, CapabilityPermission>();

const input = (permissions = NOTHING_STORED) => ({
  agentId: 'agent-1',
  jobId: null,
  // No connected account, which is what makes the readiness half of the rule
  // observable below.
  accountId: null,
  permissions,
});

const search = (query: string) => ({ kind: 'search' as const, query, reason: 'because' });

beforeAll(async () => {
  await bootstrapRuntime();
});

describe('a lookup a capability answers is not sent to the web', () => {
  /*
    All three phrasings, because the bypass was that one of them was covered
    and the others were not. The middle one is the exact query the classifier
    produced on a live installation.
  */
  for (const asked of ['What time is it?', 'what time is it right now?', 'what time is it where you are right now, actually']) {
    it(`drops "${asked}" and names the capability that answers it`, async () => {
      const { kept, dropped } = await withoutWhatACapabilityAnswers([search(asked)], input());
      expect(kept).toEqual([]);
      expect(dropped.map((d) => d.capabilityId)).toEqual(['time.now']);
    });
  }

  /*
    Discriminating, or it proves nothing. A rule that dropped every lookup
    would pass every case above and cost the agent the open web.
  */
  it('keeps a question nothing here can answer', async () => {
    const asked = 'who won the match last night?';
    expect((await withoutWhatACapabilityAnswers([search(asked)], input())).kept.map((l) => l.query)).toEqual([asked]);
  });

  /*
    The case that proves the bar is higher for removing a source than for
    offering one. "what did the protocol announce at the summit today?"
    shortlists `defi.protocol_tvl`, on the word protocol, and a total-value-
    locked figure does not say what anybody announced. The weather is the same
    shape: `time.now` and a reference lookup both match, and neither of them
    knows what it is doing in Chicago.
  */
  it('keeps a question several capabilities merely brush against', async () => {
    for (const asked of ['what did the protocol announce at the summit today?', 'what is the weather in Chicago today?']) {
      expect((await withoutWhatACapabilityAnswers([search(asked)], input())).kept.map((l) => l.query), asked).toEqual([asked]);
    }
  });

  it('leaves a contract lookup alone, because it is a different source', async () => {
    const token = { kind: 'token' as const, query: '0x' + 'a'.repeat(40), reason: 'an address was mentioned' };
    expect((await withoutWhatACapabilityAnswers([token], input())).kept).toEqual([token]);
  });
});

/**
 * The half that keeps the rule safe.
 *
 * "Can it answer this" is not the same question as "can it answer it now".
 * `x.read_timeline` matches a question about somebody's posts, and on an agent
 * with no connected account it cannot run. Suppressing a web lookup on the
 * strength of a capability that will report UNAVAILABLE would leave the
 * question with no source at all, which is a worse version of the bug this
 * fixes.
 */
describe('only a capability that can run right now displaces a lookup', () => {
  it('does not let an unavailable capability suppress anything', async () => {
    /*
      Chosen because it shortlists exactly one capability, `x.read_inbox`, so
      readiness is the only thing standing between it and a suppressed lookup.
      With no connected account it reports UNAVAILABLE and the web survives.
    */
    const asked = 'what is in my dm inbox right now?';
    expect(await answeredByCapability(asked, input())).toBeNull();
    expect((await withoutWhatACapabilityAnswers([search(asked)], input())).kept).toHaveLength(1);
  });

  it('does not let a capability the owner switched off suppress anything', async () => {
    const off = new Map<string, CapabilityPermission>([['time.now', 'DISABLED']]);
    expect(await answeredByCapability('What time is it?', input(off))).toBeNull();
    expect((await withoutWhatACapabilityAnswers([search('What time is it?')], input(off))).kept).toHaveLength(1);
  });
});
