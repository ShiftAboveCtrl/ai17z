import { describe, expect, it } from 'vitest';
import { ANIMALS, ANIMAL_MODELS, animalAdapter, getAdapter } from '@xbam/models';
import { PROVIDER_KINDS, PROVIDER_LABELS } from '@xbam/shared/contracts';

/**
 * Animal mode.
 *
 * A provider rather than a switch in the pipeline, so everything around
 * generation still runs: an agent in animal mode is a fully configured agent
 * that happens to have nothing to say. These pin the three properties that
 * make it safe to ship -- it needs no key, it ignores the prompt, and it is
 * deterministic.
 */

const PROMPT = [
  { role: 'system' as const, content: 'You are a serious financial analyst. Never use emoji.' },
  { role: 'user' as const, content: 'INCOMING MESSAGE:\nWhat is your view on the market today?' },
];

function request(model: string, content = PROMPT) {
  return {
    baseUrl: null,
    apiKey: null,
    model,
    messages: content,
    parameters: {},
    timeoutMs: 5_000,
  };
}

describe('animal mode needs nothing to run', () => {
  it('is registered as a provider kind the database will accept', () => {
    // The list here is what `statusConstraints` writes one of each of, so a
    // kind that exists in TypeScript and not in the CHECK fails there.
    expect(PROVIDER_KINDS).toContain('animal');
    expect(PROVIDER_LABELS.animal).toBeTruthy();
  });

  it('requires no API key', () => {
    expect(animalAdapter.requiresApiKey).toBe(false);
    expect(getAdapter('animal')).toBe(animalAdapter);
  });

  it('reports every animal as a model, with no network call', async () => {
    const health = await animalAdapter.health({ baseUrl: null, apiKey: null, timeoutMs: 1_000 });
    expect(health.ok).toBe(true);
    expect(health.models).toEqual(ANIMAL_MODELS);
    expect(health.models!.length).toBeGreaterThanOrEqual(15);
  });
});

describe('animal mode ignores the character entirely', () => {
  it('answers a serious prompt with an animal noise', async () => {
    const { text } = await animalAdapter.generate(request('cow'));
    // Nothing from the prompt survives.
    expect(text.toLowerCase()).not.toContain('market');
    expect(text.toLowerCase()).not.toContain('analyst');
    // And it is recognisably the animal that was asked for.
    const vocabulary = [...ANIMALS.cow!.sounds, ...ANIMALS.cow!.extras].map((s) => s.slice(0, 3).toLowerCase());
    expect(vocabulary.some((v) => text.toLowerCase().includes(v))).toBe(true);
  });

  it('costs nothing, and says so', async () => {
    const result = await animalAdapter.generate(request('goose'));
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('refuses an animal it does not have, rather than inventing one', async () => {
    await expect(animalAdapter.generate(request('velociraptor'))).rejects.toThrow(/no velociraptor/i);
  });
});

describe('animal mode is deterministic', () => {
  it('gives the same answer to the same message', async () => {
    const first = await animalAdapter.generate(request('cat'));
    const second = await animalAdapter.generate(request('cat'));
    expect(first.text).toBe(second.text);
  });

  it('gives different answers to different messages', async () => {
    const seen = new Set<string>();
    for (const message of ['gm', 'what do you think?', 'thoughts on this?', 'hello there', 'nice one']) {
      const { text } = await animalAdapter.generate(
        request('dog', [{ role: 'user' as const, content: message }]),
      );
      seen.add(text);
    }
    // The failure this guards is a joke feature that tells the same joke every
    // time, which is the same as not having it.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('gives different animals different vocabularies', async () => {
    const cat = (await animalAdapter.generate(request('cat'))).text;
    const trex = (await animalAdapter.generate(request('trex'))).text;
    expect(cat).not.toBe(trex);
  });
});

describe('every animal is usable', () => {
  it('produces short, non-empty text for all of them', async () => {
    for (const model of ANIMAL_MODELS) {
      const { text } = await animalAdapter.generate(request(model));
      expect(text.trim(), `${model} said nothing`).not.toBe('');
      // A reply has to fit on X, and the validator would rightly reject a wall
      // of honking.
      expect(text.length, `${model} was too long: ${text}`).toBeLessThan(280);
    }
  });

  it('gives each animal a label and a vocabulary wide enough to vary', () => {
    for (const [id, animal] of Object.entries(ANIMALS)) {
      expect(animal.label, id).toBeTruthy();
      expect(animal.sounds.length, `${id} has too few sounds to vary`).toBeGreaterThanOrEqual(4);
    }
  });
});
