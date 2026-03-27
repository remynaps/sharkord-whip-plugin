import { parse, write, type SessionDescription, type MediaDescription } from 'sdp-transform';
import { randomInt } from 'crypto';
import type {
  DtlsParameters,
  FingerprintAlgorithm,
  IceCandidate,
  IceParameters,
  RtpHeaderExtensionUri,
  RtpParameters,
} from 'mediasoup/types';

export type ParsedSdp = SessionDescription;
export interface AnswerOptions {
  parsedOffer: ParsedSdp;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  announcedIp: string;
}

// sha-256 is what every modern WebRTC client expects. the others are just
// fallbacks in case mediasoup doesn't offer it for some reason.
const FINGERPRINT_PREFERENCE = ['sha-256', 'sha-512', 'sha-384', 'sha-1'];

// simple counter so each SDP answer gets a unique session ID. resets on
// server restart but that's fine, it only needs to be unique per connection.
let sessionCounter = 0;

// parse an SDP string once and pass the result around. no need to re-parse
// the same string multiple times.
export function parseSdp(sdp: string): ParsedSdp {
  return parse(sdp);
}

export function extractDtlsParameters(parsed: ParsedSdp): DtlsParameters {
  const media = parsed.media[0];
  const fp = media?.fingerprint ?? parsed.fingerprint;
  if (!fp) throw new Error('No DTLS fingerprint in SDP offer');

  // DTLS is the encryption handshake. one side has to go first (the "client")
  // and the other waits (the "server"). we always answer as passive so OBS
  // always initiates toward us, which means:
  //   OBS says "active"  -> OBS goes first -> OBS is the client
  //   OBS says "actpass" -> we picked passive -> OBS goes first -> OBS is the client
  //   OBS says "passive" -> OBS is waiting -> we go first -> OBS is the server
  const setupAttr = media?.setup ?? parsed.setup ?? 'actpass';
  const role: DtlsParameters['role'] =
    setupAttr === 'passive' ? 'server' : 'client';

  return {
    role,
    fingerprints: [{ algorithm: fp.type as FingerprintAlgorithm, value: fp.hash }],
  };
}

export function extractRtpParameters(
  parsed: ParsedSdp,
  kind: 'audio' | 'video'
): RtpParameters | null {
  const media = parsed.media.find((m) => m.type === kind);
  if (!media || !media.rtp?.length) return null;

  const codecs: RtpParameters['codecs'] = media.rtp.map((r) => {
    const fmtp = media.fmtp?.find((f) => f.payload === r.payload);

    // rtcpFb is feedback messages the receiver can send back to the sender,
    // things like "please send a keyframe" or "you're sending too fast".
    // payload '*' means it applies to all codecs so we include those too.
    const rtcpFb = (media.rtcpFb ?? [])
      .filter((fb) => fb.payload === r.payload || fb.payload === '*')
      .map((fb) => ({ type: fb.type, parameter: fb.subtype ?? '' }));

    return {
      mimeType: `${kind}/${r.codec}`,
      payloadType: r.payload,
      clockRate: r.rate ?? (kind === 'audio' ? 48000 : 90000),
      ...(r.encoding ? { channels: Number(r.encoding) } : {}),
      parameters: fmtpToObject(fmtp?.config),
      rtcpFeedback: rtcpFb,
    };
  });

  // SSRC is basically a numeric stream ID that OBS stamps on every RTP packet.
  // we echo it back so mediasoup knows which packets belong to this stream.
  // if OBS didn't include one for some reason, a random number works fine.
  const ssrcId = media.ssrcs?.[0]?.id ?? randomInt(1, 0xffffffff);

  // CNAME is a human-readable label that shows up in RTCP reports, mostly
  // useful for debugging. we grab it from the offer if it's there.
  const cname = media.ssrcs?.find(s => s.attribute === 'cname')?.value;

  const encodings: RtpParameters['encodings'] = [{ ssrc: ssrcId }];

  // header extensions are extra bits of metadata attached to each RTP packet.
  // things like timestamps, audio levels, video orientation. we just pass
  // through whatever OBS offered, mediasoup handles the rest.
  const headerExtensions: RtpParameters['headerExtensions'] = (media.ext ?? []).map((e) => ({
    uri: e.uri as RtpHeaderExtensionUri,
    id: e.value,
    encrypt: false,
    parameters: {},
  }));

  return {
    mid: String(media.mid ?? (kind === 'audio' ? '0' : '1')),
    codecs,
    encodings,
    headerExtensions,
    rtcp: {
      cname: cname ? String(cname) : 'obs-stream',
      reducedSize: true, // smaller RTCP packets, standard WebRTC behaviour
    },
  };
}

