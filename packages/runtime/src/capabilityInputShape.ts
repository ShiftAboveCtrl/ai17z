import type { z } from 'zod';

/**
 * What a capability's argument looks like, in one line the model can copy.
 *
 * Not JSON Schema. A model given a full JSON Schema for `{ handle: string }`
 * spends attention on `additionalProperties` and `$schema` and still sometimes
 * writes the wrong thing; a model shown `{"handle": string}` writes that. The
 * real schema is still what validates, so being approximate here costs nothing
 * -- a wrong guess is refused with the exact field that was wrong.
 */
export function zodToDescription(schema: z.ZodTypeAny, depth = 0): string {
  const def = schema._def as { typeName?: string } | undefined;
  const name = def?.typeName;

  if (name === 'ZodOptional' || name === 'ZodNullable') {
    return `${zodToDescription((schema as z.ZodOptional<z.ZodTypeAny>).unwrap(), depth)}?`;
  }
  if (name === 'ZodDefault') {
    const inner = (schema as z.ZodDefault<z.ZodTypeAny>)._def.innerType;
    return `${zodToDescription(inner, depth)}?`;
  }
  if (name === 'ZodString') return 'string';
  if (name === 'ZodNumber') return 'number';
  if (name === 'ZodBoolean') return 'boolean';
  if (name === 'ZodEnum') {
    const values = (schema as z.ZodEnum<[string, ...string[]]>)._def.values;
    return values.map((v) => JSON.stringify(v)).join(' | ');
  }
  if (name === 'ZodLiteral') return JSON.stringify((schema as z.ZodLiteral<unknown>)._def.value);
  if (name === 'ZodArray') {
    return `${zodToDescription((schema as z.ZodArray<z.ZodTypeAny>)._def.type, depth + 1)}[]`;
  }
  if (name === 'ZodObject') {
    // Two levels is the useful depth. Below that the description is longer than
    // the thing it describes, and a capability whose argument nests three deep
    // is a capability that should take two arguments.
    if (depth >= 2) return 'object';
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const fields = Object.entries(shape).map(
      ([key, value]) => `"${key}": ${zodToDescription(value as z.ZodTypeAny, depth + 1)}`,
    );
    return `{${fields.join(', ')}}`;
  }
  if (name === 'ZodUnion') {
    const options = (schema as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>)._def.options;
    return options.map((o: z.ZodTypeAny) => zodToDescription(o, depth)).join(' | ');
  }
  return 'value';
}
