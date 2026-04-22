import { build } from "@sharkord/plugin-builder";
import { PLUGIN_SDK_VERSION } from "@sharkord/plugin-sdk";
import fs from "fs/promises";
import path from "path";

const copyPluginToSharkord = async (builtPluginPath: string) => {
  // adjust if necessary
  const sharkordPluginsPath = `${process.env.HOME}/.config/sharkord/plugins`;
  const targetPluginPath = path.join(
    sharkordPluginsPath,
    path.basename(builtPluginPath),
  );

  console.log(
    `Copying built plugin from ${builtPluginPath} to ${targetPluginPath}...`,
  );

  await fs.rm(targetPluginPath, { recursive: true, force: true });

  await fs.cp(builtPluginPath, targetPluginPath, {
    recursive: true,
  });
};

const result = await build({
  sdkVersion: PLUGIN_SDK_VERSION,
});

// uncomment the following line to move the built plugin directly to the Sharkord plugins directory, useful for development and testing
// await copyPluginToSharkord(result.outDir);