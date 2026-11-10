import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Factories } from '@farcaster/core';

const require = createRequire(import.meta.url);
const farcasterRequire = createRequire(require.resolve('@farcaster/core'));
const { faker } = farcasterRequire('@faker-js/faker');

describe('Farcaster factories with current faker', () => {
  it('keeps the bounded 7.x number default when only min is supplied', () => {
    for (let i = 0; i < 100; i++) {
      const fid = Factories.Fid.build();
      expect(Number.isInteger(fid)).toBe(true);
      expect(fid).toBeGreaterThanOrEqual(1);
      expect(fid).toBeLessThanOrEqual(100_000);
    }
    expect(faker.datatype.number({ min: 42, max: 42 })).toBe(42);
  });

  it('preserves lowercase alphanumeric names and user data', () => {
    expect(Buffer.from(Factories.EnsName.build()).toString()).toMatch(/^[a-z0-9]{3,16}\.eth$/);
    expect(Factories.UserDataBody.build().value).toMatch(/^[a-z0-9]{16}$/);
  });

  it('builds on-chain dates through both legacy date signatures', () => {
    const event = Factories.OnChainEvent.build();
    expect(event.blockTimestamp).toBeGreaterThanOrEqual(1_609_459_200);
    expect(event.blockTimestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    const rental = Factories.StorageRentOnChainEvent.build();
    expect(rental.blockTimestamp).toBeGreaterThan(Math.floor(Date.now() / 1000) - 367 * 86_400);
    expect(rental.blockTimestamp).toBeLessThan(Math.floor(Date.now() / 1000) - 86_399);
  });

  it('keeps modern faker APIs available without changing the upstream singleton', () => {
    const { faker: current } = require('@faker-js/faker');
    expect(current.datatype.number).toBeUndefined();
    expect(current.random).toBeUndefined();
    expect(faker.number.int({ min: 42, max: 42 })).toBe(42);
    const date = faker.date.between({ from: 1_000, to: 1_000 });
    expect(date.getTime()).toBe(1_000);
  });
});
