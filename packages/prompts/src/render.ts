export type TemplateValues = Record<string, string | number | boolean | null | undefined>;

/**
 * Deliberately tiny template language. Enough to express the prompt layers as
 * editable data, small enough that its behaviour is obvious:
 *
 *   {{name}}            substitute (missing or null renders as empty)
 *   {{#name}}...{{/name}}   include block when the value is non-empty
 *   {{^name}}...{{/name}}   include block when the value is empty
 *
 * No loops, no partials, no arbitrary expressions: prompt templates are content,
 * not code, and a template must never be able to do something surprising.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  const isEmpty = (key: string): boolean => {
    const value = values[key];
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    if (typeof value === 'boolean') return !value;
    if (typeof value === 'number') return false;
    return false;
  };

  const withSections = template.replace(
    /\{\{([#^])([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
    (_match, kind: string, key: string, body: string) => {
      const empty = isEmpty(key);
      const include = kind === '#' ? !empty : empty;
      return include ? body : '';
    },
  );

  return withSections.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Collapses the blank lines that dropped sections leave behind. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function bulletList(items: readonly string[], bullet = '- '): string {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `${bullet}${item}`)
    .join('\n');
}

export function numberedList(items: readonly string[]): string {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => `${index + 1}. ${item}`)
    .join('\n');
}
