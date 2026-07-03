import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = join(repoRoot, "site");
const previewDir = join(repoRoot, "preview");
const wasmDistDir = join(repoRoot, "piece-core", "build", "dist", "wasmJs", "productionExecutable");

await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });
await cp(join(previewDir, "index.html"), join(siteDir, "index.html"));
await cp(join(previewDir, "preview.css"), join(siteDir, "preview.css"));
await cp(join(previewDir, "dist"), join(siteDir, "dist"), { recursive: true });
await cp(wasmDistDir, join(siteDir, "wasm"), { recursive: true });
await writeFile(
  join(siteDir, "wasm", "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Piece Core WASM Smoke</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
      code { background: #f4f4f5; padding: 0.2rem 0.35rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Piece Core WASM Smoke</h1>
    <p id="status">Loading Kotlin/Wasm bundle...</p>
    <script src="./piece-core.js"></script>
    <script>
      (async () => {
        const status = document.querySelector("#status");
        try {
          const pieceCore = await globalThis["piece-core"];
          const label = pieceCore.sampleWasmPackageLabel("/repo/src/Pricing.kt");
          status.innerHTML = "Loaded <code>" + label + "</code>";
        } catch (error) {
          status.textContent = "Failed to load Piece Core WASM: " + error.message;
          throw error;
        }
      })();
    </script>
  </body>
</html>
`
);
await writeFile(join(siteDir, ".nojekyll"), "");

console.log(`GitHub Pages site built: ${siteDir}`);
