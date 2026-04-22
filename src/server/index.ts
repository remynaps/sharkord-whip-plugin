import type { Actions } from "../contracts/Actions.ts";
import type { Commands } from "../contracts/Commands.ts";
import { startWhipServer, stopWhipServer } from "../server/whip-server.ts";
import {
  createRegisterAction,
  createRegisterCommand,
  type PluginContext,
  type UnloadPluginContext,
} from "@sharkord/plugin-sdk";
class WhipServerManager {
  private serverRunning = false;

  public canStart(): boolean {
    return !this.serverRunning;
  }

  public async start(
    ctx: PluginContext,
    settings: any,
    rtpMinPort: number,
    rtpMaxPort: number,
  ): Promise<string> {
    if (this.canStart()) {
      startWhipServer(ctx, settings, rtpMinPort, rtpMaxPort);
      this.serverRunning = true;
      return `✅ WHIP server started on port ${settings.get("port")} (RTP range ${rtpMinPort}-${rtpMaxPort}).`;
    } else {
      return "⚠️ WHIP server is already running.";
    }
  }

  public async stop(ctx: PluginContext): Promise<string> {
    if (this.serverRunning) {
      stopWhipServer(ctx);
      this.serverRunning = false;
      return "✅ WHIP server stopped";
    } else {
      return "⚠️ WHIP server is not running.";
    }
  }

  public getIsRunning(): boolean {
    return this.serverRunning;
  }
}

const onLoad = async (ctx: PluginContext) => {
  ctx.log("sharkord-whip: loading...");

  // ----------------------------------------------------------------------------
  // Settings to register in sharkord
  // ----------------------------------------------------------------------------
  const settings = await ctx.settings.register([
    {
      key: "port",
      name: "WHIP Port",
      description:
        "Port the WHIP HTTP server will listen on. Must be open in your firewall.",
      type: "number",
      defaultValue: 8088,
    },
    {
      key: "stream_key",
      name: "Stream Key",
      description: "Set this as the Bearer Token in OBS.",
      type: "string",
      defaultValue: "changeme",
    },
    {
      key: "rtp_min_port",
      name: "RTP Min Port",
      description:
        "Start of UDP/TCP port range for media. Must match your Docker -p mapping.",
      type: "number",
      defaultValue: 40000,
    },
    {
      key: "rtp_max_port",
      name: "RTP Max Port",
      description:
        "End of UDP/TCP port range for media. Must match your Docker -p mapping.",
      type: "number",
      defaultValue: 40020,
    },
    {
      key: "max_streams",
      name: "Max Concurrent Streams",
      description:
        "Maximum number of simultaneous OBS streams allowed. 0 = unlimited.",
      type: "number",
      defaultValue: 5,
    },
    {
      key: "stream_name",
      name: "Default stream name",
      description: "The default name for a stream appearing in the ui",
      type: "string",
      defaultValue: "OBS stream",
    },
  ] as const);

  const rtpMinPort = settings.get("rtp_min_port") as number;
  const rtpMaxPort = settings.get("rtp_max_port") as number;

  const registerAction = createRegisterAction<Actions>(ctx);
  const registerCommand = createRegisterCommand<Commands>(ctx);

  const whipServerManager = new WhipServerManager();

  registerCommand(
    "whip_start",
    {
      description: "Start the WHIP server so OBS can connect",
    },
    async () => {
      return await whipServerManager.start(
        ctx,
        settings,
        rtpMinPort,
        rtpMaxPort,
      );
    },
  );

  registerCommand(
    "whip_stop",
    {
      description: "End all active WHIP streams and stop the server",
    },
    async () => {
      return await whipServerManager.stop(ctx);
    },
  );

  ctx.log(
    "sharkord-whip: ready ✔ (run /whip_start to begin accepting streams)",
  );
};

const onUnload = (ctx: UnloadPluginContext) => {
  stopWhipServer(ctx);
  ctx.log("sharkord-whip: unloaded");
};

export { onLoad, onUnload };
