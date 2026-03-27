# How a WHIP server works

By claude (rfc referenced, did double check it tho) because my dumb ass needed some examples to understand what i was doing. Hopefully useful if you want to build your own.

---

## Is this mediasoup-specific?

The **protocol** described here (WHIP, SDP, ICE, DTLS, SRTP) is completely standard. If you swapped mediasoup out for Janus, Pion, LiveKit, or Jitsi, OBS wouldn't know or care -- it just sends an SDP offer and expects an SDP answer back.

What IS mediasoup-specific is the code in this plugin: `router`, `WebRtcTransport`, `producer`. Other servers have equivalent concepts but different APIs. The mental model of "create a transport, connect it, produce from it" maps pretty cleanly to most SFUs though.

---

## What you actually need to implement

If you're building your own WHIP server, here's the minimum:

**HTTP layer:**
- `POST /whip/:roomId` -- accept an SDP offer, return an SDP answer with `201 Created` and a `Location` header
- `DELETE /whip/:roomId/:sessionId` -- tear down a session
- `OPTIONS` -- CORS preflight, OBS sends this first

**Per connection:**
1. Parse the SDP offer
2. Create a WebRTC transport on your media server (this allocates a UDP port)
3. Call `transport.connect()` with the DTLS fingerprint and role from the offer
4. Create producers for each media track (audio, video)
5. Build an SDP answer with your ICE candidates, DTLS fingerprint, and `setup:passive`
6. Return the answer

**Session cleanup:**
- When DELETE arrives
- When everyone leaves the room (router/room closes)
- When a producer dies unexpectedly

That's it. Everything below is just the detail of how each of those steps actually works.

---

## Common pitfalls

These are the things that will silently break your server and waste your afternoon:

**DTLS role confusion** -- The `role` you pass to `transport.connect()` is the *remote's* role, not yours. If OBS says `actpass` or `active`, OBS is the client (it goes first). If OBS says `passive`, OBS is the server (it waits). Get this backwards and you'll get a fatal `unexpected_message` alert within 1 second of ICE completing.

**Forgetting `ice-lite`** -- mediasoup (and most SFU servers) run in ice-lite mode, which means they only respond to ICE checks and never send their own. You must include `a=ice-lite` in your SDP answer or OBS will wait forever for checks that never come.

**Transport leaks** -- If anything throws after `createWebRtcTransport()` but before you've stored the session somewhere, you need to close the transport in the catch block. It holds a real UDP port. Without this, failed connection attempts slowly exhaust your port range.

**Docker UDP checksums** -- Docker's NAT breaks UDP checksums by default. ICE will silently fail. Run `sudo ethtool -K docker0 tx-checksumming off` on the host. It resets on reboot.

**Race condition on stream limits** -- If you enforce a max streams cap, do the check and reserve the slot before any `await` calls. Two concurrent requests can both pass a size check before either has added itself to the map.

**Re-entrant cleanup** -- mediasoup fires observer events synchronously when you close a producer or transport. If your cleanup function is triggered by those events, it can call itself recursively. Either delete the session from your map before closing anything, or use a `closed` boolean guard on the session object.

---

It's Friday night. Tinkywinky (totally original character) wants to stream his gameplay into his Sharkord voice channel so his friends can watch. He hits **Start Streaming** in OBS.

Here's everything that happens in the next few hundred milliseconds.

```
  Tinkywinky's PC                          Sharkord server
  +-----------+                            +-----------+
  |           |                            |           |
  |    OBS    |                            |  Sharkord |
  |           |   1. POST /whip/3 (SDP)   |  + media  |
  |           | -------------------------> |   soup    |
  |           |   2. 201 Created (SDP)    |           |
  |           | <------------------------ |           |
  |           |                            |           |
  |           |   3. ICE (STUN packets)   |           |
  |           | <-----------------------> |           |
  |           |                            |           |
  |           |   4. DTLS handshake       |           |
  |           | <-----------------------> |           |
  |           |                            |           |
  |           |   5. SRTP (video+audio)   |           |
  |           | -------------------------> |           |
  |           |                            |           |
  +-----------+                            +-----------+
```

---

## Step 1 - OBS figures out what it wants to send

Before OBS sends a single byte of video, it writes a **session description**: a plain text document that says "here's what I can send, and here's how to reach me securely."

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

- `m=audio 9 ...` - "I'll send audio encoded with Opus at 48kHz, stereo". The port `9` is a placeholder meaning "ignore this, use the ICE candidates instead" -- it's the WebRTC convention before a real port is negotiated.
- `m=video 9 ...` - "I'll send video encoded with H264"
- `a=sendonly` - "I'm only sending, I don't want anything back" (WHIP is always one-way)
- `a=setup:actpass` - "I can go first or second in the security handshake, your call"
- `a=fingerprint:sha-256 AB:CD...` - "here's a hash of my security certificate so you can verify it's really me"
- `a=ice-ufrag` / `a=ice-pwd` - "here's a username and password to authenticate my network packets"

