import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const previewDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(previewDir, "..");
const distDir = join(previewDir, "dist");
const vendorDir = join(distDir, "vendor");

await rm(distDir, { recursive: true, force: true });
await mkdir(vendorDir, { recursive: true });

await build({
  entryPoints: [join(previewDir, "client.ts")],
  outfile: join(distDir, "client.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production")
  }
});

await build({
  stdin: {
    contents: `
import React from "react";
export default React;
export const Children = React.Children;
export const Component = React.Component;
export const Fragment = React.Fragment;
export const Profiler = React.Profiler;
export const PureComponent = React.PureComponent;
export const StrictMode = React.StrictMode;
export const Suspense = React.Suspense;
export const cloneElement = React.cloneElement;
export const createContext = React.createContext;
export const createElement = React.createElement;
export const createRef = React.createRef;
export const forwardRef = React.forwardRef;
export const isValidElement = React.isValidElement;
export const lazy = React.lazy;
export const memo = React.memo;
export const startTransition = React.startTransition;
export const useCallback = React.useCallback;
export const useContext = React.useContext;
export const useDebugValue = React.useDebugValue;
export const useDeferredValue = React.useDeferredValue;
export const useEffect = React.useEffect;
export const useId = React.useId;
export const useImperativeHandle = React.useImperativeHandle;
export const useInsertionEffect = React.useInsertionEffect;
export const useLayoutEffect = React.useLayoutEffect;
export const useMemo = React.useMemo;
export const useReducer = React.useReducer;
export const useRef = React.useRef;
export const useState = React.useState;
export const useSyncExternalStore = React.useSyncExternalStore;
export const useTransition = React.useTransition;
export const version = React.version;
`,
    resolveDir: repoRoot,
    sourcefile: "react-wrapper.js"
  },
  outfile: join(vendorDir, "react.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022"
});

await build({
  stdin: {
    contents: `
import client from "react-dom/client";
export default client;
export const createRoot = client.createRoot;
export const hydrateRoot = client.hydrateRoot;
`,
    resolveDir: repoRoot,
    sourcefile: "react-dom-client-wrapper.js"
  },
  outfile: join(vendorDir, "react-dom-client.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022"
});

await build({
  stdin: {
    contents: `
import runtime from "react/jsx-runtime";
export default runtime;
export const Fragment = runtime.Fragment;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
`,
    resolveDir: repoRoot,
    sourcefile: "react-jsx-runtime-wrapper.js"
  },
  outfile: join(vendorDir, "react-jsx-runtime.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022"
});

await copyFile(join(repoRoot, "node_modules/esbuild-wasm/esbuild.wasm"), join(vendorDir, "esbuild.wasm"));

console.log(`Piece compiler preview built: ${distDir}`);
