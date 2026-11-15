/**
 * Bonding curve accounts as bytes.
 *
 * `LIVE_CURVE_BASE64` is a real Pump curve account read from mainnet
 * (`getAccountInfo`, base64, finalized, slot 469824739): 166 bytes, owned by the
 * Pump program, discriminator 17b7f83760d8ac60, not complete, real token
 * reserves 320839194420897, real SOL reserves 23583985641 lamports. Its own
 * address, `D9srkk6pQtESRF8bKDC7PHFSkjTetSzyNDwUKXjXUJ76`, is what
 * DexScreener lists as the pair of mint `C99s3MpBkjHmyLdCgMxBcG9jAPDWPDENCiNswMU1pump`.
 *
 * The other helpers build accounts to the layout in Pump's published IDL so a
 * case can say only what it cares about.
 */
export const LIVE_CURVE_BASE64 =
  'F7f4N2DYrGChPkl+XiICAOm72nkMAAAAoaY2Ms0jAQDpD7d9BQAAAACAxqR+jQMAALJxhGxUmPRW1xjfrZtbmv6kved0QyNyFp18gQTGlLE4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC5T4IBAAAAAN6oYwIAAAAAAACsI/wGAAAAAAAAAAAAAAAAAAAAAAAAAA==';
export const LIVE_CURVE_MINT = 'C99s3MpBkjHmyLdCgMxBcG9jAPDWPDENCiNswMU1pump';
export const LIVE_CURVE_ADDRESS = 'D9srkk6pQtESRF8bKDC7PHFSkjTetSzyNDwUKXjXUJ76';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** A mint and the curve and pool addresses DexScreener lists for it, used to prove the derivations. */
export const KNOWN_CURVE = { mint: '5e3UxCBJqiTd9HtRgUUKAgTFv4j9zag5fJDvQQjKpump', curve: 'Dog6tK6FqURfEdCJRN9fv4EitJxR2g62YuKd2uJ278Fi' };
export const KNOWN_POOL = { mint: '4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump', pool: 'Ho1aSG6WGH1FfXdEHrK2f4Ggt1Hoxo9s5jcLMDqeyeBz' };

const DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];

export function curveBytes(fields: {
  virtualToken?: bigint; virtualQuote?: bigint; realToken?: bigint; realQuote?: bigint; supply?: bigint;
  complete?: number; length?: number; discriminator?: number[];
} = {}): Uint8Array {
  const bytes = new Uint8Array(fields.length ?? 166);
  const view = new DataView(bytes.buffer);
  bytes.set(fields.discriminator ?? DISCRIMINATOR, 0);
  view.setBigUint64(8, fields.virtualToken ?? 1_000_000_000_000_000n, true);
  view.setBigUint64(16, fields.virtualQuote ?? 40_000_000_000n, true);
  view.setBigUint64(24, fields.realToken ?? 500_000_000_000_000n, true);
  view.setBigUint64(32, fields.realQuote ?? 10_000_000_000n, true);
  view.setBigUint64(40, fields.supply ?? 1_000_000_000_000_000n, true);
  bytes[48] = fields.complete ?? 0;
  return bytes;
}

export const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
