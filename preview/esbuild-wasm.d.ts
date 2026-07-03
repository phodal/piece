declare module "esbuild-wasm/esm/browser" {
  export function initialize(options: { readonly wasmURL: string; readonly worker?: boolean }): Promise<void>;
  export function build(options: Record<string, unknown>): Promise<{
    readonly outputFiles?: readonly unknown[];
    readonly metafile?: unknown;
  }>;
  export function transform(source: string, options: Record<string, unknown>): Promise<{
    readonly code?: string;
    readonly map?: string;
  }>;
}
