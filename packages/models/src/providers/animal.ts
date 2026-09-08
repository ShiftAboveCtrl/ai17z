import { PROVIDER_CATALOGUE } from '@xbam/shared/contracts';
import { PipelineError, sha256Hex } from '@xbam/shared';
import type { ProviderAdapter, ProviderHealth, ProviderRequest, ProviderResponse } from '../types';

/**
 * Animal mode.
 *
 * A model provider that needs no account, no key, and no network, and that
 * ignores the prompt entirely. Whatever persona, memory, stance and voice the
 * ten prompt layers assembled, what comes back is an animal noise -- because
 * the point of this provider is to exercise everything *around* generation
 * without paying a provider or waiting on one.
 *
 * It is a provider rather than a switch somewhere in the pipeline on purpose.
 * The runtime already knows how to route a role to a provider, fall back, record
 * a trace and count tokens; a second mechanism beside that would be a second
 * thing to keep working. Selecting an animal is selecting a model, so cadence,
 * policy, rate limits, capabilities, approvals, the validator, the voice
 * compiler and duplicate suppression all still apply. An agent in animal mode
 * is a fully configured agent that happens to have nothing to say.
 *
 * Deterministic, in the way `mock` is: the noise is derived from a hash of the
 * incoming message, so the same message always produces the same reply and a
 * test can assert on it. Different messages produce visibly different noise.
 */

interface Animal {
  label: string;
  /** Core vocabulary. */
  sounds: string[];
  /** Occasional stage directions, for the ones that earn it. */
  extras: string[];
}

/**
 * The roster.
 *
 * Kept deliberately broad because the failure mode of a joke feature is that it
 * is the same joke every time. Every entry needs a vocabulary wide enough that
 * two consecutive replies do not look identical.
 */
export const ANIMALS: Record<string, Animal> = {
  cat: {
    label: 'Cat',
    sounds: ['meow', 'mrrp', 'mrow', 'purr', 'mew', 'prrrp', 'mrrrow', 'nya'],
    extras: ['*knocks your drink off the table*', '*sits on the keyboard*', '*stares at nothing*', '*loaf*'],
  },
  dog: {
    label: 'Dog',
    sounds: ['woof', 'bork', 'arf', 'awoo', 'boof', 'yip', 'ruff'],
    extras: ['*tail helicopter*', '*brings you a stick*', '*zoomies*', '*head tilt*'],
  },
  cow: {
    label: 'Cow',
    sounds: ['moo', 'mooo', 'mrooo', 'moo?', 'mooooo'],
    extras: ['*chews thoughtfully*', '*stands in field*', '*regards you across the fence*'],
  },
  duck: {
    label: 'Duck',
    sounds: ['quack', 'quack quack', 'qwack', 'mek', 'quonk'],
    extras: ['*bread radar activated*', '*smug waddle*', '*tips forward in pond*'],
  },
  goose: {
    label: 'Goose',
    sounds: ['HONK', 'honk', 'HONNNK', 'hiss', 'HONK HONK'],
    extras: ['*unhinged*', '*charges without warning*', '*steals your sandwich*', '*no notes, only violence*'],
  },
  fox: {
    label: 'Fox',
    sounds: ['ring-ding-ding', 'wa-pa-pa-pow', 'yip', 'skree', 'gering-ding'],
    extras: ['*what does it say*', '*disappears into hedge*'],
  },
  frog: {
    label: 'Frog',
    sounds: ['ribbit', 'croak', 'brrrp', 'ribbit ribbit', 'gribbit'],
    extras: ['*blinks with entire face*', '*sits on lily pad*', '*catches fly mid-sentence*'],
  },
  owl: {
    label: 'Owl',
    sounds: ['hoo', 'hoot', 'who', 'hoooo', 'screech'],
    extras: ['*rotates head 270 degrees*', '*judges you silently*', '*is nocturnal about it*'],
  },
  crab: {
    label: 'Crab',
    sounds: ['click', 'clack', 'snip', 'clickclick', 'skitter'],
    extras: ['*scuttles sideways*', '*raises one claw*', '*aggressive sideways approach*'],
  },
  pigeon: {
    label: 'Pigeon',
    sounds: ['coo', 'currroo', 'coo coo', 'prrroo'],
    extras: ['*head bob*', '*owns this pavement*', '*refuses to move for traffic*'],
  },
  sheep: {
    label: 'Sheep',
    sounds: ['baa', 'baaa', 'bleat', 'baaaaa', 'meh'],
    extras: ['*follows the other sheep*', '*chews*', '*is extremely wool*'],
  },
  horse: {
    label: 'Horse',
    sounds: ['neigh', 'nicker', 'whinny', 'snort', 'brrrrr'],
    extras: ['*stamps hoof once for yes*', '*side-eye*', '*is a very long dog*'],
  },
  wolf: {
    label: 'Wolf',
    sounds: ['awoooo', 'howl', 'grrr', 'awoo', 'yip'],
    extras: ['*to the moon, specifically*', '*pack behaviour*', '*dramatic silhouette*'],
  },
  dolphin: {
    label: 'Dolphin',
    sounds: ['eee-eee', 'click-click', 'squeee', 'ee-ee-ee'],
    extras: ['*so long, and thanks for all the fish*', '*does a flip*', '*suspiciously intelligent*'],
  },
  raccoon: {
    label: 'Raccoon',
    sounds: ['chitter', 'trill', 'churr', 'chrr-chrr'],
    extras: ['*washes something that did not need washing*', '*in your bin*', '*tiny hands*'],
  },
  seagull: {
    label: 'Seagull',
    sounds: ['MINE', 'mine mine mine', 'kyaa', 'AAAA', 'skraw'],
    extras: ['*takes your chip*', '*no remorse*', '*seaside menace*'],
  },
  goat: {
    label: 'Goat',
    sounds: ['maaa', 'MAAAA', 'bleh', 'maa?', 'mehhh'],
    extras: ['*screams for no reason*', '*eats something structural*', '*climbs the impossible*'],
  },
  chicken: {
    label: 'Chicken',
    sounds: ['bawk', 'buk buk', 'bagawk', 'cluck', 'BUKAW'],
    extras: ['*pecks*', '*existential head movement*', '*lays an egg about it*'],
  },
  snake: {
    label: 'Snake',
    sounds: ['ssss', 'hiss', 'sssssss', 'sss?'],
    extras: ['*is just a long face*', '*noodle intensifies*', '*no legs, no problems*'],
  },
  trex: {
    label: 'T-rex',
    sounds: ['ROAR', 'rawr', 'RAAAAWR', 'grrraw'],
    extras: ['*tiny arms of frustration*', '*cannot clap*', '*apex, but inconvenienced*'],
  },
};

