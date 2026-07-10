import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(REPOSITORY_ROOT, relativePath), "utf8"));
}

describe("published package boundary", () => {
  it("marks resolver entrypoints as side-effectful and guards npm publish with release verification", async () => {
    const packageJson = await readJson("package.json");

    expect(packageJson.type).toBe("module");
    expect(packageJson.sideEffects).toEqual(
      expect.arrayContaining([
        "./src/index.js",
        "./src/browser.js",
        "./src/node.js",
        "./src/public-api/index.js",
        "./src/public-api/browser.js",
        "./src/public-api/node.js"
      ])
    );
    expect(packageJson.scripts.prepublishOnly).toBe("npm run release:verify");
    expect(packageJson.scripts["release:verify"]).toContain("npm run verify");
    expect(packageJson.scripts["release:verify"]).toContain("npm run smoke:packed");
    expect(packageJson.scripts["release:verify"]).toContain("npm run language:verify");
  });

  it("declares the standalone Go analyzer as a Go 1.22 module", async () => {
    const moduleSource = await readFile(join(REPOSITORY_ROOT, "go-backend", "go.mod"), "utf8");

    expect(moduleSource).toContain("module github.com/phodal/piece/go-backend");
    expect(moduleSource).toContain("go 1.22");
  });
});
