import type { PromptLayerKey } from '@xbam/shared/contracts';
import { NotFoundError } from '@xbam/shared';
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export interface PromptLayerTemplate {
  key: PromptLayerKey;
  title: string;
  role: 'system' | 'user';
  /** Mustache-style {{variable}} template rendered by @xbam/prompts. */
  template: string;
}

export interface PromptTemplateVersionRow {
  id: string;
  templateId: string;
  templateKey: string;
  version: number;
  layers: PromptLayerTemplate[];
  isActive: boolean;
  changeNote: string;
  createdAt: string;
}

/** Stable serialisation: sorted keys, so field order cannot fake a change. */
function canonical(layers: PromptLayerTemplate[]): string {
  return JSON.stringify(
    layers.map((layer) => ({
      key: layer.key,
      role: layer.role,
      template: layer.template,
      title: layer.title,
    })),
  );
}

export async function upsertTemplate(input: {
  key: string;
  name: string;
  description: string;
  layers: PromptLayerTemplate[];
}): Promise<PromptTemplateVersionRow> {
  const template = await queryOne<{ id: string }>(
    `INSERT INTO prompt_templates (key, name, description) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description
     RETURNING id`,
    [input.key, input.name, input.description],
  );
  const templateId = template!.id;
  const existingActive = await queryOne<{ id: string; layers: PromptLayerTemplate[] }>(
    'SELECT id, layers FROM prompt_template_versions WHERE template_id = $1 AND is_active',
    [templateId],
  );
  // Only cut a new version when the layer definition actually changed.
  // Postgres does not preserve key order in jsonb, so the comparison has to be
  // canonical; a naive stringify re-versions the template on every boot.
  if (existingActive && canonical(existingActive.layers) === canonical(input.layers)) {
    return (await getTemplateVersion(existingActive.id)) as PromptTemplateVersionRow;
  }
  const next = await queryOne<{ next: number }>(
    'SELECT coalesce(max(version), 0) + 1 AS next FROM prompt_template_versions WHERE template_id = $1',
    [templateId],
  );
  await query('UPDATE prompt_template_versions SET is_active = false WHERE template_id = $1', [templateId]);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO prompt_template_versions (template_id, version, layers, is_active, change_note)
     VALUES ($1,$2,$3::jsonb,true,$4) RETURNING id`,
    [templateId, next?.next ?? 1, JSON.stringify(input.layers), 'seeded from code defaults'],
  );
  return (await getTemplateVersion(row!.id)) as PromptTemplateVersionRow;
}

export async function getTemplateVersion(id: string): Promise<PromptTemplateVersionRow | null> {
  const row = await queryOne(
    `SELECT ptv.*, pt.key AS template_key FROM prompt_template_versions ptv
       JOIN prompt_templates pt ON pt.id = ptv.template_id WHERE ptv.id = $1`,
    [id],
  );
  return mapRow<PromptTemplateVersionRow>(row);
}

export async function getActiveTemplate(key: string): Promise<PromptTemplateVersionRow> {
  const row = await queryOne(
    `SELECT ptv.*, pt.key AS template_key FROM prompt_template_versions ptv
       JOIN prompt_templates pt ON pt.id = ptv.template_id
      WHERE pt.key = $1 AND ptv.is_active`,
    [key],
  );
  const found = mapRow<PromptTemplateVersionRow>(row);
  if (!found) throw new NotFoundError(`Prompt template "${key}"`);
  return found;
}

export async function listTemplates(): Promise<PromptTemplateVersionRow[]> {
  return mapRows<PromptTemplateVersionRow>(
    await query(
      `SELECT ptv.*, pt.key AS template_key FROM prompt_template_versions ptv
         JOIN prompt_templates pt ON pt.id = ptv.template_id
        ORDER BY pt.key, ptv.version DESC`,
    ),
  );
}
