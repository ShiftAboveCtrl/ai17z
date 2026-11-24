/**
 * Split at paragraphs, then sentences, then words without changing inner whitespace.
 * Each part is at most `limit` code points: 280 unless the project allows more.
 */
export function splitDevUpdate(text, limit = 280) {
  const parts = [];
  let rest = text.trim();
  if (rest.split(/\s+/u).some((word) => [...word].length > limit)) {
    throw new Error(`A word exceeds ${limit} code points. Supply explicit parts.`);
  }
  while ([...rest].length > limit) {
    const window = [...rest].slice(0, limit + 1).join('');
    let boundary = 0;
    for (const pattern of [/\n\s*\n/gu, /[.!?]["')]*\s+/gu, /\s+/gu]) {
      const matches = [...window.matchAll(pattern)];
      const last = matches.at(-1);
      if (last) {
        boundary = last.index + (pattern.source.startsWith('[.!?]') ? last[0].trimEnd().length : 0);
        if (boundary > 0 && [...rest.slice(0, boundary)].length <= limit) break;
        boundary = 0;
      }
    }
    if (!boundary) throw new Error(`A word exceeds ${limit} code points. Supply explicit parts.`);
    parts.push(rest.slice(0, boundary).trimEnd());
    rest = rest.slice(boundary).trimStart();
  }
  if (rest) parts.push(rest);
  if (!parts.length || parts.length > 6) throw new Error('An update needs one to six parts.');
  return parts;
}
