import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = join(REPOSITORY_ROOT, "bin", "piece.js");

function invokePiece(args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: options.cwd ?? REPOSITORY_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

async function withWorkspace(callback) {
  const workspace = await mkdtemp(join(tmpdir(), "piece-cli-test-"));
  try {
    return await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("piece CLI", () => {
  it("serves help and version without requiring a workspace config", async () => {
    const help = await invokePiece(["--help", "--no-color"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toBe("");
    expect(help.stderr).toContain("Usage:");
    expect(help.stderr).toContain("piece analyze <entry>");

    const version = await invokePiece(["--version", "--format", "json"]);
    expect(version.exitCode).toBe(0);
    expect(version.stderr).toBe("");
    expect(JSON.parse(version.stdout)).toMatchObject({
      schemaVersion: 1,
      kind: "version",
      status: "success",
      exitCode: 0,
      version: "0.1.0"
    });
  });

  it("analyzes a workspace-contained entry and emits a stable JSON result with provenance", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, "src"));
      await writeFile(
        join(workspace, "src", "App.ts"),
        "export const message = 'hello';\nexport function App() { return message; }\n",
        "utf8"
      );
      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify({ schemaVersion: 1, sourceRoots: ["src"], globals: ["console"] }, null, 2)}\n`,
        "utf8"
      );

      const result = await invokePiece(["analyze", "src/App.ts", "--workspace", workspace, "--format", "json", "--no-color"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout);
      const resolvedWorkspace = await realpath(workspace);
      expect(body).toMatchObject({
        schemaVersion: 1,
        command: "analyze",
        status: "success",
        exitCode: 0,
        workspace: { path: resolvedWorkspace, provenance: "flag" },
        config: { path: join(resolvedWorkspace, "piece.config.json"), provenance: "default", schemaVersion: 1 },
        input: {
          entry: { workspaceRelativePath: "src/App.ts", provenance: "argument" },
          sourceRoots: { provenance: "config" }
        }
      });
      expect(body.analysis.sliceCount).toBeGreaterThan(0);
      expect(body.analysis.feedbackScope).toHaveProperty("fallbackRequired");
    });
  });

  it("rejects unknown configuration keys as a usage error", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify({ schemaVersion: 1, unsupported: true })}\n`,
        "utf8"
      );

      const result = await invokePiece(["doctor", "--workspace", workspace, "--format", "json"]);
      expect(result.exitCode).toBe(2);
      const body = JSON.parse(result.stdout);
      expect(body).toMatchObject({
        schemaVersion: 1,
        command: "doctor",
        status: "failed",
        exitCode: 2,
        diagnostics: [{ code: "unknown-config-key", severity: "error" }]
      });
    });
  });

  it("rejects entries that escape the workspace or do not exist", async () => {
    await withWorkspace(async (workspace) => {
      const outsideEntry = join(dirname(workspace), "piece-cli-outside.ts");
      await writeFile(outsideEntry, "export const outside = true;\n", "utf8");
      try {
        const escaped = await invokePiece(["analyze", "../piece-cli-outside.ts", "--workspace", workspace, "--format", "json"]);
        expect(escaped.exitCode).toBe(2);
        expect(JSON.parse(escaped.stdout).diagnostics[0]).toMatchObject({ code: "workspace-path-escape" });

        const missing = await invokePiece(["analyze", "missing.ts", "--workspace", workspace, "--format", "json"]);
        expect(missing.exitCode).toBe(2);
        expect(JSON.parse(missing.stdout).diagnostics[0]).toMatchObject({ code: "path-not-found" });
      } finally {
        await rm(outsideEntry, { force: true });
      }
    });
  });
});
