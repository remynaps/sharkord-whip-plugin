import { useEffect, useRef, useState } from "react";

export type ObsStatus = "disconnected" | "connecting" | "connected";

export type ObsVideoSettings = {
  resolution: string;
  fps: string;
  codec: string;
};

export type ObsStreamInfo = {
  duration: string;
  droppedFrames: number;
};

export type ObsState = {
  status: ObsStatus;
  streaming: boolean;
  streamInfo: ObsStreamInfo | null;
  hasSharkordProfile: boolean;
  setupProfile: (videoSettings: ObsVideoSettings) => Promise<void>;
  goLive: (whipUrl: string, streamKey: string) => Promise<void>;
  stopStream: () => void;
};

const EVENT_SUBSCRIPTIONS = 64 | 2; // Outputs (StreamStateChanged) + Config (CurrentProfileChanged)
const PROFILE_NAME = "Sharkord";

async function computeAuth(password: string, salt: string, challenge: string): Promise<string> {
  const encode = (s: string) => new TextEncoder().encode(s);
  const toBase64 = (buf: ArrayBuffer) => {
    let binary = "";
    for (const b of new Uint8Array(buf)) binary += String.fromCharCode(b);
    return btoa(binary);
  };
  const secret = toBase64(await crypto.subtle.digest("SHA-256", encode(password + salt)));
  return toBase64(await crypto.subtle.digest("SHA-256", encode(secret + challenge)));
}

