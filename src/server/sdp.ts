/**
 * sdp.ts
 *
 * Converts between OBS's SDP offer and mediasoup transport parameters,
 * and builds the SDP answer we send back to OBS.
 *
 * All exported functions take a pre-parsed SDP object . call parseSdp() once
 * and pass the result around instead of re-parsing the same string repeatedly.
 */

import { parse, write, type MediaDescription } from 'sdp-transform';
import { randomInt } from 'crypto';
import type {
  DtlsParameters,
  FingerprintAlgorithm,
  IceCandidate,
  IceParameters,
  RtpHeaderExtensionUri,
  RtpParameters,
} from 'mediasoup/types';

export type ParsedSdp = ReturnType<typeof parse>;

/** Parse an SDP string once . pass the result to the extract/build functions below. */
export function parseSdp(sdp: string): ParsedSdp {
  return parse(sdp);
}

export function extractDtlsParameters(parsed: ParsedSdp): DtlsParameters {
  const media = parsed.media[0];
  const fp = media?.fingerprint ?? parsed.fingerprint;
  if (!fp) throw new Error('No DTLS fingerprint in SDP offer');

  // The role field here is the REMOTE's (OBS's) role, not ours.
  // mediasoup uses it to decide whether to initiate or wait:
  //   role: 'client' → remote initiates → mediasoup waits (acts as server)
  //   role: 'server' → remote waits     → mediasoup initiates (acts as client)
  //
  // Our SDP answer always says setup:passive, so OBS initiates toward us.
  //   OBS offer 'active'  → OBS initiates → OBS is client → pass 'client'
  //   OBS offer 'actpass' → we chose passive → OBS initiates → OBS is client → pass 'client'
  //   OBS offer 'passive' → OBS waits → OBS is server → pass 'server' (mediasoup initiates)
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

  const ssrcLine = media.ssrcs?.[0];
  const encodings: RtpParameters['encodings'] = [
    // SSRC is basically a stream ID . OBS puts it in the offer, we just echo it back.
    // If it's missing for some reason, a random one works fine.
    { ssrc: ssrcLine?.id ?? randomInt(0xffffffff) },
  ];

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
      // CNAME is just a human-readable sender label used in RTCP reports.
      // We grab it from the offer if it's there, otherwise slap a default on it.
      cname: ssrcLine?.attribute === 'cname' ? String(ssrcLine.value) : 'obs-stream',
      // Smaller RTCP packets . standard WebRTC behaviour, no reason to change it.
      reducedSize: true,
    },
  };
}

export interface AnswerOptions {
  parsedOffer: ParsedSdp;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  announcedIp: string;
}

// sha-256 is what basically every WebRTC client expects. The others are fallbacks
// in case mediasoup doesn't offer it (unlikely, but let's not crash over it).
const FINGERPRINT_PREFERENCE = ['sha-256', 'sha-512', 'sha-384', 'sha-1'];

