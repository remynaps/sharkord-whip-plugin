import { useState, useEffect, useRef } from "react";
import { type TPluginSlotContext } from "@sharkord/plugin-sdk";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@sharkord/ui";
import type { SessionStats, TrackStats } from "../types/session-stats.ts";

const WhipInfoPanel = ({ selectedChannelId, currentVoiceChannelId }: TPluginSlotContext) => {
  const STATS_URL = (channelId: number) =>
  `${window.location.protocol}//${window.location.hostname}/whip/stats/${channelId}`;
  
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<SessionStats[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const targetChannelId = selectedChannelId ?? currentVoiceChannelId;
  const isLive = stats.length > 0;

  useEffect(() => {
    if (!open || !targetChannelId) {
      setStats([]);
      return;
    }
    const poll = async () => {
      try {
        const res = await fetch(STATS_URL(targetChannelId));
        if (res.ok) setStats(await res.json());
        else setStats([]);
      } catch {
        setStats([]);
      }
    };
    poll();
    pollRef.current = setInterval(poll, 1000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, targetChannelId]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={isLive ? "text-green-400" : ""}>
          {isLive ? "🔴" : "📡"} Stream
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-4" align="end">
        <div className="flex items-center gap-2 mb-3">
          {isLive && <LiveDot />}
          <h2 className="font-semibold text-sm">
            {isLive ? "Live Stream" : "Stream"}
          </h2>
        </div>

        {isLive
          ? stats.map((s) => <SessionStatsPanel key={s.sessionId} session={s} />)
          : <p className="text-xs text-muted-foreground">No active stream.</p>
        }
      </PopoverContent>
    </Popover>
  );
};

export { WhipInfoPanel };

// ─── Stats ────────────────────────────────────────────────────────────────────

function SessionStatsPanel({ session }: { session: SessionStats }) {
  const video = session.tracks.find((t) => t.kind === "video");
  const audio = session.tracks.find((t) => t.kind === "audio");
  return (
    <div>
      {video && <TrackStatsPanel track={video} />}
      {audio && <TrackStatsPanel track={audio} />}
    </div>
  );
}

function TrackStatsPanel({ track }: { track: TrackStats }) {
  const isVideo = track.kind === "video";
  const codec = track.mimeType.split("/")[1]?.toUpperCase() ?? track.mimeType;
  const scoreColor =
    track.score >= 8 ? "text-green-400"
    : track.score >= 5 ? "text-yellow-400"
    : "text-red-400";

  return (
    <div className="mb-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
        {isVideo ? "🎬" : "🎙"} {codec}
      </p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 bg-muted rounded-md px-3 py-2">
        <Stat label="Bitrate" value={`${track.bitrate} kbps`} />
        <Stat label="Quality" value={`${track.score}/10`} valueClass={scoreColor} />
        <Stat
          label="Packet loss"
          value={`${track.fractionLost.toFixed(1)}%`}
          valueClass={track.fractionLost > 2 ? "text-red-400" : undefined}
        />
        <Stat
          label="Jitter"
          value={`${track.jitter} ms`}
          valueClass={track.jitter > 50 ? "text-yellow-400" : undefined}
        />
        <Stat label="RTT" value={track.roundTripTime > 0 ? `${track.roundTripTime} ms` : "—"} />
        <Stat label="NACKs" value={track.nackCount.toString()} />
        {isVideo && track.pliCount != null && (
          <Stat
            label="PLIs"
            value={track.pliCount.toString()}
            valueClass={track.pliCount > 10 ? "text-yellow-400" : undefined}
          />
        )}
        {isVideo && track.firCount != null && (
          <Stat label="FIRs" value={track.firCount.toString()} />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between items-center text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${valueClass ?? "text-foreground"}`}>{value}</span>
    </div>
  );
}

function LiveDot() {
  return (
    <span className="inline-block w-2 h-2 rounded-full bg-red-400 shadow-[0_0_0_3px_rgba(248,113,113,0.3)] animate-pulse" />
  );
}