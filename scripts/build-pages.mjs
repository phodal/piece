import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = join(repoRoot, "site");
const previewDir = join(repoRoot, "preview");

await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });
await cp(join(previewDir, "index.html"), join(siteDir, "index.html"));
await cp(join(previewDir, "preview.css"), join(siteDir, "preview.css"));
await cp(join(previewDir, "dist"), join(siteDir, "dist"), { recursive: true });
await writeFile(join(siteDir, ".nojekyll"), "");

console.log(`GitHub Pages site built: ${siteDir}`);
