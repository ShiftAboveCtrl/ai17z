import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The three words `model_calls.status` may hold, checked against everything
 * that compares against it.
 *
 * `npm run latency` shipped asking for `status <> 'SUCCEEDED'`. There is no such
 * status: the column takes STARTED, COMPLETED or FAILED, and a CHECK constraint
 * says so. So the filter was true of every row and the tool reported every
 * model call on a live installation as one that did not succeed, while two
 * thirds of them had. Nothing failed, nothing was logged, and the number looked
 * exactly like a real one.
 *
 * 'SUCCEEDED' is a real word in this codebase, which is why it was reached for:
 * `INVOCATION_OUTCOMES` uses it for capability invocations. Two vocabularies
 * one word apart, on two tables, is a mistake that will be made again.
 *
 * So this reads the SQL rather than trusting it. A measurement tool that is
 * confidently wrong is worse than none, because somebody acts on it.
 */

/** Exactly what `migrations/0006_actions.sql` puts behind the column. */
const MODEL_CALL_STATUSES = ['STARTED', 'COMPLETED', 'FAILED'];

function sourcesUnder(dir: string, extensions: string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      found.push(...sourcesUnder(path, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

// `fileURLToPath` rather than `.pathname`: on Windows the latter is
// "/C:/...", and this repository has already paid for a test that read as a
// literal platform path and failed only on Linux CI.
const root = fileURLToPath(new URL('../..', import.meta.url));

describe('model_calls.status', () => {
  it('is still the three words the migration allows', () => {
    const migration = readFileSync(join(root, 'migrations/0006_actions.sql'), 'utf8');
    const declared = /status\s+text NOT NULL DEFAULT 'STARTED' CHECK \(status IN \(([^)]+)\)\)/.exec(migration);
    expect(declared, 'the model_calls status constraint has moved or been rewritten').toBeTruthy();
    const words = [...declared![1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(words.sort()).toEqual([...MODEL_CALL_STATUSES].sort());
  });

  it('is never compared against a word it cannot hold', () => {
    /*
      Per template literal rather than per file, because several files hold a
      query about `model_calls` beside one about `actions`, whose status really
      is EXECUTED. Every query in this codebase is a backtick literal, so
      splitting on backticks is what separates one statement from the next.
    */
    const files = [
      ...sourcesUnder(join(root, 'tools'), ['.mts', '.ts']),
      ...sourcesUnder(join(root, 'packages'), ['.ts']),
      ...sourcesUnder(join(root, 'apps'), ['.ts']),
    ];

    const wrong: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('model_calls')) continue;
      for (const statement of text.split('`')) {
        if (!statement.includes('model_calls')) continue;
        /*
          Which alias the comparison has to carry, because one statement here
          reads `model_calls m` beside `actions ac`, and `actions.status` really
          is EXECUTED. An unaliased table means an unaliased column.

          The keyword list is the whole difficulty. Without it the word after
          the table name is taken as an alias whatever it is, so `FROM
          model_calls WHERE ...` yields an alias of "WHERE", nothing in the
          statement is then prefixed with it, and the check passes by looking
          at nothing. Which is the failure mode this repository keeps naming: a
          check that cannot run reads exactly like one with nothing to say.
        */
        const alias =
          /\bmodel_calls\s+(?:AS\s+)?(?!WHERE\b|ON\b|JOIN\b|LEFT\b|RIGHT\b|INNER\b|FULL\b|CROSS\b|GROUP\b|ORDER\b|LIMIT\b|OFFSET\b|HAVING\b|WINDOW\b|UNION\b|RETURNING\b|SET\b|USING\b|FETCH\b)([a-z]\w*)/i.exec(
            statement,
          )?.[1] ?? null;
        const comparison = alias
          ? new RegExp(String.raw`\b${alias}\.status\s*(?:=|<>|!=)\s*'([A-Za-z_]+)'`, 'g')
          : /(?<![\w.])status\s*(?:=|<>|!=)\s*'([A-Za-z_]+)'/g;
        for (const match of statement.matchAll(comparison)) {
          const word = match[1]!;
          if (!MODEL_CALL_STATUSES.includes(word)) {
            wrong.push(`${file.slice(root.length)}: status compared against '${word}'`);
          }
        }
      }
    }

    expect(wrong, `model_calls.status can only ever be ${MODEL_CALL_STATUSES.join(', ')}:\n  ${wrong.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('would have caught the defect it was written for, and not the one beside it', () => {
    // The guard is only worth having if it fails on the query that shipped, and
    // only usable if it stays quiet about the `actions` subquery sitting in the
    // same statement, whose status really is EXECUTED.
    const bare = /(?<![\w.])status\s*(?:=|<>|!=)\s*'([A-Za-z_]+)'/g;
    const shipped = "FROM model_calls WHERE latency_ms > 0 AND status <> 'SUCCEEDED'";
    expect([...shipped.matchAll(bare)].map((m) => m[1]!)).toEqual(['SUCCEEDED']);

    const beside = "FROM model_calls m WHERE m.status = 'COMPLETED' ... FROM actions ac WHERE ac.status = 'EXECUTED'";
    const aliased = /\bm\.status\s*(?:=|<>|!=)\s*'([A-Za-z_]+)'/g;
    expect([...beside.matchAll(aliased)].map((m) => m[1]!)).toEqual(['COMPLETED']);
  });
});
