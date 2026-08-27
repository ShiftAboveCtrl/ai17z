import { describe, expect, it } from 'vitest';
import { PipelineDraft } from '@xbam/shared/contracts';
import { buildGraph, defaultPipelineDraft, nextNode, validateGraph } from '@xbam/runtime';

const draft = (nodes: unknown[], edges: unknown[]) => PipelineDraft.parse({ name: 't', nodes, edges });
const node = (key: string, kind: string, extra = {}) => ({ key, kind, label: key, config: {}, x: 0, y: 0, ...extra });

/**
 * A pipeline that cannot run is worse than no pipeline: it fails when a real
 * event arrives. Everything catchable is caught before it becomes active.
 */
describe('pipeline validation', () => {
  it('accepts the default pipeline', () => {
    const result = validateGraph(defaultPipelineDraft());
    expect(result.problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.startKey).toBe('trigger');
  });

  it('refuses a graph with no trigger', () => {
    const result = validateGraph(draft([node('a', 'END')], []));
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.message).toMatch(/no trigger/i);
  });

  it('refuses more than one trigger', () => {
    const result = validateGraph(
      draft([node('a', 'TRIGGER'), node('b', 'TRIGGER'), node('c', 'END')], [
        { from: 'a', to: 'c', branch: 'next' },
        { from: 'b', to: 'c', branch: 'next' },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /2 triggers/.test(p.message))).toBe(true);
  });

  it('refuses an edge pointing at a node that does not exist', () => {
    const result = validateGraph(draft([node('a', 'TRIGGER')], [{ from: 'a', to: 'ghost', branch: 'next' }]));
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /unknown node "ghost"/.test(p.message))).toBe(true);
  });

  it('refuses a node with nowhere to go', () => {
    const result = validateGraph(draft([node('a', 'TRIGGER'), node('b', 'VALIDATE'), node('c', 'END')], [
      { from: 'a', to: 'b', branch: 'next' },
    ]));
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.node === 'b' && /no outgoing edge/.test(p.message))).toBe(true);
  });

  it('requires a branching node to cover every outcome', () => {
    const result = validateGraph(
      draft([node('a', 'TRIGGER'), node('f', 'FILTER'), node('e', 'END')], [
        { from: 'a', to: 'f', branch: 'next' },
        { from: 'f', to: 'e', branch: 'true' },
        // No false branch: a filtered-out event would have nowhere to go.
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.node === 'f' && /"false" branch/.test(p.message))).toBe(true);
  });

  it('refuses two edges on the same branch', () => {
    const result = validateGraph(
      draft([node('a', 'TRIGGER'), node('b', 'END'), node('c', 'END')], [
        { from: 'a', to: 'b', branch: 'next' },
        { from: 'a', to: 'c', branch: 'next' },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /two edges on the "next" branch/.test(p.message))).toBe(true);
  });

  it('refuses a cycle, which would run forever', () => {
    const result = validateGraph(
      draft([node('a', 'TRIGGER'), node('b', 'VALIDATE'), node('c', 'VALIDATE')], [
        { from: 'a', to: 'b', branch: 'next' },
        { from: 'b', to: 'c', branch: 'next' },
        { from: 'c', to: 'b', branch: 'next' },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /loops forever/.test(p.message))).toBe(true);
  });

  it('warns about a node the trigger cannot reach', () => {
    const result = validateGraph(
      draft([node('a', 'TRIGGER'), node('b', 'END'), node('orphan', 'END')], [{ from: 'a', to: 'b', branch: 'next' }]),
    );
    expect(result.ok).toBe(true);
    expect(result.problems.some((p) => p.node === 'orphan' && p.severity === 'warning')).toBe(true);
  });
});

describe('graph traversal', () => {
  it('follows the branch it is given', () => {
    const d = defaultPipelineDraft();
    const graph = buildGraph(d.nodes, d.edges)!;
    expect(graph.startKey).toBe('trigger');
    expect(nextNode(graph, 'filter', 'true')?.key).toBe('context');
    expect(nextNode(graph, 'filter', 'false')?.key).toBe('skipped');
    expect(nextNode(graph, 'approval', 'approved')?.key).toBe('execute');
    expect(nextNode(graph, 'approval', 'rejected')?.key).toBe('rejected');
  });

  it('returns nothing for a branch that does not exist', () => {
    const d = defaultPipelineDraft();
    const graph = buildGraph(d.nodes, d.edges)!;
    expect(nextNode(graph, 'done', 'next')).toBeNull();
    expect(nextNode(graph, 'context', 'true')).toBeNull();
  });
});
