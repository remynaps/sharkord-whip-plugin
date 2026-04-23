type StreamStats = {
  transport: {
    bytesReceived: number;
    recvBitrate: number;
    iceState: string;
    dtlsState: string;
    remoteIp?: string;
    remotePort?: number;
    protocol?: string;
  };
  audio: {
    bitrate: number;
    packetsLost: number;
    fractionLost: number;
    jitter: number;
    score: number;
    mimeType: string;
  } | null;
  video: {
    bitrate: number;
    packetsLost: number;
    fractionLost: number;
    jitter: number;
    score: number;
    mimeType: string;
    pliCount: number;
    nackCount: number;
  } | null;
};

export type { StreamStats };