OBS doesn't know where to send any of this yet. That's what the next step is for.

---

## Step 2 - OBS knocks on the WHIP endpoint

OBS sends the SDP document to Sharkord over plain HTTP:

```
POST https://your.whip.url/whip/3
Authorization: Bearer changeme
Content-Type: application/sdp

v=0
o=- 1234567890 ...
(the SDP from above)
```

The `/3` at the end is Tinkywinky's voice channel ID. The `Bearer changeme` is the stream key -- our server checks this before doing anything else.

On our side, `handleWhipOffer()` in `whip-server.ts` wakes up and hands off to `WhipSessionManager.createSession()` in `session-manager.ts`.

---

## Step 3 - Sharkord sets up the plumbing

Now the interesting stuff happens, all within a few milliseconds.

```
  WhipSessionManager.createSession()
       |
       +--> check max streams + reserve slot  <-- do this BEFORE any awaits
       |
       +--> getRouter(channelId)              <-- does the voice channel exist?
       |
       +--> createWebRtcTransport()           <-- allocate a port (e.g. 40014)
       |
       +--> transport.connect()              <-- tell mediasoup about OBS's DTLS cert
       |
       +--> transport.produce('audio')       <-- ready to receive Opus
       +--> transport.produce('video')       <-- ready to receive H264
       |
       +--> createStream()                   <-- "OBS Stream" appears in the channel
       |
       +--> set up cleanup listeners         <-- router close, producer close
       |
       +--> buildSdpAnswer()                 <-- tell OBS where to connect
       |
       +--> 201 Created
```

### 3a. Get the router

```typescript
const router = ctx.actions.voice.getRouter(channelId);
```

A **router** is mediasoup's representation of a voice channel's media infrastructure. Think of it as a switchboard that knows about everyone in the channel and can route media between them. If nobody's in the channel, the router doesn't exist yet and we send OBS a 503.

In your own server this would be whatever your media server calls a room, conference, or session.

### 3b. Create a transport

```typescript
const transport = await router.createWebRtcTransport({ ... });
```

A **transport** is a network pipe: a pair of UDP/TCP sockets that can receive encrypted RTP packets from OBS. Creating one allocates a port from our range (say, port 40014), binds it, and gets it ready to receive.

This is the moment Sharkord says "I'm listening on port 40014, OBS, send your stuff here."

### 3c. Connect the transport

```typescript
await transport.connect({ dtlsParameters: extractDtlsParameters(parsedOffer) });
```

We hand mediasoup OBS's fingerprint and DTLS role from the SDP offer. This tells mediasoup what to expect when OBS comes knocking for the security handshake later.

Note: see the pitfalls section above about getting the role right. It's the remote's role, not ours.

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
  title,
  key: sessionId,
  producers: { audio: audioProducer, video: videoProducer },
});
```

This is Sharkord-specific. In your own server this is where you'd wire the producers up to your room so other participants can consume the stream.

---

## Step 4 - Sharkord writes back

Now we build our own SDP answer: "okay, here's our capabilities and where to reach us":

```
v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
a=ice-lite                              <- we only respond to checks, never send them
a=fingerprint:sha-256 84:C5:7F:...      <- our certificate hash
a=group:BUNDLE 0 1
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=setup:passive                         <- you go first in the security handshake
a=recvonly                              <- we only receive, never send audio back to OBS
a=ice-ufrag:un2aql...
a=ice-pwd:gh0g0n50...
a=candidate:1 1 UDP 1076302079 your.server.url 40014 typ host
              ^               ^ our public hostname         ^ the port we allocated
              priority
a=rtcp-mux
m=video 9 UDP/TLS/RTP/SAVPF 96
c=IN IP4 0.0.0.0
a=setup:passive
a=recvonly
a=candidate:1 1 UDP 1076302079 your.server.url 40014 typ host
```

The key lines:

- `a=ice-lite` - mediasoup never sends ICE checks proactively. We sit back and respond. Without this, OBS would wait forever for checks that never come.
- `a=setup:passive` - OBS goes first in the DTLS handshake. We open the door when it knocks.
- `a=recvonly` - one-way street. OBS sends, we receive. We never stream video or audio back to OBS. (RTP only though -- RTCP control packets flow both ways, see step 7.)
- `a=candidate:...` - "you can reach us at this IP and port." This is what OBS actually connects to.
- `m=audio 9` / `m=video 9` - port 9 is the standard WebRTC placeholder meaning "ignore this, use the ICE candidates instead." Both RFC 9725 (WHIP) and RFC 9429 (JSEP) use this convention.

We send this back as a `201 Created` with a `Location` header pointing to the session URL OBS will use to end the stream later.

---

## Step 5 - ICE: finding each other on the network

OBS has our SDP answer now. It knows our IP and port. Time to confirm they can actually talk to each other.

OBS starts firing small **STUN binding requests** to our UDP port: basically "hello, is anyone there?" Each packet includes the `ice-ufrag` and `ice-pwd` from the SDP as proof it belongs to this session.

```
  OBS                                        Sharkord:40014
  |                                               |
  |  STUN request (132 bytes)                     |
  |  [ice-ufrag + ice-pwd inside]                 |
  | --------------------------------------------> |
  |                                               |
  |                          check credentials... |
  |                                               |
  |            STUN response (64 bytes)           |
  | <-------------------------------------------- |
  |                                               |
  |            ICE done, path confirmed           |
