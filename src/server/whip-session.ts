import type { Producer, WebRtcTransport } from "mediasoup/types";
import type { TExternalStreamHandle } from "@sharkord/plugin-sdk";

export class WhipSession {
  private closed = false;
  constructor(
    public readonly id: string,
    public readonly channelId: number,
    public readonly title: string,
    public readonly avatarUrl: string | undefined,
    public readonly transport: WebRtcTransport,
    public readonly audioProducer: Producer | undefined,
    public readonly videoProducer: Producer | undefined,
    public readonly streamHandle: TExternalStreamHandle,
    private readonly onCleanup: (id: string) => void,
  ) {}

  public close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.audioProducer?.close();
      this.videoProducer?.close();
      this.transport.close();
      this.streamHandle.remove();
    } finally {
      this.onCleanup(this.id);
    }
  }
}
