# How a stream actually works

By claude (please fix, rfc referenced, did double check it tho) because my dumb ass needed some examples to understand what i was doing
---

It's Friday night. Tinkywinky (totally original character) wants to stream his gameplay into his Sharkord voice channel so his friends can watch while they hang out. He's already in the channel. His friends are already in the channel. He hits **Start Streaming** in OBS.

Here's everything that happens in the next few hundred milliseconds.

---

## Step 1 — OBS figures out what it wants to send

Before OBS sends a single byte of video, it writes a **session description** — a plain text document that says "here's what I'm capable of sending, and here's how to reach me securely."

This format is called **SDP** (Session Description Protocol). It looks like this:

```
v=0
o=- 1234567890 1 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=rtpmap:111 opus/48000/2
a=sendonly
a=setup:actpass
a=fingerprint:sha-256 AB:CD:EF:...
a=ice-ufrag:abc123
a=ice-pwd:supersecretpassword
a=rtcp-mux
m=video 9 UDP/TLS/RTP/SAVPF 96
c=IN IP4 0.0.0.0
a=rtpmap:96 H264/90000
a=fmtp:96 profile-level-id=42e01f
a=sendonly
```

Let's read it like a human:

- `m=audio 9 ...` — "I'll send audio encoded with Opus at 48kHz, stereo". The port `9` is a placeholder meaning "ignore this, use the ICE candidates instead" — it's the WebRTC convention before a real port is negotiated.
- `m=video 9 ...` — "I'll send video encoded with H264"
- `a=sendonly` — "I'm only sending, I don't want anything sent back to me" (WHIP is always one-way)
- `a=setup:actpass` — "I can go first or second in the security handshake, your call"
- `a=fingerprint:sha-256 AB:CD...` — "here's a hash of my security certificate so you can verify I'm really me"
- `a=ice-ufrag` / `a=ice-pwd` — "here's a username and password to authenticate my network packets"

OBS doesn't know where to send any of this yet. That's what the next step is for.

---

## Step 2 — OBS knocks on the WHIP endpoint

OBS sends this SDP document to Sharkord over HTTP:

```
POST https://your.whip.url/whip/3
Authorization: Bearer changeme
Content-Type: application/sdp

v=0
o=- 1234567890 ...
(the SDP from above)
```

The `/3` at the end is Tinkywinky's voice channel ID. The `Bearer changeme` is the stream key — our server checks this first before doing anything else.

On our side, `handleWhipOffer()` in `whip-server.ts` wakes up.

---

## Step 3 — Sharkord sets up the plumbing

Now the interesting stuff happens, all within a few milliseconds:

### 3a. Get the router

```typescript
const router = ctx.actions.voice.getRouter(channelId);
```

A **router** is mediasoup's representation of a voice channel's media infrastructure. Think of it as a switchboard — it knows about everyone in the channel and can route media between them. If nobody's in the channel, the router doesn't exist yet, and we send OBS a 503.

Tinkywinky's friends are already in the channel, so the router exists.

### 3b. Create a transport

```typescript
const transport = await router.createWebRtcTransport({ ... });
```

A **transport** is a network pipe — a pair of UDP/TCP sockets that can receive encrypted RTP packets from OBS. Creating one allocates a port from our range (say, port 40014), binds it, and gets it ready to receive.

This is the moment Sharkord says "I'm listening on port 40014 — OBS, send your stuff here."

### 3c. Connect the transport

```typescript
await transport.connect({ dtlsParameters: extractDtlsParameters(parsedOffer) });
```

We hand mediasoup OBS's fingerprint and DTLS role from the SDP offer. This tells mediasoup what to expect when OBS comes knocking for the security handshake later.

### 3d. Create producers

```typescript
audioProducer = await transport.produce({ kind: 'audio', rtpParameters: audioRtpParams });
videoProducer = await transport.produce({ kind: 'video', rtpParameters: videoRtpParams });
```

A **producer** represents an incoming media stream. Creating one tells mediasoup "expect Opus audio packets with these parameters" and "expect H264 video packets with these parameters." mediasoup is now ready to receive and forward them.

### 3e. Register the stream in the channel

```typescript
const streamHandle = ctx.actions.voice.createStream({
  channelId,
  title: 'OBS Stream',
  producers: { audio: audioProducer, video: videoProducer },
});
```

This is where OBS's stream actually enters the voice channel — Tinkywinky's friends can now see "OBS Stream" as a participant. Sharkord handles distributing the audio and video to everyone in the channel from here.

---

## Step 4 — Sharkord writes back

Now we build our own SDP answer — "okay, here's *our* capabilities and where to reach *us*":

