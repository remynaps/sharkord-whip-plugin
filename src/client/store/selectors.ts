import type { SharkordState } from ".";

export const currentVoiceChannelIdSelector = (state: SharkordState) =>
  state.currentVoiceChannelId;
