import { Buffer } from 'node:buffer';

/**
 * A movie container with the three boxes a real one has: `ftyp` (what it is),
 * `moov` (the index) and `mdat` (the samples). There is no codec data inside,
 * and none is needed: the sniffer reads the container, not the frames.
 */
function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

export function movieBytes(options: { brand?: string; moov?: boolean; mdat?: boolean; padding?: number; cutShort?: number } = {}): Buffer {
  const brand = Buffer.from((options.brand ?? 'isom').padEnd(4, ' '), 'latin1');
  const parts = [box('ftyp', Buffer.concat([brand, Buffer.alloc(4), brand]))];
  if (options.moov !== false) parts.push(box('moov', Buffer.alloc(64, 1)));
  if (options.mdat !== false) parts.push(box('mdat', Buffer.alloc(options.padding ?? 256, 2)));
  const whole = Buffer.concat(parts);
  return options.cutShort ? whole.subarray(0, whole.length - options.cutShort) : whole;
}

export function mp4Bytes(padding = 256): Buffer {
  return movieBytes({ brand: 'isom', padding });
}

export function movBytes(): Buffer {
  return movieBytes({ brand: 'qt' });
}

export const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="72"><script>alert(1)</script></svg>');
