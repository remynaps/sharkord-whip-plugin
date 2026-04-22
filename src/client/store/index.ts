import { useEffect, useState } from "react";
import type { TPluginStore } from "@sharkord/plugin-sdk";

const store = window.__SHARKORD_STORE__;
const { actions, getState, subscribe } = store;

type SharkordState = ReturnType<TPluginStore["getState"]>;

const useStoreSelector = <T>(selector: (state: SharkordState) => T) => {
  const [value, setValue] = useState(() => selector(getState()));

  useEffect(() => {
    return subscribe(() => {
      setValue(selector(getState()));
    });
  }, []);

  return value;
};

export { useStoreSelector, actions };
export type { SharkordState };
