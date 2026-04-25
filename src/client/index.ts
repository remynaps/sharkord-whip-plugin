import { PluginSlot, type TPluginComponentsMapBySlotId } from "@sharkord/plugin-sdk";
import { StreamsPanel } from "./components/StreamsPanel";
import { ObsPanel } from "./components/ObsPanel";

const components: TPluginComponentsMapBySlotId = {
  [PluginSlot.TOPBAR_RIGHT]: [ObsPanel, StreamsPanel],
};

export { components };
