import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Label,
} from "@sharkord/ui";
import type { ObsVideoSettings } from "../hooks/useObs";

const STORAGE_KEY = "sharkord-obs-video-settings";

const RESOLUTIONS: Record<string, { label: string; value: string }[]> = {
  "16:9": [
    { label: "1280×720 (720p)", value: "1280x720" },
    { label: "1920×1080 (1080p)", value: "1920x1080" },
    { label: "2560×1440 (1440p)", value: "2560x1440" },
    { label: "3840×2160 (4K)", value: "3840x2160" },
  ],
  "4:3": [
    { label: "1024×768", value: "1024x768" },
    { label: "1280×960", value: "1280x960" },
    { label: "1600×1200", value: "1600x1200" },
  ],
  "21:9": [
    { label: "2560×1080", value: "2560x1080" },
    { label: "3440×1440", value: "3440x1440" },
  ],
};

function aspectRatioOf(resolution: string): string {
  return Object.entries(RESOLUTIONS).find(([, list]) =>
    list.some((r) => r.value === resolution)
  )?.[0] ?? "16:9";
}

const DEFAULT_SETTINGS: ObsVideoSettings = {
  resolution: "1920x1080",
  fps: "60",
  codec: "x264",
};

export function loadObsVideoSettings(): ObsVideoSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

type Step = "idle" | "working" | "done" | "error";

export const ObsSetupModal = ({
  open,
  onOpenChange,
  serverUrl,
  onSetup,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverUrl: string;
  onSetup: (settings: ObsVideoSettings) => Promise<void>;
}) => {
  const saved = loadObsVideoSettings();
  const [aspectRatio, setAspectRatio] = useState(() => aspectRatioOf(saved.resolution));
  const [resolution, setResolution] = useState(saved.resolution);
  const [fps, setFps] = useState(saved.fps);
  const [codec, setCodec] = useState(saved.codec);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

  const handleAspectRatioChange = (ratio: string) => {
    setAspectRatio(ratio);
    setResolution(RESOLUTIONS[ratio]![0]!.value);
  };

  const settings: ObsVideoSettings = { resolution, fps, codec };

  const handleSetup = async () => {
    setStep("working");
    setError(null);
    try {
      await onSetup(settings);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setStep("error");
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) setStep("idle");
    onOpenChange(open);
  };

  const resolutionOptions = RESOLUTIONS[aspectRatio] ?? RESOLUTIONS["16:9"]!;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent close={() => handleOpenChange(false)}>
        <DialogHeader>
          <DialogTitle>Set up OBS</DialogTitle>
          <DialogDescription>
            Creates a <strong>Sharkord</strong> profile in OBS. Your existing profiles won't be touched. OBS will switch to this profile when you go live and switch back when you stop.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex gap-3">
            <div className="flex flex-col gap-1.5 w-24 shrink-0">
              <Label>Aspect ratio</Label>
              <Select value={aspectRatio} onValueChange={handleAspectRatioChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.keys(RESOLUTIONS).map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5 flex-1">
              <Label>Resolution</Label>
              <Select value={resolution} onValueChange={setResolution}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {resolutionOptions.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5 w-24 shrink-0">
              <Label>Frame rate</Label>
              <Select value={fps} onValueChange={setFps}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30 fps</SelectItem>
                  <SelectItem value="60">60 fps</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex flex-col gap-1.5 flex-1">
              <Label>Video encoder</Label>
              <Select value={codec} onValueChange={setCodec}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="x264">x264 (software)</SelectItem>
                  <SelectItem value="ffmpeg_nvenc">NVENC H.264 (NVIDIA)</SelectItem>
                  <SelectItem value="h264_texture_amf">AMF H.264 (AMD)</SelectItem>
                  <SelectItem value="com.apple.videotoolbox.videoencoder.ave.avc">VideoToolbox (Apple)</SelectItem>
                </SelectContent>
              </Select>
            </div>

          </div>

          <p className="text-xs text-muted-foreground">
            WHIP server: <span className="font-mono">{serverUrl}/whip/&lt;channelId&gt;</span>
          </p>

          <div className="flex flex-col gap-2 rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-yellow-700 dark:text-yellow-400">
            <p><strong>Audio:</strong> WHIP uses WebRTC which only supports Opus. Make sure your OBS audio track is set to Opus as AAC will not work and may produce garbled audio. I tried setting it through here but it wont work...</p>
            <p><strong>This is basic setup.</strong> Bitrate, advanced encoder settings, and audio tracks should be configured directly in OBS under the Sharkord profile for best results.</p>
          </div>
        </div>

        {step === "error" && (
          <p className="text-sm text-red-500">{error}</p>
        )}

        {step === "done" && (
          <div className="rounded-md border border-green-500/20 bg-green-500/10 p-3 text-xs text-green-700 dark:text-green-400">
            <strong>Sharkord profile created.</strong> You're all set! click Go Live in the stream panel when you're ready to stream.
          </div>
        )}

        {step === "done" ? (
          <DialogFooter>
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          </DialogFooter>
        ) : (
          <DialogFooter>
            <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={step === "working"}>
              Cancel
            </Button>
            <Button onClick={handleSetup} disabled={step === "working"}>
              {step === "working" ? "Setting up…" : "Set up"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
