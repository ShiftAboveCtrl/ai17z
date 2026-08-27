import type { PersonaSourceAdapter } from './contract';
import { manualSource } from './manual';
import { xPublicSource } from './xPublic';

const ADAPTERS: Record<string, PersonaSourceAdapter> = {
  manual: manualSource,
  x_public: xPublicSource,
};

export function getPersonaSourceAdapter(kind: string): PersonaSourceAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`Unknown persona source kind "${kind}".`);
  return adapter;
}

export function listPersonaSourceAdapters(): PersonaSourceAdapter[] {
  return Object.values(ADAPTERS);
}

export * from './contract';
export { manualSource, itemsFromText } from './manual';
export { xPublicSource } from './xPublic';
