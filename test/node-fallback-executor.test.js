import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { executePieceFallback, planPieceFallback } from "../src/node-fallback-executor.js";

const nodeDirectory = dirname(process.execPath);

function fallbackAnalysis(overrides = {}) {
  return {
    feedbackScope: {
      level: "project",
      fallbackRequired: true,
      reasons: [{ code: "project-model-discovery-fallback", severity: "warning", message: "Use native project action." }],
      ...overrides
    }
  };
}

async function withDirectory(prefix, callback) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeFakeCommand(directory, name, program) {
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\n${program}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

function controlledPolicy(profiles, bin, extraEnvironment = {}, extraPolicy = {}) {
  return {
    profiles,
    envAllowlist: ["PATH", "PIECE_FALLBACK_ALLOWED", "PIECE_FALLBACK_MODE"],
    env: {
      PATH: `${bin}:${nodeDirectory}`,
      PIECE_FALLBACK_ALLOWED: "yes",
      ...extraEnvironment
    },
    ...extraPolicy
  };
}

async function createGoModule(root) {
  await writeFile(join(root, "go.mod"), "module example.com/fallback\n\ngo 1.22\n", "utf8");
}

describe("safe Node fallback executor", () => {
  it("creates a non-mutating Go plan only after a fallback scope and explicit policy are supplied", async () => {
    await withDirectory("piece-fallback-go-plan-", async (workspace) => {
      await createGoModule(workspace);
      const result = await planPieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { profile: "go" },
        policy: {
          profiles: {
            go: { root: ".", allowActions: ["test"] }
          }
        }
      });

      expect(result).toMatchObject({
        status: "planned",
        mode: "plan",
        profile: "go",
        plan: { command: "go", args: ["test", "./..."] }
      });
      expect(result.command).toBeUndefined();
      expect(result.plan.cwd).toBe(await import("node:fs/promises").then(({ realpath }) => realpath(workspace)));
    });
  });

  it("requires a declared profile and rejects arbitrary request fields or commands", async () => {
    await withDirectory("piece-fallback-policy-", async (workspace) => {
      await createGoModule(workspace);
      const missingProfile = await planPieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { profile: "go" },
        policy: { profiles: {} }
      });
      expect(missingProfile.diagnostics[0].code).toBe("fallback-profile-not-declared");

      const arbitraryArgs = await planPieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { profile: "go", args: ["--unsafe"] },
        policy: { profiles: { go: { root: ".", allowActions: ["test"] } } }
      });
      expect(arbitraryArgs.diagnostics[0].code).toBe("fallback-request-field-not-allowed");

      const arbitraryCommand = await planPieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { profile: "go" },
        policy: { profiles: { go: { root: ".", command: "sh", allowActions: ["test"] } } }
      });
      expect(arbitraryCommand.diagnostics[0].code).toBe("fallback-command-not-allowed");
    });
  });

  it("rejects a policy root that escapes through a symlink", async () => {
    await withDirectory("piece-fallback-workspace-", async (workspace) => {
      await withDirectory("piece-fallback-outside-", async (outside) => {
        await createGoModule(outside);
        await symlink(outside, join(workspace, "outside-module"), "dir");
        const result = await planPieceFallback({
          workspaceRoot: workspace,
          analysis: fallbackAnalysis(),
          request: { profile: "go" },
          policy: { profiles: { go: { root: "outside-module", allowActions: ["test"] } } }
        });

        expect(result.status).toBe("blocked");
        expect(result.diagnostics[0].code).toBe("fallback-workspace-path-escape");
      });
    });
  });

  it("requires verified Gradle and package-script markers and keeps tasks and scripts allowlisted", async () => {
    await withDirectory("piece-fallback-profiles-", async (workspace) => {
      await writeFile(join(workspace, "settings.gradle.kts"), "rootProject.name = \"fixture\"\n", "utf8");
      await writeFakeCommand(workspace, "gradlew", "process.exit(0);");
      await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { build: "echo build" } }), "utf8");

      const gradle = await planPieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { profile: "gradle", task: "check" },
        policy: { profiles: { gradle: { root: ".", allowTasks: ["check"] } } }
      });
      expect(gradle).toMatchObject({
        status: "planned",
        plan: { args: ["--no-daemon", "check"] }
      });
      expect(gradle.plan.command).toContain("gradlew");

      const badTask = await planPieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { profile: "gradle", task: "--init-script" },
        policy: { profiles: { gradle: { root: ".", allowTasks: ["check"] } } }
      });
      expect(badTask.diagnostics[0].code).toBe("fallback-task-not-allowed");

      const typescript = await planPieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { profile: "typescript", script: "build" },
        policy: { profiles: { typescript: { root: ".", allowScripts: ["build"] } } }
      });
      expect(typescript).toMatchObject({ status: "planned", plan: { command: "npm", args: ["run", "build"] } });

      const badScript = await planPieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { profile: "typescript", script: "postinstall" },
        policy: { profiles: { typescript: { root: ".", allowScripts: ["build"] } } }
      });
      expect(badScript.diagnostics[0].code).toBe("fallback-script-not-allowed");
    });
  });

  it("allows an explicit native project action even when Piece local feedback is safe", async () => {
    await withDirectory("piece-fallback-project-level-", async (workspace) => {
      await createGoModule(workspace);
      const result = await planPieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis({ level: "piece", fallbackRequired: false, reasons: [] }),
        request: { level: "project", profile: "go", action: "build" },
        policy: { profiles: { go: { root: ".", allowActions: ["build"] } } }
      });

      expect(result).toMatchObject({
        status: "planned",
        scope: { level: "piece", fallbackRequired: false },
        plan: { level: "project", command: "go", args: ["build", "./..."] }
      });
    });
  });

  it.runIf(process.platform !== "win32")("executes only an allowlisted Go action in a controlled environment", async () => {
    await withDirectory("piece-fallback-go-execute-", async (workspace) => {
      const bin = join(workspace, "bin");
      await mkdir(bin);
      await createGoModule(workspace);
      await writeFakeCommand(
        bin,
        "go",
        "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), allowed: process.env.PIECE_FALLBACK_ALLOWED, secret: process.env.PIECE_FALLBACK_SECRET ?? null }));"
      );
      const oldSecret = process.env.PIECE_FALLBACK_SECRET;
      process.env.PIECE_FALLBACK_SECRET = "must-not-leak";
      try {
        const result = await executePieceFallback({
          workspaceRoot: workspace,
          analysis: fallbackAnalysis(),
          request: { mode: "execute", profile: "go" },
          policy: controlledPolicy({ go: { root: ".", allowActions: ["test"] } }, bin)
        });

        expect(result.status).toBe("success");
        expect(JSON.parse(result.command.stdout)).toEqual({ args: ["test", "./..."], allowed: "yes", secret: null });
      } finally {
        if (oldSecret === undefined) delete process.env.PIECE_FALLBACK_SECRET;
        else process.env.PIECE_FALLBACK_SECRET = oldSecret;
      }
    });
  });

  it.runIf(process.platform !== "win32")("executes canonical Gradle and npm profile commands without real Gradle", async () => {
    await withDirectory("piece-fallback-execute-profiles-", async (workspace) => {
      const bin = join(workspace, "bin");
      await mkdir(bin);
      await writeFile(join(workspace, "settings.gradle.kts"), "rootProject.name = \"fixture\"\n", "utf8");
      await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { build: "echo build" } }), "utf8");
      await writeFakeCommand(workspace, "gradlew", "process.stdout.write(JSON.stringify(process.argv.slice(2))); ");
      await writeFakeCommand(bin, "npm", "process.stdout.write(JSON.stringify(process.argv.slice(2))); ");

      const gradle = await executePieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { mode: "execute", profile: "gradle", task: "check" },
        policy: controlledPolicy({ gradle: { root: ".", allowTasks: ["check"] } }, bin)
      });
      expect(gradle.status).toBe("success");
      expect(JSON.parse(gradle.command.stdout)).toEqual(["--no-daemon", "check"]);

      const typescript = await executePieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { mode: "execute", profile: "typescript", script: "build" },
        policy: controlledPolicy({ typescript: { root: ".", allowScripts: ["build"] } }, bin)
      });
      expect(typescript.status).toBe("success");
      expect(JSON.parse(typescript.command.stdout)).toEqual(["run", "build"]);
    });
  });

  it.runIf(process.platform !== "win32")("maps timeout, cancellation, and output limits to structured fallback diagnostics", async () => {
    await withDirectory("piece-fallback-limits-", async (workspace) => {
      const bin = join(workspace, "bin");
      await mkdir(bin);
      await createGoModule(workspace);
      await writeFakeCommand(
        bin,
        "go",
        "if (process.env.PIECE_FALLBACK_MODE === 'output') { process.stdout.write('x'.repeat(4096)); } else { setInterval(() => {}, 1000); }"
      );
      const profiles = { go: { root: ".", allowActions: ["test"] } };
      const timeout = await executePieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { mode: "execute", profile: "go" },
        policy: controlledPolicy(profiles, bin, {}, { timeoutMs: 25, killGraceMs: 10 })
      });
      expect(timeout).toMatchObject({ status: "error", diagnostics: [{ code: "fallback-action-timeout" }] });

      const output = await executePieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { mode: "execute", profile: "go" },
        policy: controlledPolicy(profiles, bin, { PIECE_FALLBACK_MODE: "output" }, { maxOutputBytes: 32, killGraceMs: 10 })
      });
      expect(output).toMatchObject({ status: "error", diagnostics: [{ code: "fallback-action-output-limit" }] });

      const controller = new AbortController();
      const cancellation = executePieceFallback({
        workspaceRoot: workspace,
        analysis: fallbackAnalysis(),
        request: { mode: "execute", profile: "go" },
        policy: controlledPolicy(profiles, bin, {}, { timeoutMs: 5_000, killGraceMs: 10 }),
        signal: controller.signal
      });
      setTimeout(() => controller.abort(), 20);
      await expect(cancellation).resolves.toMatchObject({ status: "error", diagnostics: [{ code: "fallback-action-cancelled" }] });
    });
  });
});
