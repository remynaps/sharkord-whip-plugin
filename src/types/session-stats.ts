export interface TrackStats {
  kind: 'audio' | 'video';
  mimeType: string;
  bitrate: number;        // kbps
  packetsLost: number;
  fractionLost: number;   // 0–100 percent
  jitter: number;         // ms
  score: number;          // mediasoup quality score 0–10
  roundTripTime: number;  // ms
  nackCount: number;
  // video only — mediasoup does not expose resolution or fps (no decoding happens)
  pliCount?: number;
  firCount?: number;
}

export interface SessionStats {
  sessionId: string;
  channelId: number;
  tracks: TrackStats[];
}