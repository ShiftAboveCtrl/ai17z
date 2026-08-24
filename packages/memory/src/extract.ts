import type { MemoryType } from '@xbam/shared/contracts';

export interface ExtractedFact {
  content: string;
  memoryType: MemoryType;
  importance: number;
  confidence: number;
  /** Which rule fired, kept so the memory list can explain where a fact came from. */
  rule: string;
}

interface Rule {
  name: string;
  pattern: RegExp;
  memoryType: MemoryType;
  importance: number;
  confidence: number;
}

/**
 * Deterministic extraction of durable facts from an inbound message.
 *
 * This is intentionally conservative: not every sentence deserves to be
 * remembered forever, and a heuristic that fires too often poisons future
 * prompts. A model-based extractor can be selected per agent when higher recall
 * matters more than precision.
 */
const RULES: Rule[] = [
  {
    name: 'explicit-remember-request',
    pattern: /\b(?:remember|don't forget|dont forget|keep in mind|note) (?:that )?(.{4,220})/i,
    memoryType: 'FACT',
    importance: 0.9,
    confidence: 0.9,
  },
  {
    name: 'stated-favourite',
    pattern: /\b(my favou?rite [a-z ]{2,40} (?:is|are) .{1,120})/i,
    memoryType: 'PREFERENCE',
    importance: 0.8,
    confidence: 0.85,
  },
  {
    name: 'stated-preference',
    pattern: /\b(i (?:prefer|like|love|hate|dislike|always|never) .{3,160})/i,
    memoryType: 'PREFERENCE',
    importance: 0.65,
    confidence: 0.7,
  },
  {
    name: 'self-description',
    pattern: /\b(i(?:'m| am) (?:a |an |the )?[a-z0-9][^.!?\n]{3,140})/i,
    memoryType: 'FACT',
    importance: 0.6,
    confidence: 0.65,
  },
  {
    name: 'stated-name',
    pattern: /\b(my name is [^.!?\n]{2,60})/i,
    memoryType: 'FACT',
    importance: 0.85,
    confidence: 0.9,
  },
  {
    name: 'stated-location',
    pattern: /\b(i(?:'m| am) (?:based |located )?(?:in|from) [A-Z][^.!?\n]{2,60})/,
    memoryType: 'FACT',
    importance: 0.7,
    confidence: 0.7,
  },
];

/** Phrases that look like facts but are questions or hypotheticals. */
const NEGATIVE = /\?\s*$|^\s*(?:what|who|when|where|why|how|do|does|did|is|are|can|could|would|should)\b/i;

export function extractUserFacts(text: string, minImportance: number): ExtractedFact[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 8) return [];

  const found: ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(clean)) {
    if (NEGATIVE.test(sentence)) continue;
    for (const rule of RULES) {
      const match = sentence.match(rule.pattern);
      const captured = match?.[1]?.trim();
      if (!captured) continue;
      const content = tidyFact(captured);
      const key = content.toLowerCase();
      if (!content || seen.has(key)) continue;
      if (rule.importance < minImportance) continue;
      seen.add(key);
      found.push({
        content,
        memoryType: rule.memoryType,
        importance: rule.importance,
        confidence: rule.confidence,
        rule: rule.name,
      });
      // One fact per sentence: the first matching rule is the most specific.
      break;
    }
  }
  return found.slice(0, 5);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

function tidyFact(text: string): string {
  return text
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[,;:]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
