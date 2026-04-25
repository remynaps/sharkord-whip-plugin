> [!CAUTION]
> This plugin is in alpha. Expect bugs everywhere!

<div align="center">
  <h1>Sharkord-WHIP</h1>
  <p><strong>A Sharkord plugin that lets OBS stream directly into a voice channel using the WHIP protocol.</strong></p>
      <img src="./media/no-stream.gif" width="600" height="200" />

[![Version](https://img.shields.io/github/v/release/remynaps/sharkord-whip-plugin)](https://github.com/remynaps/sharkord-whip-plugin/releases)
[![Downloads](https://img.shields.io/github/downloads/remynaps/sharkord-whip-plugin/total)](https://github.com/remynaps/sharkord-whip-plugin/releases)
[![Last Commit](https://img.shields.io/github/last-commit/remynaps/sharkord-whip-plugin)](https://github.com/remynaps/sharkord-whip-plugin/commits)
</div>

A [Sharkord](https://github.com/Sharkord/sharkord) plugin that lets OBS stream directly into a voice channel using the [WHIP protocol](https://www.rfc-editor.org/rfc/rfc9725).

> [!NOTE]
> If you want to understand how this works under the hood, or you're thinking about writing your own WHIP server, check out [how-a-stream-works.md](./how-a-stream-works.md). It walks through the full SDP/ICE/DTLS/SRTP flow with ASCII diagrams, common pitfalls, and a glossary.
> ❤️

## Installation

Follow [THESE](https://sharkord.com/docs/plugins/installation) steps :).

or:

1. Download the latest release from the [Releases](https://github.com/remynaps/sharkord-whip-plugin/releases) page.
2. Move the `sharkord-whip-plugin` folder to your Sharkord plugins directory, typically `~/.config/sharkord/plugins`.

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

### 3. Docker checksum offloading (Docker only)

Docker's NAT breaks UDP checksums by default, which causes ICE to silently fail. Fix it:

```bash
sudo ethtool -K docker0 tx-checksumming off
```

> ⚠️ **This resets on every reboot.** Add it to `/etc/rc.local` or a systemd service to make it stick. If streaming suddenly stops working after a server restart, this is probably why.

### 4. Plugin settings

| Setting | Description | Default |
| --- | --- | --- |
| WHIP Port | Port for the HTTP signaling server | `8088` |
| Stream Key | Bearer token OBS sends for auth | `changeme` |
| RTP Min Port | Start of media port range, must match Docker `-p` | `40000` |
| RTP Max Port | End of media port range, must match Docker `-p` | `40020` |
| Max Concurrent Streams | Max simultaneous OBS streams. 0 = unlimited | `5` |
| Stream Name | Default stream name shown in the channel | `OBS Stream` |
| Show stream stats panel | Show the stream stats button in the topbar while in a voice channel | `false` |
| Show OBS controls | Show the Go Live button in the Sharkord topbar | `false` |
| Server URL | Base URL OBS can reach this server at (e.g. `http://192.168.1.10:8088`). Used when auto-configuring OBS. | `http://localhost:8088` |
| OBS WebSocket password | Password for OBS WebSocket (port 4455). Leave empty if auth is disabled in OBS. | _(empty)_ |

### 5. OBS setup

There are two ways to set up OBS. The easy way uses the built-in controls.

**Easy way (recommended)**

1. Enable **Show OBS controls** in the plugin settings.
2. In OBS, go to **Tools > obs-websocket Settings** and make sure it's enabled. If you set a password, add it to the plugin settings too.
3. Set the **Server URL** to the address OBS can reach your Sharkord server at. If OBS and Sharkord are on the same machine you can leave it as `http://localhost:8088`.
4. A cast icon will appear in the Sharkord topbar. Click it and hit **Set up OBS**.
5. Pick your resolution, frame rate, and encoder. Click **Set up** and the plugin will create a `Sharkord` profile in OBS with all the right settings.

That's it. From now on you just join a voice channel and click **Go Live**.

> [!NOTE]
> WHIP uses WebRTC which only supports Opus audio. After running setup, go into OBS under the Sharkord profile and make sure your audio track is set to Opus. AAC will not work and will produce garbled audio. I couldn't find a reliable way to set this automatically.

**Manual way**

If you prefer to configure OBS yourself, go to **Settings -> Stream**:

```
Service:      WHIP
Server:       http://your-server:8088/whip/<channel_id>
Bearer Token: <your stream key>
```

Get the exact URL for your current channel with `/whip_info` in Sharkord.

You can set a custom stream name by appending `?title=` to the server URL:

```
http://your-server:8088/whip/3?title=My%20Stream
```

---

## OBS controls

When **Show OBS controls** is enabled, a cast icon appears in the Sharkord topbar. Clicking it opens a small panel showing the OBS connection status and a **Go Live** button.

- The plugin connects to OBS via WebSocket on `localhost:4455` when you open the panel.
- Clicking **Go Live** switches OBS to the Sharkord profile, sets the WHIP URL for the current voice channel, and starts the stream.
- When you click **Stop**, OBS stops the stream and switches back to whatever profile you had before.
- While live, the panel shows how long you've been streaming and your dropped frame percentage.

---

## Commands

| Command | What it does |
| --- | --- |
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

This is an active rejection, not a timeout. Usually a certificate mismatch. Try restarting the Sharkord container to get a fresh cert, then restart OBS fully before trying again -- don't just stop/start streaming, OBS caches the remote cert.

**"Invalid SDP" or OBS rejects the connection immediately**

Usually an OBS version issue. Update to the latest release.

**OBS sends DELETE and gets a 404**

Expected behaviour. OBS sends DELETE when you stop streaming, but if everyone left the voice channel before you stopped streaming, the session was already cleaned up on our side. Nothing to worry about.

**"Stream limit reached" in OBS**

The max concurrent streams limit was hit. Either stop an existing stream first or increase the limit in plugin settings. Set it to `0` to disable the limit entirely.

**High CPU**

mediasoup forwards RTP packets without transcoding so CPU scales with bitrate not resolution. If it's higher than expected, check `top` inside the container to see what's actually eating it.

**OBS panel shows "no connection"**

Make sure OBS is running and obs-websocket is enabled under **Tools > obs-websocket Settings**. The plugin connects to `localhost:4455` when you open the panel. If you set a password in OBS, add it to the plugin settings.

**Go Live button is greyed out**

You need to be in a voice channel first. Join one and the button will become clickable.

**Audio is garbled after going live**

WHIP uses WebRTC which requires Opus audio. Open OBS, switch to the Sharkord profile, and change the audio encoder to Opus. AAC won't work with WHIP.
