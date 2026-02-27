/**
 * index.ts  —  sharkord-whip
 *
 * Adds a WHIP ingest endpoint to Sharkord so OBS can stream directly into
 * a voice channel. Exposes the URL + stream key via a TOPBAR_RIGHT button.
 */
import type { PluginContext } from '@sharkord/plugin-sdk';
import { startWhipServer, stopWhipServer } from './server/whip-server.ts';

const onLoad = async (ctx: PluginContext) => {
  ctx.log('sharkord-whip: loading...');

  // Just a flag to make sure the server doesnt start multiple times if someone (me) spams the start command
  // TODO: is there i nicer way to do this????
  let serverStarted = false;

  // ----------------------------------------------------------------------------
  // -------------------- Settings to register in sharkord-----------------------
  // ----------------------------------------------------------------------------
  const settings = await ctx.settings.register([
    {
      key: 'port',
      name: 'WHIP Port',
      description:
        'Port the WHIP HTTP server will listen on. Must be open in your firewall.',
      type: 'number',
      defaultValue: 8088,
    },
    {
      key: 'stream_key',
      name: 'Stream Key',
      description:
        'Set this as the Bearer Token in OBS.',
      type: 'string',
      defaultValue: 'changeme',
      sensitive: true
    },
    {
      key: 'rtp_min_port',
      name: 'RTP Min Port',
      description: 'Start of UDP/TCP port range for media. Must match your Docker -p mapping.',
      type: 'number',
      defaultValue: 40000,
    },
    {
      key: 'rtp_max_port',
      name: 'RTP Max Port',
      description: 'End of UDP/TCP port range for media. Must match your Docker -p mapping.',
      type: 'number',
      defaultValue: 40020,
    },
  ] as const);

  const whipPort = settings.get('port') as number;
  const whipKey = settings.get('stream_key') as string;
  const rtpMinPort = settings.get('rtp_min_port') as number;
  const rtpMaxPort = settings.get('rtp_max_port') as number;

  // ----------------------------------------------------------------------------
  // -------------------- Commands to register in sharkord-----------------------
  // ----------------------------------------------------------------------------
  ctx.commands.register<{ channel_id?: number }>({
    name: 'whip_info',
    description: 'Get the WHIP stream URL for a voice channel',
    args: [
      {
        name: 'channel_id',
        type: 'number',
        description:
          'Voice channel to stream into (defaults to your current voice channel)',
        required: false,
      },
    ],
    executes: async (invoker, args) => {
      const channelId = args.channel_id ?? invoker.currentVoiceChannelId;
      const { ip, announcedAddress } = ctx.actions.voice.getListenInfo();
      const host = announcedAddress ?? ip;

      if (!channelId) {
        throw new Error('Join a voice channel first, or pass a channel_id.');
      }

      return [
        '**OBS Settings → Stream → Service: WHIP**',
        `Server: \`http://${host}:${whipPort}/whip/${channelId}\``,
        `Bearer Token: \`${whipKey || '(none — no auth)'}\``,
      ].join('\n');
    },
  });


  // yes i like emojis
  ctx.commands.register({
    name: 'whip_start',
    description: 'Start the WHIP server so OBS can connect',
    executes: async () => {
      if (serverStarted) {
        return '⚠️ WHIP server is already running.';
      }
      startWhipServer(ctx, settings, rtpMinPort, rtpMaxPort);
      serverStarted = true;
      return `✅ WHIP server started on port ${whipPort} (RTP range ${rtpMinPort}-${rtpMaxPort}).`;
    },
  });

  ctx.commands.register({
    name: 'whip_stop',
    description: 'End all active WHIP streams and stop the server',
    executes: async () => {
      if (!serverStarted) {
        return '⚠️ WHIP server is not running.';
      }
      stopWhipServer(ctx);
      serverStarted = false;
      return '✅ WHIP server stopped — all streams ended.';
    },
  });

  ctx.log('sharkord-whip: Setting up UI components....');
  ctx.ui.enable();
  ctx.log('sharkord-whip: UI registered');

  ctx.log('sharkord-whip: ready ✔ (run /whip_start to begin accepting streams)');
};

const onUnload = (ctx: PluginContext) => {
  stopWhipServer(ctx);
  stopStatsServer(ctx);
  ctx.log('sharkord-whip: unloaded');
};

export { onLoad, onUnload };