export function buildSdpAnswer(opts: AnswerOptions): string {
  const { parsedOffer, iceParameters, iceCandidates, dtlsParameters, announcedIp } = opts;

  const fingerprint =
    FINGERPRINT_PREFERENCE
      .map((alg) => dtlsParameters.fingerprints.find((f) => f.algorithm === alg))
      .find(Boolean)
    ?? dtlsParameters.fingerprints.at(-1);
  if (!fingerprint) throw new Error('No DTLS fingerprint in transport parameters');

  const candidateLines = iceCandidates.map((c, idx) => ({
    // foundation groups candidates that share the same base IP. mediasoup
    // doesn't expose it so we just use the index, works fine in practice.
    foundation: String(idx + 1),
    component: 1,  // 1 = RTP, 2 = RTCP. always 1 since we mux RTCP onto the RTP port
    transport: c.protocol.toUpperCase(),
    priority: c.priority,
    ip: c.ip,
    port: c.port,
    type: c.type,  // host | srflx | relay, mediasoup gives us host
    ...(c.tcpType ? { tcptype: c.tcpType } : {}),
  }));

  // ICE and DTLS params are the same across all media sections when using
  // BUNDLE (which we always do), so define them once and spread in below.
  const sharedIce = {
    iceUfrag: iceParameters.usernameFragment,
    icePwd: iceParameters.password,
    // renomination lets ICE switch to a better network path mid-stream
    // without doing a full ICE restart.
    iceOptions: 'renomination',
  };

  const sharedDtls = {
    fingerprint: { type: fingerprint.algorithm, hash: fingerprint.value },
    setup: 'passive' as const, // OBS knocks, we open the door
  };

  const mediaAnswers = parsedOffer.media.map((offerMedia: MediaDescription) => ({
    type: offerMedia.type,
    // port 9 is the standard WebRTC placeholder. it means "ignore this port,
    // use the ICE candidates instead." (RFC 9429, RFC 9725)
    port: 9,
    protocol: 'UDP/TLS/RTP/SAVPF',  // encrypted RTP with feedback, standard WebRTC
    payloads: (offerMedia.rtp ?? []).map((r) => r.payload).join(' '),
    connection: { version: 4, ip: announcedIp },
    ...sharedIce,
    ...sharedDtls,
    mid: offerMedia.mid,
    direction: 'recvonly',  // we're a sink, we take the stream and don't send anything back
    rtp: offerMedia.rtp,
    rtcp: { port: 9, netType: 'IN', ipVer: 4, address: '0.0.0.0' },
    rtcpFb: offerMedia.rtcpFb,
    fmtp: offerMedia.fmtp,
    ext: offerMedia.ext,
    candidates: candidateLines,
    endOfCandidates: 'end-of-candidates',  // no trickle ICE, all candidates are upfront
    rtcpMux: 'rtcp-mux',     // RTCP shares the RTP port, one less port to deal with
    rtcpRsize: 'rtcp-rsize', // smaller RTCP packets, same as above
    ssrcs: [],  // recvonly so we have no outgoing stream to describe
  }));

  const groups = parsedOffer.groups ?? [{
    type: 'BUNDLE',
    mids: parsedOffer.media.map((m) => String(m.mid)).join(' '),
  }];

  return write({
    version: 0,
    origin: {
      username: '-',
      sessionId: ++sessionCounter,
      sessionVersion: 1,
      netType: 'IN',        // always IN (internet), basically just boilerplate
      ipVer: 4,
      address: '127.0.0.1', // informational only, OBS doesn't use this for routing
    },
    name: '-',               // required by spec, content doesn't matter
    timing: { start: 0, stop: 0 }, // 0/0 means the session never expires
    // ice-lite means we only respond to OBS's ICE checks, we never send our own.
    // mediasoup always works this way and OBS needs to know or it'll wait forever.
    icelite: 'ice-lite',
    fingerprint: { type: fingerprint.algorithm, hash: fingerprint.value },
    groups,
    msidSemantic: { semantic: 'WMS', token: '' }, // WebRTC boilerplate, required by spec
    media: mediaAnswers,
  } as Parameters<typeof write>[0]);
}

// converts fmtp config strings like "profile-level-id=42e01f;level-asymmetry-allowed=1"
// into a plain object. numeric values are parsed as numbers.
function fmtpToObject(config?: string): Record<string, string | number> {
  if (!config) return {};
  const obj: Record<string, string | number> = {};

  for (const pair of config.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;

    const k = pair.slice(0, eqIdx).trim();
    const v = pair.slice(eqIdx + 1).trim();
    if (!k) continue;

    const num = Number(v);
    obj[k] = !isNaN(num) ? num : v;
  }
  return obj;
}