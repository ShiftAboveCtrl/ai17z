import { describe, expect, it } from 'vitest';
import { ACCOUNT_STATUSES } from '@xbam/shared/contracts';
import { accounts as accountsRepo } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The enum and the CHECK constraint have to agree.
 *
 * They did not: migration 0020 added seven account states and taught the code to
 * write them while the constraint still listed the old five. Every sign-in died
 * at the database with a constraint error, and no test noticed because the unit
 * tests never touched Postgres and the integration tests only wrote old values.
 */
describe('every account status the code can produce is one the database accepts', () => {
  it('writes each status in the contract without violating the constraint', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `status_${uniqueSuffix()}`,
    });

    for (const status of ACCOUNT_STATUSES) {
      const updated = await accountsRepo.updateAccount(account.id, { status });
      expect(updated.status).toBe(status);
    }
  });

  it('still refuses a status that is not in the contract', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `status_${uniqueSuffix()}`,
    });

    await expect(
      accountsRepo.updateAccount(account.id, { status: 'DEFINITELY_NOT_A_STATUS' as never }),
    ).rejects.toThrow();
  });
});
