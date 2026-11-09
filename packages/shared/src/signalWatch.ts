import { sha256Hex } from './ids';
import type { SignalWatch } from './contracts/radar';

/**
 * The stable identity of one owner pin.
 *
 * One function everywhere, because the runtime keys baselines and candidates by
 * it and the repository has to find a removed pin's rows by the same key. A hash
 * rather than the raw values keeps `watch_key` a compact column, not a payload.
 */
export function signalWatchKey(watch: SignalWatch): string {
  return sha256Hex(`${watch.chain}:${watch.address}:${watch.predicate}:${watch.threshold ?? ''}`);
}
