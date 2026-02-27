import type { Producer, TExternalStreamHandle, Transport } from "@sharkord/plugin-sdk";

export interface Session {
  channelId: number;
  transport: Transport;
  audioProducer?: Producer;
  videoProducer?: Producer;
  streamHandle: TExternalStreamHandle;
}