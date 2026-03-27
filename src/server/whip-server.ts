import type { PluginContext, PluginSettings } from '@sharkord/plugin-sdk';
import { timingSafeEqual } from 'crypto';
import { corsResponse } from './util.ts';
import { escape, stripLow } from 'validator';
import { WhipSessionManager } from './session-manager.ts';

type WhipSettings = PluginSettings<any>;

let server: ReturnType<typeof Bun.serve> | null = null;
let manager: WhipSessionManager | null = null;

// rate limit: track failed attempts per IP
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

// constant-time comparison to prevent timing attacks on the stream key
function safeEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    const maxLen = Math.max(ba.length, bb.length);
    const pa = Buffer.concat([ba, Buffer.alloc(maxLen - ba.length)]);
    const pb = Buffer.concat([bb, Buffer.alloc(maxLen - bb.length)]);
    // store the result before the length check so it can't leak timing info
    const equal = timingSafeEqual(pa, pb);
    return equal && ba.length === bb.length;
  } catch {
    return false;
  }
}

function sanitizeTitle(raw: string): string {
  return escape(stripLow(raw.trim().replace(/\s+/g, ' '))).slice(0, 64) || 'OBS Stream';
}

export function startWhipServer(
  ctx: PluginContext,
  settings: WhipSettings,
  rtpMinPort: number,
  rtpMaxPort: number,
) {
  manager = new WhipSessionManager();
  const port = settings.get('port') as number;

  server = Bun.serve({
    port,
    async fetch(req) {
      if (req.method === 'OPTIONS') {
        return corsResponse(new Response(null, { status: 204 }));
      }

      const url = new URL(req.url);
      const parts = url.pathname.split('/').filter(Boolean);
      const whipPart  = parts[0]; // always 'whip'
      const channelId = parts[1]; // voice channel ID, for example: '3'
      const sessionId = parts[2]; // session UUID, only present on DELETE

      // custom stream name, falls back to the setting, then to a default.
      // And yes i know what you're gonna say. 'But this is overkill for a title!!'. And you'd be right.
      // I just really don't want to deal with regex escape stuff so here we are.
      const rawTitle = url.searchParams.get('title') ?? settings.get('stream_name') as string ?? 'OBS Stream';
      const title = sanitizeTitle(rawTitle);

      if (req.method === 'POST' && whipPart === 'whip' && parts.length === 2) {
        return corsResponse(
          await handleWhipOffer(ctx, settings, req, channelId!, title, rtpMinPort, rtpMaxPort)
        );
      }

      if (req.method === 'DELETE' && whipPart === 'whip' && parts.length === 3) {
        return corsResponse(handleWhipDelete(ctx, sessionId!));
      }

      if (req.method === 'GET' && url.pathname === '/whip') {
        return corsResponse(
          new Response(
            JSON.stringify({ status: 'ok', sessions: manager!.size }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        );
      }

      return corsResponse(new Response('Not Found', { status: 404 }));
    },
  });

  ctx.log(`WHIP server listening on port ${port}`);
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
  title: string,
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
      ctx.error(`WHIP: rejected connection from ${clientIp}, wrong stream key`);
      return new Response('Unauthorized', { status: 401 });
    }
    clearFailedAttempts(clientIp);
  }

  const channelId = parseInt(channelIdStr, 10);
  if (isNaN(channelId)) {
    return new Response('Bad channel ID', { status: 400 });
  }

  const offerSdp = await req.text();
  if (!offerSdp.startsWith('v=0')) {
    return new Response('Expected SDP offer body', { status: 400 });
  }

  ctx.log(`WHIP: incoming offer for channel ${channelId}`);

  // max streams is enforced inside createSession so the check and the slot
  // reservation happen atomically before any async work.
  const maxStreams = settings.get('max_streams') as number;

  try {
    const { sessionId, sdp } = await manager!.createSession(
      ctx,
      channelId,
      title,
      offerSdp,
      rtpMinPort,
      rtpMaxPort,
      maxStreams,
    );

    return new Response(sdp, {
      status: 201,
      headers: {
        'Content-Type': 'application/sdp',
        Location: `/whip/${channelId}/${sessionId}`,
      },
    });
  } catch (err) {
    ctx.error('WHIP: failed to set up stream:', err);
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    // send 503 for the stream limit error so OBS knows to back off
    const status = msg.startsWith('Stream limit') ? 503 : 500;
    return new Response(msg, { status });
  }
}

function handleWhipDelete(ctx: PluginContext, sessionId: string): Response {
  if (!manager?.has(sessionId)) {
    return new Response('Session not found', { status: 404 });
  }
  manager.remove(sessionId);
  ctx.log(`WHIP: session ${sessionId} ended by client`);
  return new Response(null, { status: 200 });
}

export function stopWhipServer(ctx: PluginContext) {
  manager?.clear();
  failedAttempts.clear();
  server?.stop();
  server = null;
  manager = null;
  ctx.log('WHIP server stopped');
}