# sharkord-whip

A Sharkord plugin that lets OBS stream directly into a voice channel using the [WHIP protocol](https://www.ietf.org/archive/id/draft-ietf-wish-whip-01.txt).

## Setup

### 1. Docker

Make sure to expose the WHIP port and a UDP/TCP range for media:

```bash
docker run \
  -p 4991:4991/tcp \
  -p 8088:8088/tcp \
  -p 40000-40020:40000-40020/tcp \
  -p 40000-40020:40000-40020/udp \
  -v ./data:/root/.config/sharkord \
  --name sharkord \
  sharkord/sharkord:latest
```

### 2. Firewall

```bash
sudo ufw allow 40000:40020/udp
sudo ufw allow 40000:40020/tcp
sudo ufw reload
```

### 3. Docker checksum offloading (important!)

Docker's NAT breaks UDP checksums by default, which causes ICE to silently fail. Fix it:

```bash
sudo ethtool -K docker0 tx-checksumming off
```

### 4. Plugin settings

| Setting | Description | Default |
|---------|-------------|---------|
| WHIP Port | Port for the HTTP signaling server | `8088` |
| Stream Key | Bearer token OBS sends for auth | `changeme` |
| Public URL | Your reverse proxy URL (e.g. `https://stream.example.com`) | _(empty)_ |
| RTP Min Port | Start of media port range — must match Docker `-p` | `40000` |
| RTP Max Port | End of media port range — must match Docker `-p` | `40020` |

### 5. OBS settings

Go to **Settings → Stream**:

```
Service:      WHIP
Server:       https://stream.example.com/whip/<channel_id>
Bearer Token: <your stream key>
```

Get the exact URL for your current channel with `/whip_info` in Sharkord.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/whip_start` | Start the WHIP server |
| `/whip_stop` | Stop the server and end all active streams |
| `/whip_info [channel_id]` | Show OBS connection details for a channel |

---

## Port reference

```
8088/tcp  — WHIP signaling (HTTP). OBS sends the SDP offer here.
            Safe to put behind a reverse proxy on 443.

40000-40020/tcp+udp — RTP media. The actual video and audio packets.
                      Must be open in your firewall AND forwarded in Docker.
                      UDP is used by default; TCP is a fallback.
```

---

## Troubleshooting

**Stream stays black / OBS stuck on "Connecting"**
- Check that your RTP port range is open in both UFW and Docker
- Run `sudo ethtool -K docker0 tx-checksumming off` if you haven't already
- Make sure `Public URL` in plugin settings doesn't include a trailing slash or `https://` prefix

**"Invalid SDP" error in OBS**
- Usually a fingerprint algorithm mismatch.

**"Unexpected error connecting to server"**
- OBS sends a DELETE when the stream ends. If the session was already cleaned up on our side (e.g. everyone left the channel), this 404 is harmless.

**High CPU on the server**
- Sharkord/mediasoup forwards RTP packets without transcoding, so CPU should scale with bitrate not resolution. If it's unexpectedly high, check `top` inside the container for what's actually consuming it.