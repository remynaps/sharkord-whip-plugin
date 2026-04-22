import { describe, it, expect } from "bun:test";
import {
  parseSdp,
  extractDtlsParameters,
  extractRtpParameters,
  buildSdpAnswer,
  type ParsedSdp,
} from "../src/server/sdp.ts";
import type {
  DtlsParameters,
  IceCandidate,
  IceParameters,
} from "mediasoup/types";

const HASH =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

const baseAudio = {
  type: "audio",
  port: 9,
  protocol: "UDP/TLS/RTP/SAVPF",
  payloads: "111",
  rtp: [{ payload: 111, codec: "opus", rate: 48000, encoding: "2" }],
  fmtp: [{ payload: 111, config: "minptime=10;useinbandfec=1" }],
  rtcpFb: [],
  ext: [],
  fingerprint: { type: "sha-256", hash: HASH },
  setup: "actpass",
  ssrcs: [{ id: 12345678, attribute: "cname", value: "test-cname" }],
  mid: "0",
};

function makeOffer(
  mediaOverride?: Partial<typeof baseAudio>,
  sessionOverride?: Partial<ParsedSdp>,
): ParsedSdp {
  return {
    version: 0,
    origin: {
      username: "-",
      sessionId: "123",
      sessionVersion: 2,
      netType: "IN",
      ipVer: 4,
      address: "127.0.0.1",
    },
    name: "-",
    timing: { start: 0, stop: 0 },
    media: [{ ...baseAudio, ...mediaOverride }],
    ...sessionOverride,
  } as unknown as ParsedSdp;
}

const ICE: IceParameters = {
  usernameFragment: "testufrag",
  password: "testpassword",
};
const CANDIDATES = [
  {
    foundation: "1",
    priority: 2130706431,
    ip: "1.2.3.4",
    port: 40001,
    protocol: "udp",
    type: "host",
  },
] as unknown as IceCandidate[];
const DTLS: DtlsParameters = {
  role: "client",
  fingerprints: [{ algorithm: "sha-256", value: HASH }],
};

describe("parseSdp", () => {
  it("returns a parsed session description", () => {
    const result = parseSdp(
      "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
    );
    expect(result.version).toBe(0);
  });
});

describe("extractDtlsParameters", () => {
  it("returns client role for actpass", () => {
    expect(extractDtlsParameters(makeOffer()).role).toBe("client");
  });

  it("returns client role for active", () => {
    expect(extractDtlsParameters(makeOffer({ setup: "active" })).role).toBe(
      "client",
    );
  });

  it("returns server role for passive", () => {
    expect(extractDtlsParameters(makeOffer({ setup: "passive" })).role).toBe(
      "server",
    );
  });

  it("throws when no fingerprint is present", () => {
    expect(() =>
      extractDtlsParameters(makeOffer({ fingerprint: undefined })),
    ).toThrow("No DTLS fingerprint");
  });

  it("falls back to session-level fingerprint", () => {
    const offer = makeOffer(
      { fingerprint: undefined },
      { fingerprint: { type: "sha-256", hash: HASH } },
    );
    expect(extractDtlsParameters(offer).fingerprints[0].value).toBe(HASH);
  });
});

describe("extractRtpParameters", () => {
  it("returns null for absent media kind", () => {
    expect(extractRtpParameters(makeOffer(), "video")).toBeNull();
  });

  it("extracts opus codec with clock rate and channels", () => {
    const result = extractRtpParameters(makeOffer(), "audio");
    expect(result?.codecs[0].mimeType).toBe("audio/opus");
    expect(result?.codecs[0].clockRate).toBe(48000);
    expect(result?.codecs[0].channels).toBe(2);
  });

  it("parses fmtp into a key/value object with numeric coercion", () => {
    const result = extractRtpParameters(makeOffer(), "audio");
    expect(result?.codecs[0].parameters).toEqual({
      minptime: 10,
      useinbandfec: 1,
    });
  });

  it("uses the ssrc from the offer", () => {
    const result = extractRtpParameters(makeOffer(), "audio");
    expect(result?.encodings[0].ssrc).toBe(12345678);
  });

  it("uses the cname from the offer", () => {
    const result = extractRtpParameters(makeOffer(), "audio");
    expect(result?.rtcp.cname).toBe("test-cname");
  });

  it("falls back to obs-stream when cname is absent", () => {
    const result = extractRtpParameters(makeOffer({ ssrcs: [] }), "audio");
    expect(result?.rtcp.cname).toBe("obs-stream");
  });
});

describe("buildSdpAnswer", () => {
  const opts = () => ({
    parsedOffer: makeOffer(),
    iceParameters: ICE,
    iceCandidates: CANDIDATES,
    dtlsParameters: DTLS,
    announcedIp: "1.2.3.4",
  });

  it("produces a parseable SDP with recvonly direction", () => {
    const parsed = parseSdp(buildSdpAnswer(opts()));
    expect(parsed.media[0].direction).toBe("recvonly");
  });

  it("sets ICE credentials from the transport", () => {
    const parsed = parseSdp(buildSdpAnswer(opts()));
    expect(parsed.media[0].iceUfrag).toBe("testufrag");
    expect(parsed.media[0].icePwd).toBe("testpassword");
  });

  it("includes end-of-candidates", () => {
    expect(buildSdpAnswer(opts())).toContain("end-of-candidates");
  });

  it("prefers sha-256 fingerprint over sha-512", () => {
    const dtls: DtlsParameters = {
      role: "client",
      fingerprints: [
        { algorithm: "sha-512", value: "AB:CD" },
        { algorithm: "sha-256", value: HASH },
      ],
    };
    const answer = buildSdpAnswer({ ...opts(), dtlsParameters: dtls });
    expect(answer).toContain(`sha-256 ${HASH}`);
  });

  it("throws when dtls has no fingerprints", () => {
    const dtls: DtlsParameters = { role: "client", fingerprints: [] };
    expect(() => buildSdpAnswer({ ...opts(), dtlsParameters: dtls })).toThrow(
      "No DTLS fingerprint",
    );
  });
});
