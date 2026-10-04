import { describe, expect, it } from 'vitest';
import {
  SENSITIVE_INPUT_RULES,
  STREAM_BOUNDS,
  TAKEOVER_EVENTS,
  TAKEOVER_STATES,
  agentMayBegin,
  agentMayWrite,
  applyTakeover,
  maySendFrame,
  ownerMayType,
  type TakeoverEvent,
  type TakeoverState,
} from '@xbam/runtime';

/**
 * Who is holding the keyboard.
 *
 * The property worth proving is a negative: there is no state in which the
 * agent may start something and the owner may type. Everything else here is
 * about reaching that state machine's corners, including the ones two browser
 * tabs produce by both sending the same event.
 */

describe('the agent and the owner are never both acting', () => {
  it('has no state where the agent may begin and the owner may type', () => {
    // Checked across every state rather than the ones somebody thought of.
    for (const state of TAKEOVER_STATES) {
      expect(agentMayBegin(state) && ownerMayType(state), state).toBe(false);
    }
  });

  it('lets the agent finish but not start once the owner has asked', () => {
    // Cutting an agent off mid-operation is the thing this exists to avoid,
    // so writing continues and beginning stops.
    expect(agentMayWrite('OWNER_REQUESTED')).toBe(true);
    expect(agentMayBegin('OWNER_REQUESTED')).toBe(false);
    // And the owner does not have it yet.
    expect(ownerMayType('OWNER_REQUESTED')).toBe(false);
  });

  it('stops the agent writing entirely once the owner holds the page', () => {
    for (const state of ['OWNER_CONTROL', 'WAITING_FOR_HUMAN', 'RESUME_PENDING', 'OFFLINE'] as const) {
      expect(agentMayWrite(state), state).toBe(false);
      expect(agentMayBegin(state), state).toBe(false);
    }
  });
});

describe('handing the page over', () => {
  it('does not take it away until the agent says it stopped somewhere safe', () => {
    const asked = applyTakeover('AGENT_CONTROL', 'OWNER_REQUESTS');
    expect(asked.state).toBe('OWNER_REQUESTED');
    // The owner cannot type yet, however much they would like to.
    expect(ownerMayType(asked.state)).toBe(false);

    const handed = applyTakeover(asked.state, 'AGENT_YIELDED');
    expect(handed.state).toBe('OWNER_CONTROL');
    expect(ownerMayType(handed.state)).toBe(true);
  });

  it('goes back if the owner changes their mind before the agent yields', () => {
    expect(applyTakeover('OWNER_REQUESTED', 'OWNER_RELEASES').state).toBe('AGENT_CONTROL');
  });

  it('returns through RESUME_PENDING rather than straight to the agent', () => {
    // So the agent picks the page up deliberately rather than discovering it.
    const released = applyTakeover('OWNER_CONTROL', 'OWNER_RELEASES');
    expect(released.state).toBe('RESUME_PENDING');
    expect(agentMayBegin(released.state)).toBe(false);
    expect(applyTakeover(released.state, 'AGENT_RESUMED').state).toBe('AGENT_CONTROL');
  });

  it('lets the owner take it back before the agent resumes', () => {
    expect(applyTakeover('RESUME_PENDING', 'OWNER_REQUESTS').state).toBe('OWNER_CONTROL');
  });
});

describe('a challenge is answered by a person', () => {
  it('reaches WAITING_FOR_HUMAN from everywhere the page is live', () => {
    for (const state of ['AGENT_CONTROL', 'OWNER_REQUESTED', 'OWNER_CONTROL', 'RESUME_PENDING'] as const) {
      expect(applyTakeover(state, 'CHALLENGE_SEEN').state, state).toBe('WAITING_FOR_HUMAN');
    }
  });

  it('cannot be left by anything an agent can do', () => {
    // There is no event here an agent raises: AI17Z never answers a CAPTCHA,
    // a second factor or a device confirmation.
    const agentEvents: TakeoverEvent[] = ['AGENT_YIELDED', 'AGENT_RESUMED'];
    for (const event of agentEvents) {
      const out = applyTakeover('WAITING_FOR_HUMAN', event);
      expect(out.moved, event).toBe(false);
      expect(out.state).toBe('WAITING_FOR_HUMAN');
    }
    // A person can take it or let it go.
    expect(applyTakeover('WAITING_FOR_HUMAN', 'OWNER_REQUESTS').state).toBe('OWNER_CONTROL');
    expect(applyTakeover('WAITING_FOR_HUMAN', 'OWNER_RELEASES').state).toBe('RESUME_PENDING');
  });

  it('stops the agent writing while a human is needed', () => {
    expect(agentMayWrite('WAITING_FOR_HUMAN')).toBe(false);
  });
});

