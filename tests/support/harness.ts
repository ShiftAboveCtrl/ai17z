import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { NormalizedEvent } from '@xbam/shared/contracts';
import { setupTestDatabase, teardownTestDatabase, truncateAll, uniqueSuffix } from './db';
import { seedCatalogue } from './fixtures';

/** Registers the database lifecycle every integration file needs. */
export function installHarness(): void {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  afterAll(async () => {
    await teardownTestDatabase();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedCatalogue();
  });
}

export function mockEvent(text: string, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const id = `evt-${uniqueSuffix()}`;
  return {
    channel: 'mock',
    type: 'MENTION',
    remoteEventId: id,
    remoteMessageId: id,
    remoteAuthorId: 'mock-user-alice',
    remoteAuthorHandle: 'alice',
    remoteAuthorDisplayName: 'Alice',
    remoteConversationId: `thread-${uniqueSuffix()}`,
    parentRemoteMessageId: null,
    remoteUrl: `mock://message/${id}`,
    text,
    occurredAt: new Date().toISOString(),
    raw: {},
    ...overrides,
  };
}
