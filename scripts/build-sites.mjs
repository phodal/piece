import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pagesOutput = join(repoRoot, "site");
const deploymentOutput = join(repoRoot, "dist");

await rm(deploymentOutput, { recursive: true, force: true });
await mkdir(join(deploymentOutput, "client"), { recursive: true });
await mkdir(join(deploymentOutput, "server"), { recursive: true });

await Promise.all([
  cp(pagesOutput, join(deploymentOutput, "client"), { recursive: true }),
  cp(join(repoRoot, "worker", "sites-static.js"), join(deploymentOutput, "server", "index.js")),
]);

console.log(`Sites deployment bundle built: ${deploymentOutput}`);