```

If this fails (wrong port, firewall blocking UDP, Docker eating the packets), OBS retries every few seconds and eventually gives up with "PeerConnection state: Failed."

---

## Step 6 - DTLS: encrypting the pipe

With the network path confirmed, OBS initiates a **DTLS handshake**: basically TLS but designed to work over UDP. This sets up encryption for all the video and audio that's about to flow.

```
  OBS                                        Sharkord
  |                                               |
  |  ClientHello                                  |
  |  "here's my cert + cipher prefs"             |
  | --------------------------------------------> |
  |                                               |
  |  ServerHello + Certificate + HelloDone        |
  |  "here's our cert, let's use this cipher"    |
  | <-------------------------------------------- |
  |                                               |
  |  Certificate + CertificateVerify             |
  | --------------------------------------------> |
  |                                               |
  |      both sides check the other's cert       |
  |      fingerprint against what was in the SDP |
  |      if they don't match: fatal alert, done  |
  |                                               |
  |  ChangeCipherSpec + Finished                  |
  | --------------------------------------------> |
  |                                               |
  |            ChangeCipherSpec + Finished        |
  | <-------------------------------------------- |
  |                                               |
  |         encrypted tunnel established          |
```

Our SDP answer says `setup:passive`, which means OBS must send the first ClientHello. If this is misconfigured (both sides think the other should go first), OBS sends a fatal alert: `unexpected_message` (code 10) and the connection dies in under a second.

The `role` field we pass to `transport.connect()` is the *remote's* role. Passing `'client'` means "OBS initiates", which is what we want.

This is why the fingerprints in the SDP matter -- they're how both sides confirm they're talking to the right server and not some eavesdropper in between.

---

## Step 7 - Media flows

The tunnel is up. OBS starts sending **SRTP** packets: RTP packets encrypted by the DTLS session.

One thing worth knowing: H264 video frames are large. At 15mbit/60fps, a single average frame is around 30KB. The MTU (maximum UDP packet size) is about 1400 bytes, so each frame gets split across many RTP packets with incrementing sequence numbers and the same timestamp. The last packet of each frame has the marker bit set so the receiver knows the frame is complete. The actual packet rate for video is in the hundreds per second, not 60.

```
  OBS                                        Sharkord:40014
  |                                               |
  |  SRTP [H264 fragment seq=1001 ts=900000]      |
  | --------------------------------------------> |
  |  SRTP [H264 fragment seq=1002 ts=900000]      |
  | --------------------------------------------> |
  |  SRTP [H264 fragment seq=1003 ts=900000 M=1]  |  <- M=1 means last packet of frame
  | --------------------------------------------> |
  |  SRTP [Opus audio   seq=501  ts=48000  ]      |
  | --------------------------------------------> |
  |  ... hundreds of packets per second ...        |
  |                                               |
  |           RTCP PLI (send a keyframe)          |  <- control packets go both ways
  | <-------------------------------------------- |
  |  RTCP SR (sender report)                      |
  | --------------------------------------------> |
