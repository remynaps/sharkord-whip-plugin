import type { BunPlugin } from "bun";
import fs from "fs/promises";

const pluginId = "sharkord-whip";
const outdir = `dist/${pluginId}`;

const clientGlobals: BunPlugin = {
  name: "client-globals",
  setup(build) {
    // since the client bundle is meant to run in the host app's context
    // we need to make sure it uses the same React instance as Sharkord instead of bundling its own copy
    // we workaround this by rewriting bare react/react-dom imports to reference the host app's React globals, which Sharkord exposes on the window object
    const globals: Record<string, string> = {
      react: "window.__SHARKORD_REACT__",
      "react/jsx-runtime": "window.__SHARKORD_REACT_JSX__",
      "react/jsx-dev-runtime": "window.__SHARKORD_REACT_JSX_DEV__",
      "react-dom": "window.__SHARKORD_REACT_DOM__",
      "react-dom/client": "window.__SHARKORD_REACT_DOM_CLIENT__",
    };

    for (const [mod, global] of Object.entries(globals)) {
      build.onResolve(
        { filter: new RegExp(`^${mod.replace("/", "\\/")}$`) },
        () => ({
          path: mod,
          namespace: "client-global",
        }),
      );

      build.onLoad(
        {
          filter: new RegExp(`^${mod.replace("/", "\\/")}$`),
          namespace: "client-global",
        },
        () => ({
          contents: `module.exports = ${global};`,
          loader: "js",
        }),
      );
    }
  },
};

await Promise.all([
  Bun.build({
    entrypoints: ["src/server.ts"],
    outdir,
    target: "bun",
    minify: true,
    format: "esm",
    external: ["react", "react-dom"],
  }),

  Bun.build({
    entrypoints: ["src/client.ts"],
    outdir,
    target: "browser",
    minify: true,
    format: "esm",
    plugins: [clientGlobals],
    define: {
     "process.env.NODE_ENV": '"production"',
    },
  }),
]);

await fs.copyFile("package.json", `${outdir}/package.json`);