describe('a browser that disappears', () => {
  it('is accepted from every live state rather than argued with', () => {
    for (const state of TAKEOVER_STATES.filter((s) => s !== 'OFFLINE')) {
      expect(applyTakeover(state, 'BROWSER_LOST').state, state).toBe('OFFLINE');
    }
  });

  it('comes back to the agent, not to a half-finished takeover', () => {
    expect(applyTakeover('OFFLINE', 'BROWSER_READY').state).toBe('AGENT_CONTROL');
  });

  it('ignores everything else while offline', () => {
    for (const event of TAKEOVER_EVENTS.filter((e) => e !== 'BROWSER_READY')) {
      expect(applyTakeover('OFFLINE', event).moved, event).toBe(false);
    }
  });
});

describe('an event that does not apply is not an error', () => {
  it('reports it did not move and leaves the state alone', () => {
    // Two tabs open on one agent both send OWNER_RELEASES; the second one is
    // simply already true, and that is not an exception.
    const out = applyTakeover('AGENT_CONTROL', 'OWNER_RELEASES');
    expect(out.moved).toBe(false);
    expect(out.state).toBe('AGENT_CONTROL');
    expect(out.detail).toContain('does not apply');
  });

  it('never throws, whatever pair it is given', () => {
    for (const state of TAKEOVER_STATES) {
      for (const event of TAKEOVER_EVENTS) {
        expect(() => applyTakeover(state as TakeoverState, event)).not.toThrow();
      }
    }
  });

  it('only ever lands on a state in the list', () => {
    for (const state of TAKEOVER_STATES) {
      for (const event of TAKEOVER_EVENTS) {
        expect(TAKEOVER_STATES).toContain(applyTakeover(state, event).state);
      }
    }
  });
});

describe('what the stream is bounded by', () => {
  it('bounds every dimension the host can be hurt through', () => {
    // Each of these maps to a real startScreencast parameter rather than to
    // an intention: everyNthFrame, maxWidth, maxHeight, format and quality.
    expect(STREAM_BOUNDS.everyNthFrame).toBeGreaterThan(1);
    expect(STREAM_BOUNDS.maxWidth).toBeLessThanOrEqual(1920);
    expect(STREAM_BOUNDS.maxHeight).toBeLessThanOrEqual(1080);
    expect(STREAM_BOUNDS.quality).toBeLessThan(100);
    expect(STREAM_BOUNDS.format).toBe('jpeg');
    expect(STREAM_BOUNDS.idleStopAfterMs).toBeGreaterThan(0);
  });

  it('does not record by default', () => {
    // Watching an agent work is not the same as keeping a video of it.
    expect(STREAM_BOUNDS.record).toBe(false);
  });

  it('declines to acknowledge rather than growing a queue', () => {
    // Chrome keeps producing frames while they are acknowledged, so the host
    // withholds the acknowledgement instead of buffering.
    expect(maySendFrame(0)).toBe(true);
    expect(maySendFrame(STREAM_BOUNDS.maxUnackedFrames - 1)).toBe(true);
    expect(maySendFrame(STREAM_BOUNDS.maxUnackedFrames)).toBe(false);
    expect(maySendFrame(STREAM_BOUNDS.maxUnackedFrames + 50)).toBe(false);
  });
});

describe('what may never happen to something the owner typed', () => {
  it('says so explicitly, including that an audit row holds no keystrokes', () => {
    const all = SENSITIVE_INPUT_RULES.join(' ').toLowerCase();
    expect(all).toContain('never written to a log');
    expect(all).toContain('never persisted');
    expect(all).toContain('never replayed');
    expect(all).toContain('telemetry');
    // The distinction that matters: the audit says a takeover happened, not
    // what was typed during it.
    expect(all).toContain('never what was typed');
    expect(all).toContain('person only');
  });

  it('claims minimisation and not end-to-end encryption', () => {
    // The control plane relays the keystrokes, so claiming blindness would be
    // claiming a guarantee the architecture does not deliver.
    const rules = SENSITIVE_INPUT_RULES.join(' ').toLowerCase();
    expect(rules).not.toContain('end-to-end');
    expect(rules).not.toContain('zero-knowledge');
  });
});