```
v=0
o=- 1771584225724 1 IN IP4 127.0.0.1
s=-
t=0 0
a=ice-lite                              ← we only respond to checks, never send them
a=fingerprint:sha-256 84:C5:7F:...      ← our certificate hash
a=group:BUNDLE 0 1
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=setup:passive                         ← you go first in the security handshake
a=recvonly                              ← we only receive, we never send audio back to OBS
a=ice-ufrag:un2aql...
a=ice-pwd:gh0g0n50...
a=candidate:1 1 UDP 1076302079 your.server.url 40014 typ host
              ↑               ↑ our public hostname              ↑ the port we allocated
              priority
a=rtcp-mux
m=video 9 UDP/TLS/RTP/SAVPF 96
c=IN IP4 0.0.0.0
a=setup:passive
a=recvonly
a=candidate:1 1 UDP 1076302079 your.server.url 40014 typ host
```

The key lines:

- `a=ice-lite` — mediasoup never sends ICE checks proactively. We sit back and respond. Without this, OBS would wait forever for checks that never come.
- `a=setup:passive` — OBS goes first in the DTLS handshake. We open the door when it knocks.
- `a=recvonly` — one-way street. OBS sends, we receive. We never stream video or audio back to OBS. (RTP only though — RTCP control packets do flow both ways, see Step 7.)
- `a=candidate:...` — "you can reach us at this IP and port." This is what OBS actually connects to.
- `m=audio 9` / `m=video 9` — port 9 is the standard WebRTC placeholder meaning "ignore this port, use the ICE candidates instead." Both RFC 9725 (WHIP) and JSEP (RFC 9429) use this convention.

We send this back as a `201 Created` with a `Location` header pointing to the session URL OBS will use to end the stream later.

---

## Step 5 — ICE: finding each other on the network

OBS has our SDP answer now. It knows our IP and port. Time to confirm they can actually talk to each other.

OBS starts firing small **STUN binding requests** to our UDP port — basically "hello, is anyone there?" Each packet includes the `ice-ufrag` and `ice-pwd` from the SDP as proof it belongs to this session.

```
OBS (<obs ip>:52507) ──── STUN request (132 bytes) ────▶ your.server.url:40014
                                                                        │
                                                             mediasoup checks the
                                                             ice-ufrag/ice-pwd credentials
                                                                        │
OBS (<obs ip>:52507) ◀─── STUN response (64 bytes) ─── your.server.url:40014
```

Once OBS gets a valid response back, ICE is done. Both sides know the path works.

If this fails — wrong port, firewall blocking UDP, Docker eating the checksums — OBS retries every few seconds and eventually gives up with "PeerConnection state: Failed."

---

## Step 6 — DTLS: encrypting the pipe

With the network path confirmed, OBS initiates a **DTLS handshake** — basically TLS but designed to work over UDP. This sets up encryption for all the video and audio that's about to flow.

```
OBS ──── ClientHello ─────────────────────────────────────▶ Sharkord
         "here's my certificate"

OBS ◀─── ServerHello + Certificate ───────────────────────── Sharkord
         "here's our certificate"

         Both sides verify the other's cert fingerprint matches
         what was promised in the SDP exchange earlier.
         (This prevents anyone from intercepting and pretending to be Sharkord.)

OBS ──── Finished ────────────────────────────────────────▶ Sharkord
                              ✓ encrypted tunnel established
```

This is why the fingerprints in the SDP matter — they're how both sides confirm they're talking to the right server, not some eavesdropper in between.

---

## Step 7 — Media flows

The tunnel is up. OBS starts sending **SRTP** packets — RTP packets encrypted by the DTLS session.

One important thing first: H264 video frames are large. At 15mbit/60fps, a single average frame is around 30KB. The MTU (maximum UDP packet size) is ~1400 bytes, so each frame gets split across **many** RTP packets with incrementing sequence numbers and the same timestamp. The last packet of each frame has the marker bit set so the receiver knows the frame is complete. The actual packet rate for video is in the hundreds per second, not 60.

```
OBS ──── SRTP (H264 fragment, ~1400 bytes, seq=1001) ─────▶ mediasoup transport
OBS ──── SRTP (H264 fragment, ~1400 bytes, seq=1002) ─────▶ mediasoup transport
OBS ──── SRTP (H264 fragment, ~1400 bytes, seq=1003, M=1) ▶ mediasoup transport
         ↑ marker bit = last packet of this frame
OBS ──── SRTP (Opus audio, ~160 bytes, seq=501) ──────────▶ mediasoup transport
OBS ──── SRTP (H264 fragment, seq=1004) ──────────────────▶ mediasoup transport
... hundreds of RTP packets per second for video, ~50/sec for audio
```

RTCP control packets flow the **other direction** too. mediasoup can send OBS a PLI (Picture Loss Indication) to say "I missed some data, send a keyframe" or a NACK to ask for specific packet retransmission. OBS sends RTCP sender reports back so the server can track timing. So while media is one-way, RTCP is genuinely bidirectional.

```
OBS ◀─── RTCP PLI ("send a keyframe please") ─────────────── mediasoup
OBS ──── RTCP SR (sender report with timing info) ─────────▶ mediasoup
```

