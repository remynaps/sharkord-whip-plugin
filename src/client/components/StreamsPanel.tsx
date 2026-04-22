import { memo, useEffect, useState } from "react";
import { Tv, Video, Mic } from "lucide-react";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
} from "@sharkord/ui";
import { useCallAction, useCurrentVoiceChannelId } from "../store/hooks";
import type { Actions } from "../../contracts/Actions";
import type { StreamStats } from "../../contracts/StreamStats";

type Session = Actions["list_sessions"]["response"][number];

const formatBitrate = (bps: number) => {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} Kbps`;
  return `${bps} bps`;
};


const lossColor = (fraction: number) => {
  if (fraction < 0.01) return "text-green-500";
  if (fraction < 0.05) return "text-yellow-500";
  return "text-red-500";
};

const connectionColor = (state: string) =>
  state === "connected" ? "text-green-500"
  : state === "new" || state === "connecting" ? "text-yellow-500"
  : "text-red-500";

const LiveDot = ({ size = "md" }: { size?: "sm" | "md" }) => (
  <span className={`inline-flex rounded-full bg-red-500 animate-pulse shrink-0 ${size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2"}`} />
);

const scoreEmoji = (score: number) =>
  score >= 8 ? "🟢" : score >= 5 ? "🟡" : "🔴";

const StatsSkeleton = () => (
  <div className="flex flex-col gap-2 animate-pulse">
    {[80, 60, 90, 70].map((w, i) => (
      <div key={i} className="h-3 bg-muted rounded" style={{ width: `${w}%` }} />
    ))}
  </div>
);

const StatsView = ({
  stats,
  title,
  onBack,
}: {
  stats: StreamStats | null;
  title: string;
  onBack?: () => void;
}) => (
  <div className="flex flex-col gap-3">
    <div className="flex items-center gap-2">
      {onBack && (
        <button
          onClick={onBack}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          ← back
        </button>
      )}
      <span className="font-medium text-sm truncate flex-1">{title}</span>
      <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
        <LiveDot size="sm" />
        live
      </div>
    </div>

    {!stats ? (
      <StatsSkeleton />
    ) : (
      <>
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Connection
          </p>
          <div className="grid grid-cols-2 items-center gap-x-4 gap-y-1.5 text-xs">
            <span className="text-muted-foreground">Bitrate</span>
            <span className="tabular-nums font-medium">
              {formatBitrate(stats.transport.recvBitrate)}
            </span>
            <span className="text-muted-foreground">ICE</span>
            <span className={`font-medium ${connectionColor(stats.transport.iceState)}`}>
              {stats.transport.iceState}
            </span>
            <span className="text-muted-foreground">DTLS</span>
            <span className={`font-medium ${connectionColor(stats.transport.dtlsState)}`}>
              {stats.transport.dtlsState}
            </span>
          </div>
        </div>

        {stats.video && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Video className="h-3 w-3" />
                Video
                <span className="normal-case font-normal text-muted-foreground/60">
                  {stats.video.mimeType.replace("video/", "")}
                </span>
              </p>
              <div className="grid grid-cols-2 items-center gap-x-4 gap-y-1.5 text-xs">
                <span className="text-muted-foreground">Bitrate</span>
                <span className="tabular-nums font-medium">
                  {formatBitrate(stats.video.bitrate)}
                </span>
                <span className="text-muted-foreground">Packet loss</span>
                <span className={`tabular-nums font-medium ${lossColor(stats.video.fractionLost)}`}>
                  {(stats.video.fractionLost * 100).toFixed(1)}%
                </span>
                <span className="text-muted-foreground">Quality</span>
                <span>{scoreEmoji(stats.video.score)}</span>
                <span className="text-muted-foreground">PLI / NACK</span>
                <span className="tabular-nums text-muted-foreground">
                  {stats.video.pliCount} / {stats.video.nackCount}
                </span>
              </div>
            </div>
          </>
        )}

        {stats.audio && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Mic className="h-3 w-3" />
                Audio
                <span className="normal-case font-normal text-muted-foreground/60">
                  {stats.audio.mimeType.replace("audio/", "")}
                </span>
              </p>
              <div className="grid grid-cols-2 items-center gap-x-4 gap-y-1.5 text-xs">
                <span className="text-muted-foreground">Bitrate</span>
                <span className="tabular-nums font-medium">
                  {formatBitrate(stats.audio.bitrate)}
                </span>
                <span className="text-muted-foreground">Jitter</span>
                <span className="tabular-nums font-medium">
                  {stats.audio.jitter.toFixed(2)} ms
                </span>
                <span className="text-muted-foreground">Packet loss</span>
                <span className={`tabular-nums font-medium ${lossColor(stats.audio.fractionLost)}`}>
                  {(stats.audio.fractionLost * 100).toFixed(1)}%
                </span>
                <span className="text-muted-foreground">Quality</span>
                <span>{scoreEmoji(stats.audio.score)}</span>
              </div>
            </div>
          </>
        )}
      </>
    )}
  </div>
);

const StreamsPanel = memo(() => {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const callAction = useCallAction();

  const channelSessions = sessions.filter(
    (s) => currentVoiceChannelId == null || s.channelId === currentVoiceChannelId,
  );

  useEffect(() => {
    if (!open) {
      setSessions([]);
      setSelectedId(null);
      setStats(null);
      return;
    }

    const refresh = (autoSelect: boolean) =>
      callAction("list_sessions").then((result) => {
        setSessions(result);
        if (autoSelect) {
          const inChannel = currentVoiceChannelId
            ? result.filter((s) => s.channelId === currentVoiceChannelId)
            : result;
          if (inChannel.length === 1) setSelectedId(inChannel[0]!.sessionId);
        } else {
          setSelectedId((prev) =>
            prev && result.some((s) => s.sessionId === prev) ? prev : null,
          );
        }
      });

    refresh(true);
    const id = setInterval(() => refresh(false), 3000);
    return () => clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!selectedId || !open) return;
    const poll = () =>
      callAction("get_stream_stats", { sessionId: selectedId }).then(setStats);
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [selectedId, open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Tv className="h-4 w-4" />
          {channelSessions.length > 0 && (
            <span className="absolute top-1 right-1">
              <LiveDot size="sm" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4">
        {channelSessions.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-4 text-muted-foreground">
            <span className="text-2xl">:(</span>
            <p className="text-xs">No active streams in this channel.</p>
          </div>
        ) : selectedId ? (
          <StatsView
            stats={stats}
            title={sessions.find((s) => s.sessionId === selectedId)?.title ?? ""}
            onBack={
              channelSessions.length > 1
                ? () => {
                    setSelectedId(null);
                    setStats(null);
                  }
                : undefined
            }
          />
        ) : (
          <div className="flex flex-col gap-1">
            {channelSessions.map((s) => (
              <Button
                key={s.sessionId}
                variant="ghost"
                className="w-full justify-start gap-2"
                onClick={() => setSelectedId(s.sessionId)}
              >
                <LiveDot />
                {s.title}
              </Button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});

export { StreamsPanel };
