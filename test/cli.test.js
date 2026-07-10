import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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

async function writeFakeCommand(directory, name, program) {
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\n${program}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

async function writeProject(workspace, projectRoot, { source = "export const value = 1;\n", scripts = { build: "echo build", check: "echo check" } } = {}) {
  await mkdir(join(workspace, projectRoot, "src"), { recursive: true });
  await writeFile(join(workspace, projectRoot, "src", "index.ts"), source, "utf8");
  await writeFile(join(workspace, projectRoot, "package.json"), `${JSON.stringify({ private: true, scripts })}\n`, "utf8");
}

function controlledTypeScriptTask({ script, bin, logPath, outputs, environment = {} }) {
  return {
    request: { profile: "typescript", script },
    policy: {
      profiles: {
        typescript: {
          root: ".",
          packageManager: "npm",
          allowScripts: [script]
        }
      },
      envAllowlist: ["PATH", "PIECE_CLI_LOG", "PIECE_CLI_FAIL_SHARED", "PIECE_CLI_SKIP_OUTPUT", "PIECE_CLI_OUTPUT_TARGET"],
      env: {
        PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
        PIECE_CLI_LOG: logPath,
        ...environment
      },
      timeoutMs: 5_000,
      maxOutputBytes: 32_768
    },
    ...(outputs === undefined ? {} : { outputs })
  };
}

function workspaceConfig({ bin, logPath, sharedEnvironment, webEnvironment, includeOutputs = true } = {}) {
  return {
    schemaVersion: 2,
    defaultProject: "web",
    projects: [
      {
        id: "shared",
        root: "packages/shared",
        sourceRoots: ["src"],
        dependsOn: [],
        build: controlledTypeScriptTask({
          script: "build",
          bin,
          logPath,
          outputs: includeOutputs ? ["dist"] : undefined,
          environment: sharedEnvironment
        }),
        check: controlledTypeScriptTask({ script: "check", bin, logPath, environment: sharedEnvironment })
      },
      {
        id: "web",
        root: "apps/web",
        sourceRoots: ["src"],
        dependsOn: ["shared"],
        build: controlledTypeScriptTask({
          script: "build",
          bin,
          logPath,
          outputs: includeOutputs ? ["dist"] : undefined,
          environment: webEnvironment
        }),
        check: controlledTypeScriptTask({ script: "check", bin, logPath, environment: webEnvironment })
      }
    ]
  };
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

  it.runIf(process.platform !== "win32")("builds and checks an explicit v2 project closure through controlled native fallback tasks", async () => {
    await withWorkspace(async (workspace) => {
      const bin = join(workspace, "bin");
      const logPath = join(workspace, "task.log");
      await mkdir(bin);
      await writeFakeCommand(
        bin,
        "npm",
        [
          'const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");',
          'const { basename } = require("node:path");',
          'const script = process.argv[3] ?? "";',
          'const project = basename(process.cwd());',
          'appendFileSync(process.env.PIECE_CLI_LOG, project + ":" + script + "\\n");',
          'if (project === "shared" && process.env.PIECE_CLI_FAIL_SHARED === "1") process.exit(9);',
          'if (script === "build" && process.env.PIECE_CLI_SKIP_OUTPUT !== "1") {',
          '  mkdirSync("dist", { recursive: true });',
          '  writeFileSync("dist/build.txt", project);',
          '}'
        ].join("\n")
      );
      await writeProject(workspace, "packages/shared");
      await writeProject(workspace, "apps/web");
      await writeFile(join(workspace, "piece.config.json"), `${JSON.stringify(workspaceConfig({ bin, logPath }), null, 2)}\n`, "utf8");

      const build = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(build.exitCode).toBe(0);
      expect(build.stderr).toBe("");
      const buildBody = JSON.parse(build.stdout);
      expect(buildBody).toMatchObject({
        schemaVersion: 1,
        command: "build",
        status: "success",
        exitCode: 0,
        selection: { projectId: "web", provenance: "config-default", closure: ["shared", "web"] },
        scope: { kind: "declared-workspace-project-graph", workspaceOrchestration: "configured-native-fallback" },
        workspace: { path: await realpath(workspace), provenance: "flag" },
        config: { schemaVersion: 2 },
        invocation: { format: "json", formatProvenance: "flag", color: "not-emitted" }
      });
      expect(buildBody.projects.map((project) => [project.id, project.execution.status, project.execution.outputVerification])).toEqual([
        ["shared", "success", "verified"],
        ["web", "success", "verified"]
      ]);
      expect(buildBody.projects.flatMap((project) => project.outputs.map((output) => output.workspaceRelativePath))).toEqual([
        "packages/shared/dist",
        "apps/web/dist"
      ]);
      expect(buildBody.scope.guarantees).toContain("declared-build-outputs-verified-on-success");
      expect(await readFile(logPath, "utf8")).toBe("shared:build\nweb:build\n");

      await writeFile(logPath, "", "utf8");
      const check = await invokePiece(["check", "web", "--workspace", workspace, "--format", "json"]);
      expect(check.exitCode).toBe(0);
      const checkBody = JSON.parse(check.stdout);
      expect(checkBody).toMatchObject({
        command: "check",
        status: "success",
        selection: { projectId: "web", provenance: "argument", closure: ["shared", "web"] }
      });
      expect(checkBody.scope.guarantees).toContain("configured-native-project-checks-succeeded");
      expect(await readFile(logPath, "utf8")).toBe("shared:check\nweb:check\n");

      const human = await invokePiece(["build", "web", "--workspace", workspace]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toBe("");
      expect(human.stderr).toContain("piece build success");

      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify(workspaceConfig({ bin, logPath, includeOutputs: false }), null, 2)}\n`,
        "utf8"
      );
      const noDeclaredOutputs = await invokePiece(["build", "web", "--workspace", workspace, "--format", "json"]);
      expect(noDeclaredOutputs.exitCode).toBe(0);
      expect(JSON.parse(noDeclaredOutputs.stdout).projects.map((project) => project.execution.outputVerification)).toEqual([
        "not-configured",
        "not-configured"
      ]);
      expect(JSON.parse(noDeclaredOutputs.stdout).scope.guarantees).not.toContain("declared-build-outputs-verified-on-success");
    });
  });

  it("runs independent topological workspace actions concurrently while retaining dependency order", async () => {
    await withWorkspace(async (workspace) => {
      const logPath = join(workspace, "parallel.log");
      const delayedBuild = (project) =>
        `node -e "const { appendFileSync } = require('node:fs'); const log = process.env.PIECE_PARALLEL_LOG; appendFileSync(log, '${project}:start:' + Date.now() + '\\n'); setTimeout(() => { appendFileSync(log, '${project}:end:' + Date.now() + '\\n'); }, 250);"`;
      await writeProject(workspace, "a", { scripts: { build: delayedBuild("a"), check: "node -e \"process.exit(0)\"" } });
      await writeProject(workspace, "b", { scripts: { build: delayedBuild("b"), check: "node -e \"process.exit(0)\"" } });
      await writeProject(workspace, "app", { scripts: { build: delayedBuild("app"), check: "node -e \"process.exit(0)\"" } });
      const task = (script) => ({
        request: { profile: "typescript", script },
        policy: {
          profiles: { typescript: { root: ".", allowScripts: [script] } },
          envAllowlist: ["PATH", "PIECE_PARALLEL_LOG"],
          env: { PIECE_PARALLEL_LOG: logPath }
        }
      });
      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify({
          schemaVersion: 2,
          defaultProject: "app",
          projects: [
            { id: "a", root: "a", sourceRoots: ["src"], dependsOn: [], build: task("build"), check: task("check") },
            { id: "b", root: "b", sourceRoots: ["src"], dependsOn: [], build: task("build"), check: task("check") },
            { id: "app", root: "app", sourceRoots: ["src"], dependsOn: ["a", "b"], build: task("build"), check: task("check") }
          ]
        })}\n`,
        "utf8"
      );

      const result = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      const events = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const [project, event, timestamp] = line.split(":");
          return { project, event, timestamp: Number(timestamp) };
        });
      const time = (project, event) => events.find((entry) => entry.project === project && entry.event === event)?.timestamp;
      expect(time("a", "start")).toBeLessThan(time("b", "end"));
      expect(time("b", "start")).toBeLessThan(time("a", "end"));
      expect(time("app", "start")).toBeGreaterThanOrEqual(Math.max(time("a", "end"), time("b", "end")));
      expect(JSON.parse(result.stdout).projects.map((project) => project.id)).toEqual(["a", "b", "app"]);
    });
  });

  it.runIf(process.platform !== "win32")("blocks downstream projects after a configured fallback task fails and rejects missing declared outputs", async () => {
    await withWorkspace(async (workspace) => {
      const bin = join(workspace, "bin");
      const logPath = join(workspace, "task.log");
      await mkdir(bin);
      await writeFakeCommand(
        bin,
        "npm",
        [
          'const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");',
          'const { basename } = require("node:path");',
          'const script = process.argv[3] ?? "";',
          'const project = basename(process.cwd());',
          'appendFileSync(process.env.PIECE_CLI_LOG, project + ":" + script + "\\n");',
          'if (project === "shared" && process.env.PIECE_CLI_FAIL_SHARED === "1") process.exit(9);',
          'if (script === "build" && process.env.PIECE_CLI_SKIP_OUTPUT !== "1") { mkdirSync("dist", { recursive: true }); writeFileSync("dist/build.txt", project); }'
        ].join("\n")
      );
      await writeProject(workspace, "packages/shared");
      await writeProject(workspace, "apps/web");
      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify(workspaceConfig({ bin, logPath, sharedEnvironment: { PIECE_CLI_FAIL_SHARED: "1" } }), null, 2)}\n`,
        "utf8"
      );

      const failed = await invokePiece(["build", "web", "--workspace", workspace, "--format", "json"]);
      expect(failed.exitCode).toBe(1);
      const failedBody = JSON.parse(failed.stdout);
      expect(failedBody.projects.map((project) => [project.id, project.execution.status])).toEqual([
        ["shared", "error"],
        ["web", "skipped"]
      ]);
      expect(failedBody.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "workspace-project-dependency-failed", projectId: "web" })])
      );
      expect(await readFile(logPath, "utf8")).toBe("shared:build\n");

      await writeFile(logPath, "", "utf8");
      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify(workspaceConfig({ bin, logPath, webEnvironment: { PIECE_CLI_SKIP_OUTPUT: "1" } }), null, 2)}\n`,
        "utf8"
      );
      const missingOutput = await invokePiece(["build", "web", "--workspace", workspace, "--format", "json"]);
      expect(missingOutput.exitCode).toBe(1);
      const missingOutputBody = JSON.parse(missingOutput.stdout);
      expect(missingOutputBody.projects.find((project) => project.id === "web")).toMatchObject({
        execution: { status: "error", outputVerification: "failed" },
        diagnostics: [expect.objectContaining({ code: "declared-build-output-missing" })]
      });
    });
  });

  it.runIf(process.platform !== "win32")("executes an allowlisted Go fallback profile through the schema v2 CLI", async () => {
    await withWorkspace(async (workspace) => {
      const bin = join(workspace, "bin");
      const logPath = join(workspace, "go.log");
      await mkdir(bin);
      await mkdir(join(workspace, "go", "src"), { recursive: true });
      await writeFile(join(workspace, "go", "go.mod"), "module example.com/fixture\n\ngo 1.22\n", "utf8");
      await writeFakeCommand(
        bin,
        "go",
        [
          'const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");',
          'appendFileSync(process.env.PIECE_CLI_LOG, process.argv.slice(2).join(" ") + "\\n");',
          'if (process.argv[2] === "build") { mkdirSync("out", { recursive: true }); writeFileSync("out/result.txt", "ok"); }'
        ].join("\n")
      );
      const policy = (action) => ({
        profiles: { go: { root: ".", allowActions: [action] } },
        envAllowlist: ["PATH", "PIECE_CLI_LOG"],
        env: { PATH: `${bin}${delimiter}${dirname(process.execPath)}`, PIECE_CLI_LOG: logPath }
      });
      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify(
          {
            schemaVersion: 2,
            defaultProject: "go",
            projects: [
              {
                id: "go",
                root: "go",
                sourceRoots: ["src"],
                dependsOn: [],
                build: { request: { profile: "go", action: "build" }, policy: policy("build"), outputs: ["out"] },
                check: { request: { profile: "go", action: "test" }, policy: policy("test") }
              }
            ]
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const result = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.projects).toEqual([
        expect.objectContaining({
          id: "go",
          execution: expect.objectContaining({ status: "success", profile: "go", outputVerification: "verified" })
        })
      ]);
      expect(await readFile(logPath, "utf8")).toBe("build ./...\n");
    });
  });

  it("strictly rejects invalid v2 workspace configuration before executing a fallback task", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, "app", "src"), { recursive: true });
      await writeFile(join(workspace, "app", "package.json"), `${JSON.stringify({ scripts: { build: "echo build", check: "echo check" } })}\n`, "utf8");
      const invalid = {
        schemaVersion: 2,
        defaultProject: "app",
        unexpected: true,
        projects: []
      };
      await writeFile(join(workspace, "piece.config.json"), `${JSON.stringify(invalid)}\n`, "utf8");
      const unknownKey = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(unknownKey.exitCode).toBe(2);
      expect(JSON.parse(unknownKey.stdout).diagnostics[0]).toMatchObject({ code: "unknown-workspace-config-key" });

      const unsafe = {
        schemaVersion: 2,
        defaultProject: "app",
        projects: [
          {
            id: "app",
            root: "app",
            sourceRoots: ["src"],
            build: {
              request: { profile: "typescript", script: "build", argv: ["sh", "-c", "unsafe"] },
              policy: { profiles: { typescript: { root: ".", allowScripts: ["build"] } }, envAllowlist: ["PATH"] },
              outputs: ["dist"]
            },
            check: {
              request: { profile: "typescript", script: "check" },
              policy: { profiles: { typescript: { root: ".", allowScripts: ["check"] } }, envAllowlist: ["PATH"] }
            }
          }
        ]
      };
      await writeFile(join(workspace, "piece.config.json"), `${JSON.stringify(unsafe)}\n`, "utf8");
      const unsafeRequest = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(unsafeRequest.exitCode).toBe(2);
      expect(JSON.parse(unsafeRequest.stdout).diagnostics[0]).toMatchObject({ code: "unknown-workspace-config-key" });

      const rootOutput = structuredClone(unsafe);
      delete rootOutput.projects[0].build.request.argv;
      rootOutput.projects[0].build.outputs = ["./"];
      await writeFile(join(workspace, "piece.config.json"), `${JSON.stringify(rootOutput)}\n`, "utf8");
      const rootOutputResult = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(rootOutputResult.exitCode).toBe(2);
      expect(JSON.parse(rootOutputResult.stdout).diagnostics[0]).toMatchObject({ code: "invalid-workspace-config" });

      await writeFile(join(workspace, "piece.config.json"), `${JSON.stringify({ schemaVersion: 1, entry: "app/src/index.ts" })}\n`, "utf8");
      await writeFile(join(workspace, "app", "src", "index.ts"), "export const app = true;\n", "utf8");
      const v1Build = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(v1Build.exitCode).toBe(2);
      expect(JSON.parse(v1Build.stdout).diagnostics[0]).toMatchObject({ code: "workspace-build-requires-config-v2" });
    });
  });

  it("requires a default project for an omitted selector and rejects incomplete or cyclic declared graphs", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, "app", "src"), { recursive: true });
      await writeFile(join(workspace, "app", "package.json"), `${JSON.stringify({ scripts: { build: "echo build", check: "echo check" } })}\n`, "utf8");
      const task = (script, outputs) => ({
        request: { profile: "typescript", script },
        policy: { profiles: { typescript: { root: ".", allowScripts: [script] } }, envAllowlist: ["PATH"] },
        ...(outputs ? { outputs } : {})
      });
      const project = () => ({
        id: "app",
        root: "app",
        sourceRoots: ["src"],
        dependsOn: [],
        build: task("build", ["dist"]),
        check: task("check")
      });

      await writeFile(join(workspace, "piece.config.json"), `${JSON.stringify({ schemaVersion: 2, projects: [project()] })}\n`, "utf8");
      const defaultMissing = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(defaultMissing.exitCode).toBe(2);
      expect(JSON.parse(defaultMissing.stdout).diagnostics[0]).toMatchObject({ code: "workspace-project-required" });

      const incomplete = project();
      delete incomplete.check;
      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify({ schemaVersion: 2, defaultProject: "app", projects: [incomplete] })}\n`,
        "utf8"
      );
      const missingCheck = await invokePiece(["check", "--workspace", workspace, "--format", "json"]);
      expect(missingCheck.exitCode).toBe(2);
      expect(JSON.parse(missingCheck.stdout).diagnostics[0]).toMatchObject({ code: "invalid-workspace-config" });

      const missingDependency = project();
      missingDependency.dependsOn = ["missing"];
      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify({ schemaVersion: 2, defaultProject: "app", projects: [missingDependency] })}\n`,
        "utf8"
      );
      const unknownDependency = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(unknownDependency.exitCode).toBe(2);
      expect(JSON.parse(unknownDependency.stdout).diagnostics[0]).toMatchObject({ code: "workspace-project-dependency-missing" });

      const cyclic = project();
      cyclic.dependsOn = ["app"];
      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify({ schemaVersion: 2, defaultProject: "app", projects: [cyclic] })}\n`,
        "utf8"
      );
      const cycle = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(cycle.exitCode).toBe(2);
      expect(JSON.parse(cycle.stdout).diagnostics[0]).toMatchObject({ code: "workspace-project-dependency-cycle" });
    });
  });

  it("reports source-derived workspace cycles as blocked rather than dependency failures", async () => {
    await withWorkspace(async (workspace) => {
      await writeProject(workspace, "a", {
        source: 'import { b } from "../../b/src";\nexport const a = () => b();\n'
      });
      await writeProject(workspace, "b", {
        source: 'import { a } from "../../a/src";\nexport const b = () => a();\n'
      });
      const task = (script) => ({
        request: { profile: "typescript", script },
        policy: { profiles: { typescript: { root: ".", allowScripts: [script] } }, envAllowlist: ["PATH"] }
      });
      await writeFile(
        join(workspace, "piece.config.json"),
        `${JSON.stringify({
          schemaVersion: 2,
          defaultProject: "a",
          projects: [
            { id: "a", root: "a", sourceRoots: ["src"], dependsOn: [], build: task("build"), check: task("check") },
            { id: "b", root: "b", sourceRoots: ["src"], dependsOn: [], build: task("build"), check: task("check") }
          ]
        })}\n`,
        "utf8"
      );

      const result = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
      expect(result.exitCode).toBe(1);
      const body = JSON.parse(result.stdout);
      expect(body.projects.map((project) => [project.id, project.execution.status, project.execution.reason])).toEqual([
        ["a", "blocked", "dependency-cycle"],
        ["b", "blocked", "dependency-cycle"]
      ]);
      expect(body.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "workspace-project-dependency-cycle", projectId: "a" }),
          expect.objectContaining({ code: "workspace-project-dependency-cycle", projectId: "b" })
        ])
      );
      expect(body.diagnostics).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "workspace-project-dependency-failed" })]));
    });
  });

  it.runIf(process.platform !== "win32")("fails a build when a declared output resolves through a symlink outside its project", async () => {
    await withWorkspace(async (workspace) => {
      const outside = await mkdtemp(join(tmpdir(), "piece-cli-output-outside-"));
      try {
        const bin = join(workspace, "bin");
        const logPath = join(workspace, "task.log");
        await mkdir(bin);
        await writeFakeCommand(
          bin,
          "npm",
          [
            'const { appendFileSync, symlinkSync } = require("node:fs");',
            'appendFileSync(process.env.PIECE_CLI_LOG, "build\\n");',
            'symlinkSync(process.env.PIECE_CLI_OUTPUT_TARGET, "dist", "dir");'
          ].join("\n")
        );
        await writeProject(workspace, "app");
        const task = controlledTypeScriptTask({
          script: "build",
          bin,
          logPath,
          outputs: ["dist"],
          environment: { PIECE_CLI_OUTPUT_TARGET: outside }
        });
        await writeFile(
          join(workspace, "piece.config.json"),
          `${JSON.stringify({
            schemaVersion: 2,
            defaultProject: "app",
            projects: [
              {
                id: "app",
                root: "app",
                sourceRoots: ["src"],
                dependsOn: [],
                build: task,
                check: controlledTypeScriptTask({ script: "check", bin, logPath })
              }
            ]
          })}\n`,
          "utf8"
        );
        const result = await invokePiece(["build", "--workspace", workspace, "--format", "json"]);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout).projects[0]).toMatchObject({
          execution: { status: "error", outputVerification: "failed" },
          diagnostics: [expect.objectContaining({ code: "declared-build-output-escape" })]
        });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