export function useObs(password?: string, enabled = true): ObsState {
  const [status, setStatus] = useState<ObsStatus>("disconnected");
  const [streaming, setStreaming] = useState(false);
  const [streamInfo, setStreamInfo] = useState<ObsStreamInfo | null>(null);
  const [hasSharkordProfile, setHasSharkordProfile] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, (d: unknown) => void>());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(enabled);
  const originalProfileRef = useRef<string | null>(null);
  const restoreProfileRef = useRef<string | null>(null);
  const profileChangedResolveRef = useRef<(() => void) | null>(null);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const sendRaw = (op: number, d: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify({ op, d }));
  };

  const request = (requestType: string, requestData?: object): Promise<unknown> =>
    new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      pending.current.set(requestId, resolve);
      sendRaw(6, { requestType, requestId, ...(requestData && { requestData }) });
    });

  const fetchProfiles = async () => {
    const res = await request("GetProfileList");
    const data = (res as { responseData?: { currentProfileName: string; profiles: string[] } }).responseData;
    if (data) {
      setHasSharkordProfile(data.profiles.includes(PROFILE_NAME));
      return data;
    }
    return null;
  };

  useEffect(() => {
    if (!enabled) return;
    function connect() {
      setStatus("connecting");
      const socket = new WebSocket("ws://localhost:4455");
      wsRef.current = socket;

      socket.onmessage = async (event) => {
        const msg = JSON.parse(event.data as string) as {
          op: number;
          d: Record<string, unknown>;
        };

        if (msg.op === 0) {
          // Hello — compute auth if required, then identify
          const authChallenge = msg.d.authentication as
            | { challenge: string; salt: string }
            | undefined;
          const authentication =
            authChallenge && password
              ? await computeAuth(password, authChallenge.salt, authChallenge.challenge)
              : undefined;
          socket.send(
            JSON.stringify({
              op: 1,
              d: {
                rpcVersion: 1,
                eventSubscriptions: EVENT_SUBSCRIPTIONS,
                ...(authentication && { authentication }),
              },
            }),
          );
        } else if (msg.op === 2) {
          // Identified — fetch initial stream status and profile list
          setStatus("connected");
          request("GetStreamStatus").then((res) => {
            const data = (res as { responseData?: { outputActive?: boolean } }).responseData;
            setStreaming(data?.outputActive ?? false);
          });
          fetchProfiles();
        } else if (msg.op === 5) {
          // Event
          const { eventType, eventData } = msg.d as {
            eventType: string;
            eventData?: { outputActive?: boolean };
          };
          if (eventType === "StreamStateChanged") {
            setStreaming(eventData?.outputActive ?? false);
            if (!eventData?.outputActive && restoreProfileRef.current) {
              const profile = restoreProfileRef.current;
              restoreProfileRef.current = null;
              request("SetCurrentProfile", { profileName: profile });
            }
          } else if (eventType === "CurrentProfileChanged") {
            profileChangedResolveRef.current?.();
            profileChangedResolveRef.current = null;
          }
        } else if (msg.op === 7) {
          // RequestResponse
          const id = msg.d.requestId as string;
          const resolve = pending.current.get(id);
          if (resolve) {
            pending.current.delete(id);
            resolve(msg.d);
          }
        }
      };

      socket.onclose = () => {
        wsRef.current = null;
        setStatus("disconnected");
        setStreaming(false);
        setHasSharkordProfile(false);
        if (enabledRef.current)
          retryTimer.current = setTimeout(connect, 5000);
      };

      socket.onerror = () => socket.close();
    }

    connect();

    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (!streaming) { setStreamInfo(null); return; }
    const poll = () => request("GetStreamStatus").then((res) => {
      const data = (res as { responseData?: { outputTimecode?: string; outputSkippedFrames?: number; outputTotalFrames?: number } }).responseData;
      if (!data) return;
      const tc = (data.outputTimecode ?? "0:00:00.000").split(".")[0]!;
      const [h, m, s] = tc.split(":");
      const duration = h === "00" ? `${parseInt(m!)}:${s}` : `${parseInt(h!)}:${m}:${s}`;
      const total = data.outputTotalFrames ?? 0;
      const dropped = total > 0 ? ((data.outputSkippedFrames ?? 0) / total) * 100 : 0;
      setStreamInfo({ duration, droppedFrames: dropped });
    });
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [streaming]);

  const setupProfile = async (videoSettings: ObsVideoSettings) => {
    const profileData = await fetchProfiles();
    const previousProfile = profileData?.currentProfileName ?? null;

    await request("CreateProfile", { profileName: PROFILE_NAME });
    await fetchProfiles();

    const profileReady = new Promise<void>((resolve) => { profileChangedResolveRef.current = resolve; });
    await request("SetCurrentProfile", { profileName: PROFILE_NAME });
    await profileReady;

    const [width, height] = videoSettings.resolution.split("x").map(Number);
    await request("SetVideoSettings", {
      baseWidth: width, baseHeight: height,
      outputWidth: width, outputHeight: height,
      fpsNumerator: parseInt(videoSettings.fps), fpsDenominator: 1,
    });
    await request("SetProfileParameter", {
      parameterCategory: "SimpleOutput",
      parameterName: "StreamEncoder",
      parameterValue: videoSettings.codec,
    });
    await request("SetProfileParameter", {
      parameterCategory: "SimpleOutput",
      parameterName: "StreamAudioEncoder",
      parameterValue: "ffmpeg_opus",
    });

    // Write whip_custom into the profile's service.json so OBS initialises the
    // WHIP output (not RTMP) the next time this profile is loaded.
    await request("SetStreamServiceSettings", {
      streamServiceType: "whip_custom",
      streamServiceSettings: { server: "http://placeholder", bearer_token: "" },
    });

    if (previousProfile && previousProfile !== PROFILE_NAME) {
      const restoreReady = new Promise<void>((resolve) => { profileChangedResolveRef.current = resolve; });
      await request("SetCurrentProfile", { profileName: previousProfile });
      await restoreReady;
    }
    await fetchProfiles();
  };

  const goLive = async (whipUrl: string, streamKey: string) => {
    const profileData = await fetchProfiles();
    if (!profileData?.profiles.includes(PROFILE_NAME)) return;
    originalProfileRef.current = profileData.currentProfileName;

    if (profileData.currentProfileName !== PROFILE_NAME) {
      const profileReady = new Promise<void>((resolve) => { profileChangedResolveRef.current = resolve; });
      await request("SetCurrentProfile", { profileName: PROFILE_NAME });
      await profileReady;
    }

    // Set the whip streaming settings when we go live.
    // Wow thats weird! yeah. But i want to simulate discord. click stream in a channel -> stream starts
    // To do that, we need to set the stream url with the channel id every time.
    await request("SetStreamServiceSettings", {
      streamServiceType: "whip_custom",
      streamServiceSettings: { server: whipUrl, bearer_token: streamKey },
    });
    await request("StartStream");
  };

  const stopStream = () => {
    if (originalProfileRef.current && originalProfileRef.current !== PROFILE_NAME)
      restoreProfileRef.current = originalProfileRef.current;
    originalProfileRef.current = null;
    request("StopStream");
  };

  return {
    status,
    streaming,
    streamInfo,
    hasSharkordProfile,
    setupProfile,
    goLive,
    stopStream,
  };
}
