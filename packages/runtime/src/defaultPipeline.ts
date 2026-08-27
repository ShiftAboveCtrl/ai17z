import type { PipelineDraft } from '@xbam/shared/contracts';

/**
 * The pipeline every new agent starts with.
 *
 * This is the graph the runtime actually walks: the executor reads these nodes
 * and edges from the database and follows them. Editing the graph changes what
 * runs, and what the UI draws is what happened.
 *
 * It branches in two places. The filter can drop an event before any model is
 * called, and the approval gate routes to the action or to a dead end depending
 * on what a person decided.
 */
export function defaultPipelineDraft(triggerLabel = 'Mention received'): PipelineDraft {
  return {
    name: 'Default reply pipeline',
    changeNote: 'created with agent',
    nodes: [
      { key: 'trigger', kind: 'TRIGGER', label: triggerLabel, config: { eventTypes: ['MENTION'] }, x: 0, y: 0 },
      {
        key: 'filter',
        kind: 'FILTER',
        label: 'Worth answering?',
        // Empty means everything passes. The owner narrows it here rather than
        // paying for a model call on events they never wanted.
        config: { minLength: 1, requireText: true, blockedPhrases: [] },
        x: 0,
        y: 1,
      },
      { key: 'skipped', kind: 'END', label: 'Not answered', config: { reason: 'filtered out' }, x: 1, y: 2 },
      { key: 'context', kind: 'RESOLVE_CONTEXT', label: 'Resolve context', config: {}, x: 0, y: 2 },
      // Between context and memory on purpose: what an image says can be worth
      // remembering, and what is remembered can only be chosen once the post is
      // actually understood.
      { key: 'media', kind: 'MEDIA_RESOLVE', label: 'Understand media', config: {}, x: 0, y: 3 },
      // Before memory, because who somebody is changes what is worth recalling.
      { key: 'relationship', kind: 'RELATIONSHIP', label: 'Who is this', config: {}, x: 0, y: 4 },
      // Before generation, so the model is told what it has said before rather
      // than corrected afterwards by a gate it cannot see.
      { key: 'stance', kind: 'STANCE', label: 'What it believes', config: {}, x: 0, y: 5 },
      { key: 'memory', kind: 'RETRIEVE_MEMORY', label: 'Retrieve memory', config: {}, x: 0, y: 6 },
      { key: 'persona', kind: 'ASSEMBLE_PERSONA', label: 'Assemble persona', config: {}, x: 0, y: 7 },
      { key: 'generate', kind: 'GENERATE', label: 'Generate', config: { role: 'primary' }, x: 0, y: 8 },
      { key: 'validate', kind: 'VALIDATE', label: 'Validate', config: {}, x: 0, y: 9 },
      { key: 'consistency', kind: 'STANCE_CHECK', label: 'Still consistent', config: {}, x: 0, y: 10 },
      { key: 'approval', kind: 'APPROVAL_GATE', label: 'Approval gate', config: {}, x: 0, y: 11 },
      { key: 'rejected', kind: 'END', label: 'Rejected', config: { reason: 'rejected by the operator' }, x: 1, y: 12 },
      { key: 'execute', kind: 'EXECUTE_ACTION', label: 'Execute action', config: { actionType: 'REPLY' }, x: 0, y: 12 },
      { key: 'remember', kind: 'MEMORY_WRITE', label: 'Record and remember', config: {}, x: 0, y: 13 },
      { key: 'done', kind: 'END', label: 'Done', config: {}, x: 0, y: 10 },
    ],
    edges: [
      { from: 'trigger', to: 'filter', branch: 'next', condition: null },
      { from: 'filter', to: 'context', branch: 'true', condition: 'passes the filter' },
      { from: 'filter', to: 'skipped', branch: 'false', condition: 'filtered out' },
      { from: 'context', to: 'media', branch: 'next', condition: null },
      { from: 'media', to: 'relationship', branch: 'next', condition: null },
      { from: 'relationship', to: 'stance', branch: 'next', condition: null },
      { from: 'stance', to: 'memory', branch: 'next', condition: null },
      { from: 'memory', to: 'persona', branch: 'next', condition: null },
      { from: 'persona', to: 'generate', branch: 'next', condition: null },
      { from: 'generate', to: 'validate', branch: 'next', condition: null },
      { from: 'validate', to: 'consistency', branch: 'next', condition: null },
      { from: 'consistency', to: 'approval', branch: 'next', condition: null },
      { from: 'approval', to: 'execute', branch: 'approved', condition: 'approved or autonomous' },
      { from: 'approval', to: 'rejected', branch: 'rejected', condition: 'rejected by a person' },
      { from: 'execute', to: 'remember', branch: 'next', condition: null },
      { from: 'remember', to: 'done', branch: 'next', condition: null },
    ],
  };
}
