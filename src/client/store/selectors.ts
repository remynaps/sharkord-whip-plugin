import type { SharkordState } from ".";

export const currentVoiceChannelIdSelector = (state: SharkordState) =>
  state.currentVoiceChannelId;

export const currentVoiceChannelSelector = (state: SharkordState) =>
  state.channels.find((c) => c.id === state.currentVoiceChannelId) ?? null;
