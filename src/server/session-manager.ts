import type { PluginContext } from "@sharkord/plugin-sdk";
import { randomUUID } from "crypto";
import { WhipSession } from "./whip-session.ts";
import {
  parseSdp,
  extractDtlsParameters,
  extractRtpParameters,
  buildSdpAnswer,
} from "./sdp.ts";
import { addOnceListener } from "./util.ts";

export class WhipSessionManager {
  private sessions = new Map<string, WhipSession>();

  public get size(): number {
    return this.sessions.size;
  }
  public has(id: string): boolean {
    return this.sessions.has(id);
  }

  public async createSession(
    ctx: PluginContext,
    channelId: number,
    title: string,
    offerSdp: string,
    rtpMinPort: number,
    rtpMaxPort: number,
    maxStreams: number,
    avatarUrl?: string,
  ) {
    // check and reserve the slot before any awaits to prevent a race condition
    // where two concurrent requests both pass the limit check before either
    // has added itself to the map.
    if (maxStreams > 0 && this.sessions.size >= maxStreams) {
      throw new Error(`Stream limit reached (max ${maxStreams})`);
    }

    const sessionId = randomUUID();
    this.sessions.set(sessionId, null!); // hold the slot

    const router = ctx.voice.getRouter(channelId);
    if (!router) {
      this.sessions.delete(sessionId);
      throw new Error(
        `Voice channel ${channelId} has no active runtime. Someone must be in the channel before you can stream into it.`,
      );
    }

    const { ip, announcedAddress } = ctx.voice.getListenInfo();
    const host = (announcedAddress ?? ip)
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");

    const transport = await router.createWebRtcTransport({
      listenInfos: [
        {
          protocol: "udp",
          ip: "0.0.0.0",
          announcedAddress: host,
          portRange: { min: rtpMinPort, max: rtpMaxPort },
        },
        {
          protocol: "tcp",
          ip: "0.0.0.0",
          announcedAddress: host,
          portRange: { min: rtpMinPort, max: rtpMaxPort },
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    try {
      const parsedOffer = parseSdp(offerSdp);

      await transport.connect({
        dtlsParameters: extractDtlsParameters(parsedOffer),
      });

      const aParams = extractRtpParameters(parsedOffer, "audio");
      const vParams = extractRtpParameters(parsedOffer, "video");

      const audioProducer = aParams
        ? await transport.produce({ kind: "audio", rtpParameters: aParams })
        : undefined;
      const videoProducer = vParams
        ? await transport.produce({ kind: "video", rtpParameters: vParams })
        : undefined;

      if (!audioProducer && !videoProducer)
        throw new Error("No usable media in SDP offer");

      const streamHandle = ctx.voice.createStream({
        channelId,
        title,
        key: sessionId,
        avatarUrl,
        producers: { audio: audioProducer, video: videoProducer },
      });

      // when the session cleans itself up, remove the router listener so it doesn't leak
      const onRouterClose = () => this.remove(sessionId);
      addOnceListener(router.observer, "close", onRouterClose);

      const session = new WhipSession(
        sessionId,
        channelId,
        title,
        avatarUrl,
        transport,
        audioProducer,
        videoProducer,
        streamHandle,
        (id) => {
          router.observer.removeListener("close", onRouterClose);
          this.sessions.delete(id);
        },
      );

      // if either producer dies unexpectedly, tear down the whole session
      addOnceListener(audioProducer?.observer, "close", () =>
        this.remove(sessionId),
      );
      addOnceListener(videoProducer?.observer, "close", () =>
        this.remove(sessionId),
      );

      this.sessions.set(sessionId, session); // replace the placeholder with the real session

      const sdp = buildSdpAnswer({
        parsedOffer,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        announcedIp: host,
      });

      return { sessionId, sdp };
    } catch (err) {
      this.sessions.delete(sessionId); // release the slot
      transport.close();
      throw err;
    }
  }

  public listSessions() {
    return [...this.sessions.entries()]
      .filter(([, s]) => s !== null)
      .map(([sessionId, s]) => ({
        sessionId,
        channelId: s.channelId,
        title: s.title,
        avatarUrl: s.avatarUrl,
      }));
  }

  public remove(id: string) {
    this.sessions.get(id)?.close();
  }

  public clear() {
    for (const id of this.sessions.keys()) this.remove(id);
  }

  public async getStats(id: string) {
    const session = this.sessions.get(id);
    if (!session) return null;

    const [transportStats, audioStats, videoStats] = await Promise.all([
      session.transport.getStats(),
      session.audioProducer?.getStats(),
      session.videoProducer?.getStats(),
    ]);

    const t = transportStats[0];
    if (!t) return null;
    const a = audioStats?.[0] ?? null;
    const v = videoStats?.[0] ?? null;

    return {
      transport: {
        bytesReceived: t.bytesReceived,
        recvBitrate: t.recvBitrate,
        iceState: t.iceState,
        dtlsState: t.dtlsState,
        remoteIp: t.iceSelectedTuple?.remoteIp,
        remotePort: t.iceSelectedTuple?.remotePort,
        protocol: t.iceSelectedTuple?.protocol,
      },
      audio: a
        ? {
            bitrate: a.bitrate,
            packetsLost: a.packetsLost,
            fractionLost: a.fractionLost,
            jitter: a.jitter,
            score: a.score,
            mimeType: a.mimeType,
          }
        : null,
      video: v
        ? {
            bitrate: v.bitrate,
            packetsLost: v.packetsLost,
            fractionLost: v.fractionLost,
            jitter: v.jitter,
            score: v.score,
            mimeType: v.mimeType,
            pliCount: v.pliCount,
            nackCount: v.nackCount,
          }
        : null,
    };
  }
}
