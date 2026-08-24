import type { PipelineDraft } from '@xbam/shared/contracts';

/**
 * The pipeline the executor implements today, as editable graph data.
 *
 * The graph is currently descriptive rather than interpreted: `pipeline.ts` runs
 * this exact sequence. Storing it as a versioned graph is what makes branching
 * and per-agent variation an extension rather than a rewrite, and it lets the UI
 * show the real shape of the runtime instead of a drawing of it.
 */
export function defaultPipelineDraft(triggerLabel = 'Mention received'): PipelineDraft {
  return {
    name: 'Default reply pipeline',
    changeNote: 'created with agent',
    nodes: [
      { key: 'trigger', kind: 'TRIGGER', label: triggerLabel, config: { eventTypes: ['MENTION'] }, x: 0, y: 0 },
      { key: 'context', kind: 'RESOLVE_CONTEXT', label: 'Resolve context', config: {}, x: 0, y: 1 },
      { key: 'memory', kind: 'RETRIEVE_MEMORY', label: 'Retrieve memory', config: {}, x: 0, y: 2 },
      { key: 'persona', kind: 'ASSEMBLE_PERSONA', label: 'Assemble persona', config: {}, x: 0, y: 3 },
      { key: 'generate', kind: 'GENERATE', label: 'Generate', config: { role: 'primary' }, x: 0, y: 4 },
      { key: 'validate', kind: 'VALIDATE', label: 'Validate', config: {}, x: 0, y: 5 },
      { key: 'approval', kind: 'APPROVAL_GATE', label: 'Approval gate', config: {}, x: 0, y: 6 },
      { key: 'execute', kind: 'EXECUTE_ACTION', label: 'Execute action', config: { actionType: 'REPLY' }, x: 0, y: 7 },
      { key: 'persist', kind: 'PERSIST', label: 'Record and remember', config: {}, x: 0, y: 8 },
    ],
    edges: [
      { from: 'trigger', to: 'context', condition: null },
      { from: 'context', to: 'memory', condition: null },
      { from: 'memory', to: 'persona', condition: null },
      { from: 'persona', to: 'generate', condition: null },
      { from: 'generate', to: 'validate', condition: null },
      { from: 'validate', to: 'approval', condition: null },
      { from: 'approval', to: 'execute', condition: 'approved or autonomous' },
      { from: 'execute', to: 'persist', condition: null },
    ],
  };
}