export const ANIMAL_MODELS = Object.keys(ANIMALS).sort();

export const animalAdapter: ProviderAdapter = {
  kind: 'animal',
  defaultBaseUrl: PROVIDER_CATALOGUE.animal.defaultBaseUrl,
  // The whole point. There is nothing to sign up for and nothing to bill.
  requiresApiKey: PROVIDER_CATALOGUE.animal.requiresApiKey,

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const animal = ANIMALS[request.model.trim().toLowerCase()];
    if (!animal) {
      throw PipelineError.permanent(
        'unknown_animal',
        `There is no ${request.model} in animal mode. Available: ${ANIMAL_MODELS.join(', ')}.`,
      );
    }

    // The prompt is read for one purpose only -- to seed the noise so the same
    // message always gets the same answer. Nothing in it reaches the output,
    // which is what "strips the character" means here.
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const text = speak(animal, sha256Hex(`${request.model}:${lastUser}`));

    return {
      text,
      requestId: `animal-${sha256Hex(lastUser + request.model).slice(0, 12)}`,
      promptTokens: 0,
      completionTokens: 0,
      raw: { provider: 'animal', model: request.model },
    };
  },

  async health(): Promise<ProviderHealth> {
    return {
      ok: true,
      detail: `Animal mode. No key, no network, no opinions. ${ANIMAL_MODELS.length} available.`,
      models: ANIMAL_MODELS,
    };
  },
};

/**
 * Composes one utterance from a hex digest.
 *
 * Every choice is a byte of the digest, so this is a pure function of its seed:
 * the same message always produces the same noise, which is what makes it
 * testable and stops an agent answering the same post differently on a retry.
 */
export function speak(animal: Animal, digest: string): string {
  const byteAt = (index: number): number => parseInt(digest.slice(index * 2, index * 2 + 2), 16) || 0;
  const pick = <T>(list: readonly T[], index: number): T => list[byteAt(index) % list.length]!;

  // One to three noises. Weighted toward two, because one reads as terse and
  // four reads as a wall.
  const count = 1 + (byteAt(0) % 3);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let sound = pick(animal.sounds, i + 1);
    // Occasionally stretch a vowel, which is most of what makes it read as an
    // animal rather than a list.
    if (byteAt(i + 8) % 4 === 0) sound = stretch(sound, 1 + (byteAt(i + 12) % 3));
    parts.push(sound);
  }

  let text = parts.join(' ');
  // A stage direction about a third of the time.
  if (byteAt(20) % 3 === 0 && animal.extras.length > 0) {
    text = `${text} ${pick(animal.extras, 21)}`;
  }
  // A question mark occasionally, which does a surprising amount of work.
  if (byteAt(22) % 5 === 0) text = `${text}?`;

  return text;
}

/** Lengthens the last run of vowels: "meow" -> "meeeow". */
function stretch(sound: string, by: number): string {
  const match = sound.match(/[aeiouAEIOU](?=[^aeiouAEIOU]*$)/);
  if (!match || match.index === undefined) return sound;
  const vowel = sound[match.index]!;
  return sound.slice(0, match.index) + vowel.repeat(1 + by) + sound.slice(match.index + 1);
}
