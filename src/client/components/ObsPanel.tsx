import { memo, useEffect, useState } from "react";
import { Cast, Radio } from "lucide-react";
import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
} from "@sharkord/ui";
import { useCallAction, useCurrentVoiceChannel, useCurrentVoiceChannelId } from "../store/hooks";
import { useObs } from "../hooks/useObs";
import { ObsSetupModal } from "./ObsSetupModal";

const ObsPanel = memo(({ obsPassword, serverUrl, streamKey }: { obsPassword: string; serverUrl: string; streamKey: string }) => {
  const [open, setOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const currentVoiceChannel = useCurrentVoiceChannel();
  const obs = useObs(obsPassword, everOpened);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon">
            {obs.streaming ? <Radio className="h-4 w-4 text-red-500" /> : <Cast className="h-4 w-4" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {obs.status === "disconnected" ? (
                <Badge className="bg-muted text-muted-foreground border-border font-normal">OBS · no connection</Badge>
              ) : obs.status === "connecting" ? (
                <Badge className="bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/20 font-normal">
                  <span className="h-1.5 w-1.5 rounded-full bg-yellow-500 animate-pulse shrink-0 mr-1" />
                  OBS · connecting…
                </Badge>
              ) : (
                <Badge className={obs.streaming ? "bg-red-500/15 text-red-400 border-red-500/20 font-normal gap-1.5" : "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/20 font-normal"}>
                  {obs.streaming && <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />}
                  OBS{obs.streaming ? " · live" : " · connected"}
                </Badge>
              )}
            </div>
            {obs.status === "connected" && (
              obs.streaming ? (
                <Button size="sm" variant="destructive" onClick={() => obs.stopStream()}>Stop</Button>
              ) : obs.hasSharkordProfile ? (
                <Button
                  size="sm"
                  disabled={!currentVoiceChannelId}
                  onClick={() => currentVoiceChannelId && obs.goLive(`${serverUrl}/whip/${currentVoiceChannelId}`, streamKey)}
                  className="gap-1.5 bg-green-500/15 text-green-400 hover:bg-green-500/25 hover:text-green-300 border-0"
                >
                  Go Live
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setSetupOpen(true)}>Set up OBS</Button>
              )
            )}
          </div>
          {obs.status === "connected" && obs.hasSharkordProfile && (
            <>
              <Separator />
              <p className="text-xs text-muted-foreground">
                {currentVoiceChannel ? <>Streaming to <span className="font-medium text-foreground"># {currentVoiceChannel.name}</span></> : "Join a voice channel to go live."}
              </p>
            </>
          )}
          {obs.streaming && obs.streamInfo && (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-green-400 font-mono font-medium">{obs.streamInfo.duration}</span>
              <span className={obs.streamInfo.droppedFrames < 1 ? "text-muted-foreground" : obs.streamInfo.droppedFrames < 5 ? "text-yellow-400" : "text-red-400"}>
                {obs.streamInfo.droppedFrames < 0.05 ? "no dropped frames" : `${obs.streamInfo.droppedFrames.toFixed(1)}% dropped`}
              </span>
            </div>
          )}
        </PopoverContent>
      </Popover>
      <ObsSetupModal
        open={setupOpen}
        onOpenChange={setSetupOpen}
        serverUrl={serverUrl}
        onSetup={(settings) => obs.setupProfile(settings)}
      />
    </>
  );
});

const ObsPanelGuard = memo(() => {
  const [clientSettings, setClientSettings] = useState<{
    showObsControls: boolean;
    obsWebsocketPassword: string;
    serverUrl: string;
    streamKey: string;
  } | null>(null);
  const callAction = useCallAction();

  useEffect(() => {
    callAction("get_client_settings").then(setClientSettings);
  }, []);

  if (!clientSettings?.showObsControls) return null;
  return (
    <ObsPanel
      obsPassword={clientSettings.obsWebsocketPassword}
      serverUrl={clientSettings.serverUrl}
      streamKey={clientSettings.streamKey}
    />
  );
});

export { ObsPanelGuard as ObsPanel };