```

mediasoup receives each RTP packet, decrypts it, identifies it by SSRC (the stream ID from the SDP), and hands it to the producer we created in step 3d. Sharkord then takes care of getting it to Tinkywinky's friends.

**The key thing:** mediasoup never decodes or re-encodes the video. It reads just enough of the packet header to know where it belongs, then passes the raw bytes straight through. No quality loss, minimal CPU.

---

## Step 8 - Tinkywinky stops streaming

Tinkywinky hits "Stop Streaming." OBS sends:

```
DELETE https://your.whip.url/whip/3/ead3e991-7959-4ac5-b34a-8892c9392105
```

That UUID is the session ID we put in the `Location` header back in step 4. Our server calls `session.close()` in `WhipSession`:

```typescript
public close() {
  if (this.closed) return; // guard against re-entrant calls
  this.closed = true;
  try {
    this.audioProducer?.close();  // stop accepting audio packets
    this.videoProducer?.close();  // stop accepting video packets
    this.transport.close();        // close the UDP socket, free the port
    this.streamHandle.remove();    // remove the stream from the voice channel
  } finally {
    this.onCleanup(this.id);       // remove from the session map
  }
}
```

The `closed` guard is important -- mediasoup fires observer events synchronously when you close a producer, which would re-enter `close()` before it finishes. Without the guard it runs multiple times and `streamHandle.remove()` gets called twice.

Tinkywinky's friends see the stream disappear from the channel. Port 40014 is free for the next stream.

---

## The full timeline

```
  t=0ms    Tinkywinky clicks "Start Streaming"
  t=1ms    OBS builds SDP offer
           |
  t=10ms   POST /whip/3 arrives at Sharkord
  t=11ms   auth check passes
  t=12ms   slot reserved in session map
  t=13ms   router found for channel 3
  t=15ms   WebRtcTransport created, port 40014 allocated
  t=16ms   transport connected with OBS's DTLS params
  t=18ms   audio producer created
  t=20ms   video producer created
  t=21ms   stream registered -- friends see "OBS Stream" appear
  t=22ms   SDP answer sent back to OBS (201 Created)
           |
  t=30ms   ICE binding requests start arriving
  t=31ms   ICE complete
           |
  t=80ms   DTLS handshake complete
           |
  t=81ms   first video packet arrives
  t=100ms  Tinkywinky's friends can see his stream
```

---

## Glossary

| Term | What it actually is |
|------|-------------------|
| **WHIP** | A standard HTTP-based protocol (RFC 9725) for pushing a WebRTC stream to a server. OBS sends an SDP offer over HTTP, gets an SDP answer back, then streams over WebRTC. Handshake over HTTP, stream over UDP. |
| **SDP** | A plain text format for describing a media session: codecs, ports, security keys. Not a streaming protocol itself, just a negotiation document. |
| **ICE** | The process of finding a working network path between two peers. Involves sending test packets and confirming they arrive. Handles NATs and firewalls. |
| **STUN** | Tiny test packets used during ICE to check if a network path is alive and to discover your public IP/port from behind NAT. |
| **DTLS** | Encryption for UDP (RFC 6347). Like TLS but designed for unreliable packets. Sets up the encrypted tunnel before media flows. The `setup` attribute in SDP controls who sends the first ClientHello -- `passive` means we wait for OBS to go first. |
| **SRTP** | Encrypted RTP: the actual video and audio packets after DTLS has negotiated the keys. |
| **RTP** | The packet format for real-time media (RFC 3550). Each packet has a sequence number, timestamp, and SSRC. Large frames are split across multiple packets and reassembled using the sequence number and the marker bit on the last packet. |
| **RTCP** | Control packets that ride alongside RTP (also RFC 3550). Flows both ways: OBS sends timing info (Sender Reports), we send feedback like PLI (request a keyframe) or NACK (request a retransmit). |
| **SSRC** | A random number that identifies a specific stream. OBS has one SSRC for audio and one for video -- mediasoup uses it to tell packets apart when they arrive on the same port. |
| **MID** | Media ID. A label for each `m=` section in SDP so both sides can refer to "the audio track" or "the video track" unambiguously. |
| **BUNDLE** | Sending all media over a single port instead of one per track (RFC 9143). Saves ports, which matters when your Docker range is only 21 ports wide. |
| **SFU** | Selective Forwarding Unit. A media server that receives streams and forwards them to participants without decoding. mediasoup, Janus, Pion, and LiveKit are all SFUs. |
| **Router** | mediasoup's name for a room or conference. Knows about all participants and routes media between them. Dies when the last person leaves. |
| **Transport** | A network connection in mediasoup -- allocates a port and handles ICE + DTLS for one peer. Janus calls this a "handle", Pion calls it a "PeerConnection". |
| **Producer** | An incoming media stream in mediasoup. One per track: one for OBS's audio, one for OBS's video. |
| **Consumer** | An outgoing media stream in mediasoup. Sharkord creates one for each person in the channel who needs to receive the stream. Our plugin doesn't create these, Sharkord handles it. |
| **ice-lite** | A simplified ICE mode (RFC 8445) where the server only responds to checks and never sends them first. mediasoup always runs in ice-lite mode. |
| **PLI** | Picture Loss Indication: a RTCP message from the server to OBS saying "I lost some data, please send a full keyframe so I can resync." |
| **NACK** | Negative Acknowledgement: a RTCP message saying "I didn't receive packet #1042, please resend it." |
| **WHEP** | The other half of WHIP: a protocol for pulling a WebRTC stream from a server (for a web viewer for example). We don't implement this, but it uses the same SDP/ICE/DTLS machinery. |