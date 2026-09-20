import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '@xbam/shared/contracts';

/**
 * The activity card said "Reply" about everything.
 *
 * An agent also says things nobody asked it to. An original post arrives on a
 * SCHEDULED_TRIGGER event with actionType POST, and the card labelled it a
 * reply to @unknown: two wrong statements about one row, on the screen an owner
 * opens to see what their agent has been doing. Measured on ai17z-test, where
 * four POST jobs in a row were listed as replies.
 *
 * The record has carried `actionType` all along, so this was never a question
 * of not knowing.
 */
const source = readFileSync(resolve(__dirname, '../../apps/web/src/components/JobCard.tsx'), 'utf8');

describe('what the activity card says the agent produced', () => {
  it('reads the action type rather than assuming a reply', () => {
    expect(source).toContain('PRODUCED[job.actionType]');
    // The literal it used to render for every row, whatever the row was.
    expect(source).not.toMatch(/text-bone-faint">Reply<\/p>/);
  });

  it('has a word for every action an agent can take', () => {
    /*
      Typed as `Record<ActionType, string>` so a new action type is a failing
      build rather than a row labelled with whatever the lookup fell back to.
      This checks the same thing from the other side: every value in the enum
      appears in the table.
    */
    expect(source).toContain('Record<ActionType, string>');
    for (const action of ACTION_TYPES) {
      expect(source, `${action} has no word on the card`).toContain(`${action}:`);
    }
  });

  it('does not invent a stranger for a post the agent thought of itself', () => {
    // A self-originated post has no author on its event. "@unknown" reads as a
    // person whose handle could not be read, which is a different claim from
    // there being nobody.
    expect(source).toContain("selfStarted ? 'its own idea' : '@unknown'");
    expect(source).toContain("job.actionType === 'POST'");
  });
});
