> ⚠️⚠️⚠️⚠️ **Use at your own risk!!** I do not claim to be an expert on video streaming/security. And yes i had to consult claude a number of times to get a handle on all the protocol stuff. Feedback is very welcome and of course you can create pull requests.

> Doesnt really work in Firefox for some reason...

# sharkord-whip

A [Sharkord](https://github.com/Sharkord/sharkord) plugin that lets OBS stream directly into a voice channel using the [WHIP protocol](https://www.rfc-editor.org/rfc/rfc9725).

## Installation

To install. Follow [THESE](https://sharkord.com/docs/plugins/installation) steps :).

or.

1. Download the latest release from the [Releases](https://github.com/remynaps/sharkord-whip-plugin/releases) page.
2. Move the `sharkord-whip-plugin` folder to your Sharkord plugins directory, typically located at `~/.config/sharkord/plugins`.


## Setup

### 1. Docker

Expose the WHIP port and a UDP/TCP range for media:

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

### 3. Docker checksum offloading. Only for docker of course.

Docker's NAT breaks UDP checksums by default, which causes ICE to silently fail. Fix it:

```bash
sudo ethtool -K docker0 tx-checksumming off
```

> ⚠️ **This resets on every reboot.** Add it to `/etc/rc.local` or a systemd service to make it stick. If streaming suddenly stops working after a server restart, this is probably why.

### 4. Plugin settings

| Setting | Description | Default |
|---------|-------------|---------|
| WHIP Port | Port for the HTTP signaling server | `8088` |
| Stream Key | Bearer token OBS sends for auth | `changeme` |
| Public URL | Your reverse proxy URL (e.g. `https://stream.example.com`) | _(empty)_ |
| RTP Min Port | Start of media port range, must match Docker `-p` | `40000` |
| RTP Max Port | End of media port range, must match Docker `-p` | `40020` |

### 5. OBS settings

Go to **Settings -> Stream**:

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
8088/tcp            WHIP signaling (HTTP). OBS sends the SDP offer here.
                    Fine to put behind a reverse proxy on 443.

40000-40020/tcp+udp RTP media. The actual video and audio packets.
                    Needs to be open in your firewall and forwarded in Docker.
                    UDP is used by default, TCP is a fallback.
```

---

## Troubleshooting

**Stream stays on "Connecting" for a few seconds then fails**

Check that your RTP port range is open in both UFW and Docker. Also run `sudo ethtool -K docker0 tx-checksumming off` and check if the server was rebooted recently since that resets it.

**DTLS fails within 1 second of ICE connecting**

This is an active rejection, not a timeout. Usually a certificate mismatch. Try restarting the Sharkord container to get a fresh cert, then restart OBS fully before trying again (don't just stop/start streaming, OBS caches the remote cert).

**"Invalid SDP" or OBS rejects the connection immediately**

Usually an OBS version thing. Update to the latest release.

**OBS sends DELETE and gets a 404**

Harmless. OBS sends DELETE when you stop streaming. If the session was already cleaned up on our side (everyone left the channel) the 404 is expected.

**High CPU**

mediasoup just forwards RTP packets without transcoding so CPU scales with bitrate not resolution. If it's higher than expected, check `top` inside the container to see what's actually eating it.
