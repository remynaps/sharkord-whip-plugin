import { PluginSlot, type TPluginComponentsMapBySlotId } from "@sharkord/plugin-sdk";
import { StreamsPanel } from "./components/StreamsPanel";

const components: TPluginComponentsMapBySlotId = {
  [PluginSlot.TOPBAR_RIGHT]: [StreamsPanel],
};

export { components };
