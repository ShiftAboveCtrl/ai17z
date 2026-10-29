import { z } from 'zod';

/**
 * What a capability's argument looks like, in one line the model can copy.
 *
 * Not JSON Schema. A model given a full JSON Schema for `{ handle: string }`
 * spends attention on `additionalProperties` and `$schema` and still sometimes
 * writes the wrong thing; a model shown `{"handle": string}` writes that. The
 * real schema is still what validates, so being approximate here costs nothing
 * -- a wrong guess is refused with the exact field that was wrong.
 *
 * Classes rather than the internal definition: zod 3 named each kind in
 * `_def.typeName` and zod 4 dropped it, which left this describing every
 * argument as `value` while compiling cleanly.
 */
export function zodToDescription(schema: z.ZodType, depth = 0): string {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return `${zodToDescription(schema.unwrap() as z.ZodType, depth)}?`;
  }
  if (schema instanceof z.ZodDefault) {
    return `${zodToDescription(schema.unwrap() as z.ZodType, depth)}?`;
  }
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodEnum) {
    return schema.options.map((v) => JSON.stringify(v)).join(' | ');
  }
  if (schema instanceof z.ZodLiteral) {
    return [...schema.values].map((v) => JSON.stringify(v)).join(' | ');
  }
  if (schema instanceof z.ZodArray) {
    return `${zodToDescription(schema.element as z.ZodType, depth + 1)}[]`;
  }
  if (schema instanceof z.ZodObject) {
    // Two levels is the useful depth. Below that the description is longer than
    // the thing it describes, and a capability whose argument nests three deep
    // is a capability that should take two arguments.
    if (depth >= 2) return 'object';
    const fields = Object.entries(schema.shape as Record<string, z.ZodType>).map(
      ([key, value]) => `"${key}": ${zodToDescription(value, depth + 1)}`,
    );
    return `{${fields.join(', ')}}`;
  }
  if (schema instanceof z.ZodUnion) {
    return (schema.options as readonly z.ZodType[]).map((o) => zodToDescription(o, depth)).join(' | ');
  }
  return 'value';
}
