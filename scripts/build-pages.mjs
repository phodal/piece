import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = join(repoRoot, "site");
const previewDir = join(repoRoot, "preview");
const wasmDistDir = join(repoRoot, "piece-core", "build", "dist", "wasmJs", "productionExecutable");

await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });
await cp(join(previewDir, "preview.css"), join(siteDir, "preview.css"));
await cp(join(previewDir, "dist"), join(siteDir, "dist"), { recursive: true });
await cp(wasmDistDir, join(siteDir, "wasm"), { recursive: true });
const clientBundle = await readFile(join(previewDir, "dist", "client.js"));
const assetRevision = createHash("sha256").update(clientBundle).digest("hex").slice(0, 16);
const pageIndex = (await readFile(join(previewDir, "index.html"), "utf8")).replace(
  'src="./dist/client.js"',
  `src="./dist/client.js?v=${assetRevision}"`,
);
if (!pageIndex.includes(`./dist/client.js?v=${assetRevision}`)) {
  throw new Error("Pages entry point did not include the preview client script.");
}
await writeFile(join(siteDir, "index.html"), pageIndex);
await writeFile(
  join(siteDir, "wasm", "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Piece Kotlin/Wasm Smoke</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
      code { background: #f4f4f5; padding: 0.2rem 0.35rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Piece Kotlin/Wasm Smoke</h1>
    <p>Browser hosts can load the shared model and graph code. Kotlin/Go compiler execution stays in the local Node/JVM backend.</p>
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
