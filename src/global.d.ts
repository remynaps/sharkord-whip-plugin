import type { TPluginStore } from "@sharkord/plugin-sdk";
import type { createCachedSelector } from "re-reselect";
import type { createSelector } from "reselect";

declare global {
  interface Window {
    __SHARKORD_STORE__: TPluginStore;
    __SHARKORD_EXPOSED_LIBS__: {
      createSelector: createSelector;
      createCachedSelector: createCachedSelector;
    };
  }

  const window: Window & typeof globalThis;
}

export {};
