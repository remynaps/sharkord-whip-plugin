/**
 * whip-server.ts
 *
 * Runs a small Bun HTTP server implementing the WHIP protocol.
 *
 * Flow per OBS connection:
 *   1. OBS sends POST /whip/:channelId  (SDP offer, Bearer stream-key)
 *   2. We create a mediasoup WebRtcTransport on the channel's router
 *   3. We connect it with OBS's DTLS params and produce audio+video
 *   4. We call ctx.actions.voice.createStream() to inject into the channel
 *   5. We respond 201 with our SDP answer
 *   6. OBS sends DELETE /whip/:channelId/:sessionId to end the stream
 */

import type { PluginContext, PluginSettings, TExternalStreamHandle } from '@sharkord/plugin-sdk';
import type { Producer, Transport } from 'mediasoup/types';
import { randomUUID, timingSafeEqual } from 'crypto';
import {
  buildSdpAnswer,
  extractDtlsParameters,
  extractRtpParameters,
  parseSdp,
} from './sdp.ts';
import { addOnceListener, corsResponse } from './util.ts';
import type { Session } from '../types/session.ts';
import type { SessionStats, TrackStats } from '../types/session-stats.ts';

type WhipSettings = PluginSettings<any>;

// First some state stuff.
// The server itself and the sessions (for multiple streams)
let server: ReturnType<typeof Bun.serve> | null = null;
const sessions = new Map<string, Session>();

// Rate limit: track failed attempts per IP
const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000; // 1 minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now > entry.resetAt) return true;
  return entry.count < MAX_ATTEMPTS;
}

function recordFailedAttempt(ip: string) {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    failedAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

function clearFailedAttempts(ip: string) {
  failedAttempts.delete(ip);
}

// Constant-time comparison to prevent timing attacks on the stream key
function safeEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    const maxLen = Math.max(ba.length, bb.length);
    const pa = Buffer.concat([ba, Buffer.alloc(maxLen - ba.length)]);
    const pb = Buffer.concat([bb, Buffer.alloc(maxLen - bb.length)]);
    return timingSafeEqual(pa, pb) && ba.length === bb.length;
  } catch {
    return false;
  }
}

// Remove a session, close all the audio and video producers
function cleanupSession(ctx: PluginContext, sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Delete first — the close() calls below can synchronously fire producer/transport
  // observer events which re-enter this function. Without this, all three listeners
  // (audio observer, video observer, router) race in before anyone deletes the entry
  // and cleanupSession runs three times on the same session.
  sessions.delete(sessionId);

  try {
    session.audioProducer?.close();
    session.videoProducer?.close();
    session.transport.close();
    session.streamHandle.remove();
  } catch (err) {
    ctx.error('WHIP: error during session cleanup:', err);
  }

  ctx.log(`WHIP: session ${sessionId} cleaned up`);
}

function cleanupAllSessions(ctx: PluginContext) {
  for (const sessionId of sessions.keys()) {
    cleanupSession(ctx, sessionId);
  }
}

