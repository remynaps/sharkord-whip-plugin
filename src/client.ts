import { PluginSlot, type TPluginComponentsMapBySlotId } from "@sharkord/plugin-sdk";
import { WhipInfoPanel } from "./components/info-panel";

const components: TPluginComponentsMapBySlotId = {
  [PluginSlot.TOPBAR_RIGHT]: [WhipInfoPanel],
};

export { components };