/** Split at paragraphs, then sentences, then words without changing inner whitespace. */
export function splitDevUpdate(text) {
  const parts = [];
  let rest = text.trim();
  if (rest.split(/\s+/u).some((word) => [...word].length > 280)) {
    throw new Error('A word exceeds 280 code points. Supply explicit parts.');
  }
  while ([...rest].length > 280) {
    const window = [...rest].slice(0, 281).join('');
    let boundary = 0;
    for (const pattern of [/\n\s*\n/gu, /[.!?]["')]*\s+/gu, /\s+/gu]) {
      const matches = [...window.matchAll(pattern)];
      const last = matches.at(-1);
      if (last) {
        boundary = last.index + (pattern.source.startsWith('[.!?]') ? last[0].trimEnd().length : 0);
        if (boundary > 0 && [...rest.slice(0, boundary)].length <= 280) break;
        boundary = 0;
      }
    }
    if (!boundary) throw new Error('A word exceeds 280 code points. Supply explicit parts.');
    parts.push(rest.slice(0, boundary).trimEnd());
    rest = rest.slice(boundary).trimStart();
  }
  if (rest) parts.push(rest);
  if (!parts.length || parts.length > 6) throw new Error('An update needs one to six parts.');
  return parts;
}
