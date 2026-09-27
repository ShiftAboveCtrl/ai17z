/** Deterministic prefix selection in the exact order supplied by the server. */
export function boundedSelection(jobIds: string[], amount: number, maximum = 500): string[] {
  const bounded = Math.max(0, Math.min(maximum, Math.floor(amount), jobIds.length));
  return jobIds.slice(0, bounded);
}
