import type { StreamStats } from "./StreamStats.ts";

type Actions = {
  list_sessions: {
    payload: void;
    response: Array<{ sessionId: string; title: string; channelId: number; avatarUrl?: string }>;
  };
  get_stream_info: {
    payload: void;
    response: { activeStreams: number; isRunning: boolean };
  };
  get_stream_stats: {
    payload: { sessionId: string };
    response: StreamStats | null;
  };
  get_client_settings: {
    payload: void;
    response: { showStreamStats: boolean; showObsControls: boolean; obsWebsocketPassword: string; serverUrl: string; streamKey: string };
  };
};

export type { Actions };