// Actually start the WHIP server.
// Only one endpoint with some different request types.
// the main one is POST to register a new session
export function startWhipServer(
  ctx: PluginContext,
  settings: WhipSettings,
  rtpMinPort: number,
  rtpMaxPort: number,
) {
  const port = settings.get('port') as number;

  server = Bun.serve({
    port,
    async fetch(req) {
      if (req.method === 'OPTIONS') {
        return corsResponse(new Response(null, { status: 204 }));
      }

      const url = new URL(req.url);
      const parts = url.pathname.split('/').filter(Boolean);
      ctx.log(`WHIP: ${req.method} ${url.pathname}`);
      if (req.method === 'POST' && parts[0] === 'whip' && parts.length === 2) {
        return corsResponse(
          await handleWhipOffer(ctx, settings, req, parts[1]!, rtpMinPort, rtpMaxPort)
        );
      }

      if (req.method === 'DELETE' && parts[0] === 'whip' && parts.length === 3) {
        return corsResponse(handleWhipDelete(ctx, parts[2]!));
      }

      if (req.method === 'GET' && url.pathname === '/whip') {
        return corsResponse(
          new Response(
            JSON.stringify({ status: 'ok', sessions: sessions.size }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        );
      }

       // Stats endpoint — no auth, read-only and not sensitive
      if (req.method === 'GET' && parts[0] === 'whip' && parts[1] === 'stats' && parts.length === 3) {
        const channelId = parseInt(parts[2]!);
        if (isNaN(channelId)) {
          return corsResponse(new Response('Bad Request', { status: 400 }));
        }
        const stats = await getChannelStats(channelId);
        return corsResponse(
          new Response(JSON.stringify(stats), {
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      return corsResponse(new Response('Not Found', { status: 404 }));
    },
  });

  ctx.log(`WHIP server listening on port ${port}`);
}

export function stopWhipServer(ctx: PluginContext) {
  cleanupAllSessions(ctx);
  failedAttempts.clear();
  server?.stop();
  server = null;
  ctx.log('WHIP server stopped');
}

//                  .##@@&&&@@##.
//               ,##@&::%&&%%::&@##.
//              #@&:%%000000000%%:&@#
//            #@&:%00'         '00%:&@#
//           #@&:%0'             '0%:&@#
//          #@&:%0                 0%:&@#
//         #@&:%0                   0%:&@#
//         #@&:%0                   0%:&@#
//         "" ' "                   " ' ""
//       _oOoOoOo_                   .-.-.
//      (oOoOoOoOo)                 (  :  )
//       )`"""""`(                .-.`. .'.-.
//      /         \              (_  '.Y.'  _)
//     | #         |             (   .'|'.   )
//     \           /              '-'  |  '-'
// ---------------------------------------------------------------------
// ---------------- This is where the magic happens --------------------
// ---------------------------------------------------------------------
async function handleWhipOffer(
  ctx: PluginContext,
  settings: WhipSettings,
  req: Request,
  channelIdStr: string,
  rtpMinPort: number,
  rtpMaxPort: number,
): Promise<Response> {
  const expectedKey = settings.get('stream_key') as string;
  const auth = req.headers.get('Authorization') ?? '';
  const providedKey = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  const clientIp = req.headers.get('x-forwarded-for') ?? 'unknown';

  if (expectedKey) {
    if (!checkRateLimit(clientIp)) {
      ctx.error(`WHIP: rate limit exceeded for ${clientIp}`);
      return new Response('Too Many Requests', { status: 429 });
    }
    if (!safeEqual(providedKey, expectedKey)) {
      recordFailedAttempt(clientIp);
      ctx.error(`WHIP: rejected connection from ${clientIp} — wrong stream key`);
      return new Response('Unauthorized', { status: 401 });
    }
    clearFailedAttempts(clientIp);
  }

  // Channel
  const channelId = parseInt(channelIdStr, 10);
  if (isNaN(channelId)) {
    return new Response('Bad channel ID', { status: 400 });
  }

  // SDP offer
  const offerSdp = await req.text();
  if (!offerSdp.startsWith('v=0')) {
    return new Response('Expected SDP offer body', { status: 400 });
  }

  ctx.log(`WHIP: incoming offer for channel ${channelId}`);

  try {
    const router = ctx.actions.voice.getRouter(channelId);
    if (!router) {
      return new Response(
        `Voice channel ${channelId} has no active runtime. ` +
          `Someone must be in the channel before you can stream into it.`,
        { status: 503 }
      );
    }

    const { ip: listenIp, announcedAddress } = await ctx.actions.voice.getListenInfo();
    const rawHost = announcedAddress ?? listenIp;
    const announcedHost = rawHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    ctx.log(`WHIP: listenIp=${listenIp} announcedHost=${announcedHost}`);

    ctx.log(`WHIP: creating WebRtcTransport...`);
    const transport = await router.createWebRtcTransport({
      listenInfos: [
        { protocol: 'udp', ip: '0.0.0.0', announcedAddress: announcedHost, portRange: { min: rtpMinPort, max: rtpMaxPort } },
        { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: announcedHost, portRange: { min: rtpMinPort, max: rtpMaxPort } },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      enableSctp: false,
    });
    ctx.log(`WHIP: fingerprint algorithms: ${transport.dtlsParameters.fingerprints.map(f => f.algorithm).join(', ')}`);

    transport.on('icestatechange',  (state) => ctx.log(`WHIP [${transport.id}] ICE: ${state}`));
    transport.on('dtlsstatechange', (state) => ctx.log(`WHIP [${transport.id}] DTLS: ${state}`));

    const parsedOffer = parseSdp(offerSdp);

    ctx.log(`WHIP: transport created, connecting DTLS...`);
    const obsDtlsParams = extractDtlsParameters(parsedOffer);
    ctx.log(`WHIP: OBS fingerprint (theirs):  ${obsDtlsParams.fingerprints[0]?.algorithm} ${obsDtlsParams.fingerprints[0]?.value}`);
    ctx.log(`WHIP: OBS DTLS role we assigned: ${obsDtlsParams.role}`);
    ctx.log(`WHIP: our fingerprint (ours):    ${transport.dtlsParameters.fingerprints.find(f => f.algorithm === 'sha-256')?.value}`);
    await transport.connect({ dtlsParameters: obsDtlsParams });

    // ---------------- Set up audio and video -------------------------
    // ---------------- Yes this is the main thingy --------------------
    const audioRtpParams = extractRtpParameters(parsedOffer, 'audio');
    let audioProducer: Producer | undefined;
    if (audioRtpParams) {
      audioProducer = await transport.produce({ kind: 'audio', rtpParameters: audioRtpParams });
      ctx.debug(`WHIP: audio producer ${audioProducer.id}`);
    }

    const videoRtpParams = extractRtpParameters(parsedOffer, 'video');
    let videoProducer: Producer | undefined;
    if (videoRtpParams) {
      videoProducer = await transport.produce({ kind: 'video', rtpParameters: videoRtpParams });
      ctx.debug(`WHIP: video producer ${videoProducer.id}`);
    }

    if (!audioProducer && !videoProducer) {
      transport.close();
      return new Response('SDP offer contained no usable audio or video', { status: 400 });
    }

    const sessionId = randomUUID();
    const streamHandle = ctx.actions.voice.createStream({
      channelId,
      title: 'OBS Stream',
      key: sessionId,
      producers: { audio: audioProducer, video: videoProducer },
    });

    sessions.set(sessionId, { channelId, transport, audioProducer, videoProducer, streamHandle });

    // ---------------------- Setup finished -----------------------

    ctx.log(
      `WHIP: stream ${sessionId} started in channel ${channelId}` +
        ` (audio=${!!audioProducer}, video=${!!videoProducer})`
    );

    // Tear down if the router closes (everyone left the voice channel)
    addOnceListener(router, '@close', () => {
      ctx.log(`WHIP: router closed for channel ${channelId}, cleaning up ${sessionId}`);
      cleanupSession(ctx, sessionId);
    });

    // Tear down if either producer dies unexpectedly
    if (audioProducer) {
      addOnceListener(audioProducer.observer, 'close', () => {
        cleanupSession(ctx, sessionId);
      });
    }
    if (videoProducer) {
      addOnceListener(videoProducer.observer, 'close', () => {
        cleanupSession(ctx, sessionId);
      });
    }

    const answerSdp = buildSdpAnswer({
      parsedOffer,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      announcedIp: announcedHost,
    });

    ctx.log('WHIP: ICE candidates offered to OBS:\n' +
      transport.iceCandidates.map(c => `  ${c.protocol} ${c.ip}:${c.port} (${c.type})`).join('\n')
    );
    ctx.log('WHIP: SDP answer:\n' + answerSdp);

    return new Response(answerSdp, {
      status: 201,
      headers: {
        'Content-Type': 'application/sdp',
        Location: `/whip/${channelId}/${sessionId}`,
      },
    });
  } catch (err) {
    ctx.error('WHIP: failed to set up stream:', err);
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    return new Response(`Stream setup failed: ${msg}`, { status: 500 });
  }
}

function handleWhipDelete(ctx: PluginContext, sessionId: string): Response {
  if (!sessions.has(sessionId)) {
    return new Response('Session not found', { status: 404 });
  }
  cleanupSession(ctx, sessionId);
  return new Response(null, { status: 200 });
}


//           .--------._
//          (`--'       `-.
//           `.______      `.
//        ___________`__     \
//     ,-'           `-.\     |
//    //                \|    |\
//   (`  .'~~~~~---\     \'   | |
//    `-'           )     \   | |
//       ,---------' - -.  `  . '
//     ,'             `%`\`     |
//    /                      \  |
//   /     \-----.         \    `
//  /|  ,_/      '-._            |
// (-'  /           /            `     (Joshua Bell)
// ,`--<           |        \     \
// \ |  \         /%%             `\
//  |/   \____---'--`%        \     \
//  |    '           `               \
//  |
//   `--.__
//         `---._______
//                     `.
//                       \
// Get some very cool stats from the stream.
// Well we're not decoding anything. So we dont actually know things like fps and resolution but still.
export async function getChannelStats(channelId: number): Promise<SessionStats[]> {
  const results: SessionStats[] = [];

  for (const [sessionId, session] of sessions) {
    if (session.channelId !== channelId) continue;

    const tracks: TrackStats[] = [];

    for (const producer of [session.audioProducer, session.videoProducer]) {
      if (!producer) continue;
      const stats = await producer.getStats();
      const s = stats[0];
      if (!s) continue;

      const kind = producer.kind;
      tracks.push({
        kind,
        mimeType: s.mimeType ?? (kind === 'audio' ? 'audio/opus' : 'video/h264'),
        bitrate: Math.round((s.bitrate ?? 0) / 1000),
        packetsLost: s.packetsLost ?? 0,
        fractionLost: s.fractionLost != null ? Math.round((s.fractionLost / 255) * 100 * 10) / 10 : 0,
        jitter: s.jitter != null ? Math.round(s.jitter * 1000) : 0,
        score: s.score ?? 0,
        roundTripTime: s.roundTripTime != null ? Math.round(s.roundTripTime * 1000) : 0,
        nackCount: s.nackCount ?? 0,
        ...(kind === 'video' ? {
          pliCount: s.pliCount ?? 0,
          firCount: s.firCount ?? 0,
        } : {}),
      });
    }

    results.push({ sessionId, channelId, tracks });
  }

  return results;
}