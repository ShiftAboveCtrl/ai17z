import { Message, MessageType, ReactionType, validations } from '@farcaster/core';
import { vi } from 'vitest';

export const CAST_HASH = `0x${'ab'.repeat(20)}`;
export const OWN_HASH = `0x${'cd'.repeat(20)}`;
export const CAST_REF = `farcaster:22:${CAST_HASH}`;
export const TEST_SIGNER = '01'.repeat(32);
export function castMessage(hash = CAST_HASH, fid = 22, text = 'A question about crypto infrastructure?', parent?: { fid: number; hash: string }) {
  return { hash, data: { type: 'MESSAGE_TYPE_CAST_ADD', fid,
    timestamp: Math.floor((Date.now() - Date.UTC(2021, 0, 1)) / 1000), network: 'FARCASTER_NETWORK_MAINNET',
    castAddBody: { text, mentions: [11], mentionsPositions: [0], embeds: [], embedsDeprecated: [],
      ...(parent ? { parentCastId: parent } : {}),
    } } };
}
const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString('hex')}`;

/** Only the HTTP boundary is replaced. Signing, repositories and runtime are real. */
export function fakeFarcaster() {
  const casts = new Map<string, ReturnType<typeof castMessage>>([
    [CAST_HASH, castMessage()], [OWN_HASH, castMessage(OWN_HASH, 11, 'Our original cast')],
  ]);
  const reactions = new Map<string, unknown>();
  const submitted: Message[] = [];
  const reads: URL[] = [];
  let loseResponse = false;
  let delayReadback = false;
  let refusedEndpoint: string | null = null;
  let customPage: ((url: URL) => unknown) | null = null;
  let waitForValidation: Promise<void> | null = null;
  let validationEntered: (() => void) | null = null;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.origin !== 'https://hub.example.test') throw new Error('The test refused an unexpected host.');
    const endpoint = url.pathname.split('/').at(-1)!;
    if (endpoint === refusedEndpoint) return new Response('do not disclose', { status: 429, headers: { 'Retry-After': '61' } });
    if (endpoint === 'validateMessage' || endpoint === 'submitMessage') {
      expectOctetStream(init);
      const message = Message.decode(Buffer.from(init!.body as Uint8Array));
      const valid = await validations.validateMessage(message);
      if (valid.isErr()) throw new Error(`Invalid signed test message: ${valid.error.message}`);
      if (endpoint === 'validateMessage') {
        validationEntered?.();
        await waitForValidation;
        return Response.json({ valid: true });
      }
      submitted.push(message);
      const hash = hex(message.hash);
      if (message.data?.type === MessageType.CAST_ADD) {
        const body = message.data.castAddBody!;
        casts.set(hash, castMessage(hash, message.data.fid, body.text,
          body.parentCastId ? { fid: body.parentCastId.fid, hash: hex(body.parentCastId.hash) } : undefined));
      } else {
        const body = message.data!.reactionBody!;
        const target = body.targetCastId!;
        reactions.set(`${message.data!.fid}:${body.type}:${target.fid}:${hex(target.hash)}`, {
          hash, data: { fid: message.data!.fid, type: 'MESSAGE_TYPE_REACTION_ADD',
            network: 'FARCASTER_NETWORK_MAINNET', reactionBody: { type: body.type === ReactionType.LIKE ? 'REACTION_TYPE_LIKE' : 'REACTION_TYPE_RECAST',
              targetCastId: { fid: target.fid, hash: hex(target.hash) } } },
        });
      }
      if (loseResponse) { loseResponse = false; throw new Error('A lost response after the node accepted the message.'); }
      return Response.json({ hash });
    }
    reads.push(url);
    if (endpoint === 'castById') {
      if (delayReadback && submitted.some((message) => hex(message.hash) === url.searchParams.get('hash'))) {
        delayReadback = false;
        return Response.json({ errCode: 'not_found' }, { status: 404 });
      }
      const cast = casts.get(url.searchParams.get('hash')!);
      return cast ? Response.json(cast) : Response.json({ errCode: 'not_found' }, { status: 404 });
    }
    if (endpoint === 'reactionById') {
      const key = `${url.searchParams.get('fid')}:${url.searchParams.get('reaction_type') === 'Like' ? 1 : 2}:${url.searchParams.get('target_fid')}:${url.searchParams.get('target_hash')}`;
      const reaction = reactions.get(key);
      return reaction ? Response.json(reaction) : Response.json({ errCode: 'not_found' }, { status: 404 });
    }
    if (customPage) return Response.json(customPage(url));
    const list = [...casts.values()];
    return Response.json({ messages: endpoint === 'castsByMention'
      ? list.filter((c) => c.data.fid !== 11)
      : endpoint === 'castsByFid' ? list.filter((c) => c.data.fid === 11)
        : list.filter((c) => c.data.castAddBody.parentCastId?.hash === url.searchParams.get('hash')),
      nextPageToken: '' });
  }));
  return { casts, submitted, reads,
    loseNextResponse: () => { loseResponse = true; },
    delayNextReadback: () => { delayReadback = true; },
    refuse: (endpoint: string) => { refusedEndpoint = endpoint; },
    pages: (fn: (url: URL) => unknown) => { customPage = fn; },
    holdValidation: () => {
      let release!: () => void;
      waitForValidation = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { validationEntered = resolve; });
      return { entered, release };
    },
  };
}

function expectOctetStream(init?: RequestInit) {
  if (init?.method !== 'POST' || (init.headers as Record<string, string>)?.['Content-Type'] !== 'application/octet-stream') {
    throw new Error('Signed messages must be sent as protobuf octet streams.');
  }
}
