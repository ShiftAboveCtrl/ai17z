import { describe, expect, it } from 'vitest';
import { PipelineError } from '@xbam/shared';
import { checkModelStillOffered, statusOf, verdictFromError, verdictFromModels } from '@xbam/models';

const httpError = (status: number, message = 'boom') =>
  new PipelineError(status >= 500 || status === 429 ? 'RETRYABLE' : 'PERMANENT', `http_${status}`, message, { status });

/**
 * A rejected key, an outage, a rate limit and a typo in a base URL all arrived
 * at the interface as the same red dot and a sentence. They need entirely
 * different things done about them, and only one of them is the owner's fault.
 *
 * The status was known the whole time -- the HTTP layer classifies it and puts
 * it on the error -- and then the health check threw it away.
 */
describe('what is actually wrong with a provider', () => {
  it('reads the status the HTTP layer recorded', () => {
    expect(statusOf(httpError(401))).toBe(401);
    expect(statusOf(new Error('plain'))).toBeNull();
  });

  it('a rejected key is the owner\'s to fix, and waiting will not help', () => {
    const verdict = verdictFromError(httpError(401), 'xAI');
    expect(verdict.state).toBe('INVALID_CREDENTIALS');
    expect(verdict.detail).toContain('xAI');
    expect(verdict.fix).toMatch(/replace the key/i);
    expect(verdict.transient).toBe(false);
  });

  it('catches a rejected key from a provider that answers 400', () => {
    // The exact response the live xAI API gives for a wrong key. Classifying on
    // the status alone called this an outage and told the owner to wait, which
    // is the opposite of what they needed to do.
    const real =
      'xAI: xAI returned 400: {"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}';
    const verdict = verdictFromError(httpError(400, real), 'xAI');
    expect(verdict.state).toBe('INVALID_CREDENTIALS');
    expect(verdict.transient).toBe(false);
    expect(verdict.fix).toMatch(/replace the key/i);
  });

  it('does not read an ordinary bad request as a key problem', () => {
    const verdict = verdictFromError(httpError(400, 'model "nope" does not exist'), 'OpenAI');
    expect(verdict.state).not.toBe('INVALID_CREDENTIALS');
  });

  it('403 is the same answer as 401', () => {
    expect(verdictFromError(httpError(403), 'OpenAI').state).toBe('INVALID_CREDENTIALS');
  });

  it('a rate limit is not a misconfiguration, and says so', () => {
    const verdict = verdictFromError(httpError(429), 'OpenRouter');
    expect(verdict.state).toBe('RATE_LIMITED');
    expect(verdict.fix).toMatch(/nothing needs changing/i);
    expect(verdict.transient).toBe(true);
  });

  it('a provider outage is named as the provider\'s, not the setup\'s', () => {
    const verdict = verdictFromError(httpError(503), 'DeepSeek');
    expect(verdict.state).toBe('UNAVAILABLE');
    expect(verdict.detail).toContain('503');
    expect(verdict.fix).toMatch(/provider, not the configuration/i);
    expect(verdict.transient).toBe(true);
  });

  it('no model list is not a failure', () => {
    // Anthropic is the ordinary case. Models are named by hand and that is fine.
    const verdict = verdictFromError(httpError(404), 'Claude');
    expect(verdict.state).toBe('NO_MODEL_LIST');
    expect(verdict.fix).toMatch(/type the model identifier/i);
  });

  it('a timeout and an unreachable host say which they were', () => {
    expect(verdictFromError(new Error('OpenAI timed out after 15000ms.'), 'OpenAI').detail).toMatch(/did not answer in time/i);
    expect(verdictFromError(new Error('network error: ENOTFOUND'), 'Local').detail).toMatch(/could not be reached/i);
  });

  it('an unrecognised failure still names the provider and suggests something', () => {
    const verdict = verdictFromError(new Error('something odd'), 'Ollama');
    expect(verdict.state).toBe('UNAVAILABLE');
    expect(verdict.detail).toContain('Ollama');
    expect(verdict.fix).toBeTruthy();
  });
});

describe('a successful check', () => {
  it('counts what it can offer', () => {
    const verdict = verdictFromModels('xAI', ['grok-4.6', 'grok-4']);
    expect(verdict.state).toBe('CONNECTED');
    expect(verdict.detail).toContain('2 models');
    expect(verdict.fix).toBeNull();
  });

  it('answering with no models is its own state, not success', () => {
    expect(verdictFromModels('Claude', []).state).toBe('NO_MODEL_LIST');
  });
});

describe('a model the provider no longer offers', () => {
  it('is reported rather than left looking healthy', () => {
    // The expensive quiet failure: every screen says connected, and every
    // generation fails.
    const stale = checkModelStillOffered('xAI', 'grok-2-retired', ['grok-4.6']);
    expect(stale?.state).toBe('MODEL_UNAVAILABLE');
    expect(stale?.detail).toContain('grok-2-retired');
    expect(stale?.fix).toMatch(/choose another model/i);
  });

  it('says nothing when the model is still there', () => {
    expect(checkModelStillOffered('xAI', 'grok-4.6', ['grok-4.6'])).toBeNull();
  });

  it('cannot judge a provider that publishes no list', () => {
    // Absence of a list is not evidence the model is gone.
    expect(checkModelStillOffered('Claude', 'claude-sonnet-4', [])).toBeNull();
  });

  it('says nothing when no model has been chosen', () => {
    expect(checkModelStillOffered('xAI', null, ['grok-4.6'])).toBeNull();
  });
});