mediasoup receives each RTP packet, decrypts it, identifies it by SSRC (the stream ID from the SDP), and hands it to the producer we created in Step 3d. Sharkord then takes care of getting it to Tinkywinky's friends.

**The key thing:** mediasoup never decodes or re-encodes the video. It reads just enough of the packet header to know where it belongs, then passes the raw bytes straight through. Tinkywinky's H264 stream arrives at his friends' screens exactly as OBS encoded it. No quality loss, minimal CPU.

---

## Step 8 — Tinkywinky stops streaming

Tinkywinky hits "Stop Streaming." OBS sends:

```
DELETE https://your.whip.url/whip/3/ead3e991-7959-4ac5-b34a-8892c9392105
```

That UUID is the session ID we put in the `Location` header back in Step 4. Our server calls `cleanupSession()`:

```typescript
session.audioProducer?.close();   // stop accepting audio packets
session.videoProducer?.close();   // stop accepting video packets
session.transport.close();         // close the UDP socket, free the port
session.streamHandle.remove();     // remove "OBS Stream" from the voice channel
```

Tinkywinky's friends see the stream disappear from the channel. Port 40014 is free for the next stream.

---

## The full timeline

```
t=0ms     Tinkywinky clicks "Start Streaming"
t=1ms     OBS builds SDP offer
t=10ms    POST /whip/3 arrives at Sharkord
t=11ms    Auth check passes
t=12ms    Router found for channel 3
t=15ms    WebRtcTransport created, port 40014 allocated
t=16ms    Transport connected with OBS's DTLS params
t=18ms    Audio producer created
t=20ms    Video producer created
t=21ms    Stream registered in channel — friends see "OBS Stream" appear
t=22ms    SDP answer sent back to OBS (201 Created)
t=30ms    ICE binding requests start arriving
t=31ms    ICE complete ✓
t=80ms    DTLS handshake complete ✓
t=81ms    First video packet arrives
t=100ms   Tinkywinky's friends can see his stream
```

---

## Glossary

| Term | What it actually is |
|------|-------------------|
| **WHIP** | A standard HTTP-based protocol (RFC 9725) for pushing a WebRTC stream to a server. OBS sends an SDP offer over HTTP, gets an SDP answer back, then streams over WebRTC. Think of it as "handshake over HTTP, stream over UDP." |
| **SDP** | A plain text format for describing a media session — codecs, ports, security keys. Not a streaming protocol itself, just a negotiation document. |
| **ICE** | The process of finding a working network path between two peers. Involves sending test packets (STUN) and confirming they arrive. Handles NATs and firewalls. |
| **STUN** | Tiny test packets used during ICE to check if a network path is alive and to discover your public IP/port from behind NAT. |
| **DTLS** | Encryption for UDP (RFC 6347). Like TLS/HTTPS but designed for unreliable packets. Sets up the encrypted tunnel before media flows. |
| **SRTP** | Encrypted RTP — the actual video and audio packets once DTLS has negotiated the keys. |
| **RTP** | The packet format for real-time media (RFC 3550). Each packet has a sequence number, timestamp, and SSRC. Large frames are split across multiple packets; the receiver reassembles them using the sequence number and the marker bit on the last packet. |
| **RTCP** | Control packets that ride alongside RTP (also RFC 3550). Flows both ways — OBS sends timing info (Sender Reports), we send feedback like PLI (request a keyframe) or NACK (request a retransmit). |
| **SSRC** | A random number that identifies a specific stream. OBS has one SSRC for audio and one for video — mediasoup uses it to tell packets apart when they arrive on the same port. |
| **MID** | Media ID. A label for each `m=` section in SDP so both sides can say "the audio track" or "the video track" unambiguously. |
| **BUNDLE** | Sending all media over a single port instead of one per track (RFC 9143). Saves ports, which matters when your Docker range is only 21 ports wide. |
| **Router** | mediasoup's representation of a voice channel. Knows about all participants and routes media between them. Dies when the last person leaves. |
| **Transport** | A network connection in mediasoup. Allocates a port and handles ICE + DTLS for one peer (OBS in our case). |
| **Producer** | An incoming media stream in mediasoup. One per track — one for OBS's audio, one for OBS's video. |
| **Consumer** | An outgoing media stream in mediasoup. Sharkord creates one for each person in the channel who needs to receive Tinkywinky's stream. Our plugin doesn't create these — Sharkord handles it. |
| **ice-lite** | A simplified ICE mode (RFC 8445 §17.3) where the server only responds to checks, never sends them first. mediasoup always runs in ice-lite mode. |
| **PLI** | Picture Loss Indication — a RTCP message from server to OBS saying "I lost data, please send a full keyframe so I can resync." |
| **NACK** | Negative Acknowledgement — a RTCP message saying "I didn't receive packet #1042, please resend it." |
| **WHEP** | The other half of WHIP — a protocol for *pulling* a WebRTC stream from a server (e.g. for a web viewer). We don't implement this, but it uses the same SDP/ICE/DTLS machinery. |