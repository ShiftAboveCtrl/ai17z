import type { PipelineDraft, PipelineEdge, PipelineNode } from '@xbam/shared/contracts';
import type { PipelineVersionRecord } from '@xbam/database';

export interface GraphProblem {
  severity: 'error' | 'warning';
  node: string | null;
  message: string;
}

export interface GraphValidation {
  ok: boolean;
  problems: GraphProblem[];
  startKey: string | null;
}

/** Node kinds that end a run. Reaching one settles the job. */
export const TERMINAL_KINDS = new Set(['END']);

/** Node kinds that choose between outgoing branches rather than falling through. */
export const BRANCHING_KINDS: Record<string, readonly string[]> = {
  FILTER: ['true', 'false'],
  CONDITION: ['true', 'false'],
  APPROVAL_GATE: ['approved', 'rejected'],
};

export interface Graph {
  nodes: Map<string, PipelineNode>;
  /** from key -> branch -> to key */
  edges: Map<string, Map<string, string>>;
  startKey: string;
}

export function buildGraph(nodes: PipelineNode[], edges: PipelineEdge[]): Graph | null {
  const nodeMap = new Map(nodes.map((n) => [n.key, n]));
  const edgeMap = new Map<string, Map<string, string>>();
  for (const edge of edges) {
    const branches = edgeMap.get(edge.from) ?? new Map<string, string>();
    branches.set(edge.branch ?? 'next', edge.to);
    edgeMap.set(edge.from, branches);
  }
  const start = nodes.find((n) => n.kind === 'TRIGGER');
  if (!start) return null;
  return { nodes: nodeMap, edges: edgeMap, startKey: start.key };
}

/**
 * Checks a graph before it is allowed to become the active version.
 *
 * A pipeline that cannot run is worse than no pipeline: it fails at the moment a
 * real event arrives. Everything catchable is caught here instead.
 */
export function validateGraph(draft: Pick<PipelineDraft, 'nodes' | 'edges'>): GraphValidation {
  const problems: GraphProblem[] = [];
  const keys = new Set<string>();

  for (const node of draft.nodes) {
    if (keys.has(node.key)) {
      problems.push({ severity: 'error', node: node.key, message: `Duplicate node key "${node.key}".` });
    }
    keys.add(node.key);
  }

  const triggers = draft.nodes.filter((n) => n.kind === 'TRIGGER');
  if (triggers.length === 0) {
    problems.push({ severity: 'error', node: null, message: 'The pipeline has no trigger, so nothing can start it.' });
  } else if (triggers.length > 1) {
    problems.push({
      severity: 'error',
      node: null,
      message: `The pipeline has ${triggers.length} triggers. Exactly one is the entry point.`,
    });
  }

  for (const edge of draft.edges) {
    if (!keys.has(edge.from)) {
      problems.push({ severity: 'error', node: edge.from, message: `Edge starts at unknown node "${edge.from}".` });
    }
    if (!keys.has(edge.to)) {
      problems.push({ severity: 'error', node: edge.to, message: `Edge ends at unknown node "${edge.to}".` });
    }
  }

  const outgoing = new Map<string, Set<string>>();
  for (const edge of draft.edges) {
    const set = outgoing.get(edge.from) ?? new Set<string>();
    if (set.has(edge.branch ?? 'next')) {
      problems.push({
        severity: 'error',
        node: edge.from,
        message: `Node "${edge.from}" has two edges on the "${edge.branch ?? 'next'}" branch.`,
      });
    }
    set.add(edge.branch ?? 'next');
    outgoing.set(edge.from, set);
  }

  // Every node must know where to go, and branching nodes must cover every outcome.
  for (const node of draft.nodes) {
    if (TERMINAL_KINDS.has(node.kind)) continue;
    const branches = outgoing.get(node.key) ?? new Set<string>();
    const required = BRANCHING_KINDS[node.kind];
    if (required) {
      for (const branch of required) {
        if (!branches.has(branch)) {
          problems.push({
            severity: 'error',
            node: node.key,
            message: `"${node.label || node.key}" has no "${branch}" branch, so that outcome has nowhere to go.`,
          });
        }
      }
    } else if (!branches.has('next')) {
      problems.push({
        severity: 'error',
        node: node.key,
        message: `"${node.label || node.key}" has no outgoing edge and is not an end node.`,
      });
    }
  }

  const startKey = triggers[0]?.key ?? null;

  // Reachability, and any cycle that would loop the runtime forever.
  if (startKey) {
    const reachable = new Set<string>();
    const stack = [startKey];
    while (stack.length > 0) {
      const key = stack.pop()!;
      if (reachable.has(key)) continue;
      reachable.add(key);
      for (const to of outgoingTargets(draft.edges, key)) stack.push(to);
    }
    for (const node of draft.nodes) {
      if (!reachable.has(node.key)) {
        problems.push({
          severity: 'warning',
          node: node.key,
          message: `"${node.label || node.key}" cannot be reached from the trigger.`,
        });
      }
    }
    const cycle = findCycle(draft.edges, startKey);
    if (cycle) {
      problems.push({
        severity: 'error',
        node: cycle[0] ?? null,
        message: `The pipeline loops forever: ${cycle.join(' -> ')}. A DELAY node does not break a cycle.`,
      });
    }
    if (!draft.nodes.some((n) => TERMINAL_KINDS.has(n.kind) && reachable.has(n.key))) {
      problems.push({ severity: 'warning', node: null, message: 'No end node is reachable from the trigger.' });
    }
  }

  return { ok: !problems.some((p) => p.severity === 'error'), problems, startKey };
}

function outgoingTargets(edges: PipelineEdge[], from: string): string[] {
  return edges.filter((e) => e.from === from).map((e) => e.to);
}

/** Returns the first cycle found, as a node path, or null. */
function findCycle(edges: PipelineEdge[], start: string): string[] | null {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];

  const walk = (key: string): string[] | null => {
    if (visiting.has(key)) return [...path.slice(path.indexOf(key)), key];
    if (done.has(key)) return null;
    visiting.add(key);
    path.push(key);
    for (const to of outgoingTargets(edges, key)) {
      const found = walk(to);
      if (found) return found;
    }
    path.pop();
    visiting.delete(key);
    done.add(key);
    return null;
  };
  return walk(start);
}

export function graphFromRecord(record: PipelineVersionRecord): Graph | null {
  return buildGraph(record.nodes, record.edges);
}

/** The node a given branch leads to, or null when that outcome is a dead end. */
export function nextNode(graph: Graph, fromKey: string, branch = 'next'): PipelineNode | null {
  const to = graph.edges.get(fromKey)?.get(branch);
  return to ? (graph.nodes.get(to) ?? null) : null;
}
