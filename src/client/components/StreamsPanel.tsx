import { memo, useEffect, useState } from "react";

import { Tv, Video, Mic } from "lucide-react";
import {
  Badge,
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

const connectionBadgeClass = (state: string) =>
  state === "connected" || state === "completed"
    ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/20"
    : state === "new" || state === "connecting" || state === "checking"
    ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/20"
    : "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20";

const LiveDot = ({ size = "md" }: { size?: "sm" | "md" }) => (
  <span className={`inline-flex rounded-full bg-red-500 animate-pulse shrink-0 ${size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2"}`} />
);

const qualityBadgeClass = (score: number) =>
  score >= 8
    ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/20"
    : score >= 5
    ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/20"
    : "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20";

const StatsSkeleton = () => (
  <div className="flex flex-col gap-2 animate-pulse">
    {[80, 60, 90, 70].map((w, i) => (
      <div key={i} className="h-3 bg-muted rounded" style={{ width: `${w}%` }} />
    ))}
  </div>
);

const Sparkline = ({ data, id, stroke, label }: { data: number[]; id: string; stroke: string; label: string }) => {
  const W = 240, H = 36;
  const gid = `sg-${id}`;

  let graph: React.ReactNode = <div className="w-full rounded-sm bg-muted/40 animate-pulse" style={{ height: H }} />;
  if (data.length >= 2) {
    const max = Math.max(...data, 1);
    const xs = data.map((_, i) => (i / (data.length - 1)) * W);
    const ys = data.map((v) => H - (v / max) * (H - 2) - 1);
    const line = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join("");
    const area = `${line}L${W},${H}L0,${H}Z`;
    graph = (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" height={H} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wide">{label}</span>
      {graph}
    </div>
  );
};

const StatsView = ({
  stats,
  history,
  title,
  onBack,
}: {
  stats: StreamStats | null;
  history: StreamStats[];
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
          <div className="grid grid-cols-2 items-center gap-x-4 text-xs" style={{ rowGap: '10px' }}>
            <span className="text-muted-foreground">Bitrate</span>
            <span className="tabular-nums font-medium">
              {formatBitrate(stats.transport.recvBitrate)}
            </span>
            <span className="text-muted-foreground">ICE</span>
            <Badge className={connectionBadgeClass(stats.transport.iceState)}>
              {stats.transport.iceState}
            </Badge>
            <span className="text-muted-foreground">DTLS</span>
            <Badge className={connectionBadgeClass(stats.transport.dtlsState)}>
              {stats.transport.dtlsState}
            </Badge>
          </div>
          <div className="mt-2">
            <Sparkline data={history.map((h) => h.transport.recvBitrate)} id="transport" stroke="#fbbf24" label="bitrate" />
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
              <div className="grid grid-cols-2 items-center gap-x-4 text-xs" style={{ rowGap: '10px' }}>
                <span className="text-muted-foreground">Bitrate</span>
                <span className="tabular-nums font-medium">
                  {formatBitrate(stats.video.bitrate)}
                </span>
                <span className="text-muted-foreground">Packet loss</span>
                <span className={`tabular-nums font-medium ${lossColor(stats.video.fractionLost)}`}>
                  {(stats.video.fractionLost * 100).toFixed(1)}%
                </span>
                <span className="text-muted-foreground">Quality</span>
                <Badge className={`${qualityBadgeClass(stats.video.score)}`}>{stats.video.score}/10</Badge>
                <span className="text-muted-foreground">PLI / NACK</span>
                <span className="tabular-nums text-muted-foreground">
                  {stats.video.pliCount} / {stats.video.nackCount}
                </span>
              </div>
              <div className="mt-2">
                <Sparkline data={history.flatMap((h) => h.video ? [h.video.bitrate] : [])} id="video-br" stroke="#60a5fa" label="bitrate" />
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
              <div className="grid grid-cols-2 items-center gap-x-4 text-xs" style={{ rowGap: '10px' }}>
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
                <Badge className={`${qualityBadgeClass(stats.audio.score)}`}>{stats.audio.score}/10</Badge>
              </div>
              <div className="mt-2">
                <Sparkline data={history.flatMap((h) => h.audio ? [h.audio.bitrate] : [])} id="audio-br" stroke="#34d399" label="bitrate" />
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
  const [statsHistory, setStatsHistory] = useState<StreamStats[]>([]);
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const callAction = useCallAction();

  useEffect(() => {
    if (!open) {
      setSessions([]);
      setSelectedId(null);
      setStats(null);
      setStatsHistory([]);
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
    setStatsHistory([]);
    const poll = () =>
      callAction("get_stream_stats", { sessionId: selectedId }).then((s) => {
        setStats(s);
        if (s) setStatsHistory((prev) => [...prev.slice(-29), s]);
      });
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [selectedId, open]);

  if (!currentVoiceChannelId) return null;

  const channelSessions = sessions.filter(
    (s) => s.channelId === currentVoiceChannelId,
  );

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
            history={statsHistory}
            title={sessions.find((s) => s.sessionId === selectedId)?.title ?? ""}
            onBack={
              channelSessions.length > 1
                ? () => {
                    setSelectedId(null);
                    setStats(null);
                    setStatsHistory([]);
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

const StreamsPanelGuard = memo(() => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const callAction = useCallAction();

  useEffect(() => {
    callAction("get_client_settings").then(({ showStreamStats }) =>
      setEnabled(showStreamStats),
    );
  }, []);

  if (!enabled) return null;
  return <StreamsPanel />;
});

export { StreamsPanelGuard as StreamsPanel };
