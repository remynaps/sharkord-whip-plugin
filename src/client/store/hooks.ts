import { createCallAction } from "@sharkord/plugin-sdk";
import { actions, useStoreSelector } from ".";
import { currentVoiceChannelIdSelector, currentVoiceChannelSelector } from "./selectors";
import type { Actions } from "../../contracts/Actions";

export const useCallAction = () => createCallAction<Actions>(actions);

export const useCurrentVoiceChannelId = () =>
  useStoreSelector(currentVoiceChannelIdSelector);

export const useCurrentVoiceChannel = () =>
  useStoreSelector(currentVoiceChannelSelector);