export function buildSdpAnswer(opts: AnswerOptions): string {
  const { parsedOffer, iceParameters, iceCandidates, dtlsParameters, announcedIp } = opts;

  const fingerprint =
    FINGERPRINT_PREFERENCE
      .map((alg) => dtlsParameters.fingerprints.find((f) => f.algorithm === alg))
      .find(Boolean)
    ?? dtlsParameters.fingerprints.at(-1);
  if (!fingerprint) throw new Error('No DTLS fingerprint in transport parameters');

  const candidateLines = iceCandidates.map((c, idx) => ({
    // foundation is supposed to group candidates that share a base IP.
    // mediasoup doesn't expose it so we just use the index . works fine in practice.
    foundation: String(idx + 1),
    component: 1,           // 1 = RTP, 2 = RTCP. Always 1 since we mux RTCP onto the RTP port.
    transport: c.protocol.toUpperCase(),
    priority: c.priority,
    ip: c.ip,
    port: c.port,
    type: c.type,           // 'host' | 'srflx' | 'relay' . mediasoup gives us 'host'
    ...(c.tcpType ? { tcptype: c.tcpType } : {}),
  }));

  // These are the same across every media section when using BUNDLE,
  // so we define them once and spread them in below.
  const sharedIce = {
    iceUfrag: iceParameters.usernameFragment,
    icePwd: iceParameters.password,
    // renomination = if a better network path shows up mid-stream, use it without restarting ICE.
    iceOptions: 'renomination',
  };

  const sharedDtls = {
    fingerprint: { type: fingerprint.algorithm, hash: fingerprint.value },
    setup: 'passive' as const, // OBS knocks, we open the door
  };

  const mediaAnswers = parsedOffer.media.map((offerMedia: MediaDescription) => ({
    type: offerMedia.type,
    // Port 9 is the conventional WebRTC discard placeholder . standard across JSEP (RFC 9429)
    // and WHIP (RFC 9725). Means "ignore this, look at the ICE candidates instead."
    port: 9,
    protocol: 'UDP/TLS/RTP/SAVPF',  // encrypted RTP with feedback . the standard WebRTC stack
    payloads: (offerMedia.rtp ?? []).map((r) => r.payload).join(' '),
    connection: { version: 4, ip: announcedIp },
    ...sharedIce,
    ...sharedDtls,
    mid: offerMedia.mid,
    // recvonly . we're a sink, not a source. We take OBS's stream, we don't send anything back.
    direction: 'recvonly',
    rtp: offerMedia.rtp,
    // Port 9 is another discard placeholder. Doesn't matter because rtcp-mux
    // means RTCP piggybacks on the RTP port anyway.
    rtcp: { port: 9, netType: 'IN', ipVer: 4, address: '0.0.0.0' },
    rtcpFb: offerMedia.rtcpFb,
    fmtp: offerMedia.fmtp,
    ext: offerMedia.ext,
    candidates: candidateLines,
    // Tell OBS we're done listing candidates upfront (no trickle ICE).
    endOfCandidates: 'end-of-candidates',
    // RTCP rides on the same port as RTP . one less port to worry about.
    rtcpMux: 'rtcp-mux',
    // Smaller RTCP packets . same as above, standard WebRTC stuff.
    rtcpRsize: 'rtcp-rsize',
    // We're recvonly so we have no outgoing stream to describe . leave this empty.
    ssrcs: [],
  }));

  const groups = parsedOffer.groups ?? [{
    type: 'BUNDLE',
    mids: parsedOffer.media.map((m) => String(m.mid)).join(' '),
  }];

  return write({
    version: 0,
    origin: {
      username: '-',
      sessionId: Date.now(),  // just needs to be unique . timestamp does the job
      sessionVersion: 1,
      netType: 'IN',          // 'IN' = Internet. It's the only valid value, basically just boilerplate.
      ipVer: 4,
      address: '127.0.0.1',  // purely informational, OBS doesn't use this for routing
    },
    name: '-',                // required by the SDP spec, content is irrelevant
    timing: { start: 0, stop: 0 },  // 0/0 means the session never expires
    // ice-lite means we sit back and respond to OBS's ICE checks . we never send our own.
    // mediasoup always works this way, and we need to say so or OBS will wait forever
    // for checks that are never coming.
    icelite: 'ice-lite',
    fingerprint: { type: fingerprint.algorithm, hash: fingerprint.value },
    groups,
    // WMS boilerplate . WebRTC requires it, content doesn't matter.
    msidSemantic: { semantic: 'WMS', token: '' },
    media: mediaAnswers,
  } as Parameters<typeof write>[0]);
}

function fmtpToObject(config?: string): Record<string, string | number> {
  if (!config) return {};
  return Object.fromEntries(
    config.split(';').flatMap((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) return [];
      const k = pair.slice(0, eqIdx).trim();
      const v = pair.slice(eqIdx + 1).trim();
      if (!k) return [];
      const num = Number(v);
      return [[k, isNaN(num) ? v : num]];
    })
  );
}