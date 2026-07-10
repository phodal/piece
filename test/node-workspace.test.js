import { spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PieceWorkspaceError, analyzePieceWorkspace, createPieceWorkspaceSession, planPieceWorkspaceBuild } from "../src/node-workspace.js";

const GO_AVAILABLE = spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;

async function withWorkspace(callback) {
  const root = await mkdtemp(join(tmpdir(), "piece-workspace-test-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSource(root, relativePath, source) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf8");
  return path;
}

describe("Node workspace orchestration", () => {
  it("reuses SHA-compatible file-local analysis through a workspace session and only recomputes edits", async () => {
    await withWorkspace(async (root) => {
      const firstFile = await writeSource(root, "app/src/First.ts", "export const first = 1;\n");
      await writeSource(root, "app/src/Second.ts", "export const second = 2;\n");
      const calls = [];
      const analyzeFile = async ({ filePath, source }) => {
        calls.push({ filePath, source });
        return { manifest: { slices: [] }, graph: { edges: [] }, feedbackScope: { fallbackRequired: false } };
      };
      const session = createPieceWorkspaceSession({
        workspaceRoot: root,
        projects: [{ id: "app", root: "app", sourceRoots: ["src"] }],
        analyzeFile,
        analysisConcurrency: 2
      });

      const initial = await session.analyze();
      const unchanged = await session.analyze();
      await writeFile(firstFile, "export const first = 3;\n", "utf8");
      const edited = await session.analyze();

      expect(initial.metrics).toMatchObject({ freshFileAnalysisCount: 2, reusedFileCount: 0 });
      expect(unchanged.metrics).toMatchObject({ freshFileAnalysisCount: 0, reusedFileCount: 2 });
      expect(edited.metrics).toMatchObject({ freshFileAnalysisCount: 1, reusedFileCount: 1 });
      expect(calls.map((call) => basename(call.filePath))).toEqual(["First.ts", "Second.ts", "First.ts"]);
      expect(calls.at(-1)).toMatchObject({ source: "export const first = 3;\n" });
    });
  });

  it("bounds file-local analysis concurrency and invalidates a Kotlin companion set together", async () => {
    await withWorkspace(async (root) => {
      const firstKotlinFile = await writeSource(root, "kotlin/src/First.kt", "fun first() = second()\n");
      await writeSource(root, "kotlin/src/Second.kt", "fun second() = 2\n");
      await writeSource(root, "web/src/One.ts", "export const one = 1;\n");
      await writeSource(root, "web/src/Two.ts", "export const two = 2;\n");
      await writeSource(root, "web/src/Three.ts", "export const three = 3;\n");
      let activeTypeScript = 0;
      let peakTypeScript = 0;
      const calls = [];
      const analyzeFile = async ({ filePath, sourceFiles }) => {
        calls.push({ filePath, sourceFiles: [...(sourceFiles ?? [])] });
        if (filePath.endsWith(".ts")) {
          activeTypeScript += 1;
          peakTypeScript = Math.max(peakTypeScript, activeTypeScript);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
          activeTypeScript -= 1;
        }
        return { manifest: { slices: [] }, graph: { edges: [] }, feedbackScope: { fallbackRequired: false } };
      };
      const session = createPieceWorkspaceSession({
        workspaceRoot: root,
        projects: [
          { id: "kotlin", root: "kotlin", sourceRoots: ["src"] },
          { id: "web", root: "web", sourceRoots: ["src"] }
        ],
        analyzeFile,
        analysisConcurrency: 2
      });

      const initial = await session.analyze();
      const unchanged = await session.analyze();
      await writeFile(firstKotlinFile, "fun first() = second() + 1\n", "utf8");
      const kotlinEdited = await session.analyze();

      expect(peakTypeScript).toBe(2);
      expect(initial.metrics).toMatchObject({ freshFileAnalysisCount: 5, reusedFileCount: 0 });
      expect(unchanged.metrics).toMatchObject({ freshFileAnalysisCount: 0, reusedFileCount: 5 });
      expect(kotlinEdited.metrics).toMatchObject({ freshFileAnalysisCount: 2, reusedFileCount: 3 });
      expect(calls.filter((call) => call.filePath.endsWith(".kt"))).toHaveLength(4);
      expect(calls.filter((call) => call.filePath.endsWith(".kt")).every((call) => call.sourceFiles.length === 2)).toBe(true);
    });
  });

  it.runIf(GO_AVAILABLE && process.platform !== "win32")("batches Go package analysis once per changed package group", async () => {
    await withWorkspace(async (root) => {
      const firstFile = await writeSource(root, "go/src/First.go", "package demo\n\nfunc First() int { return Second() }\n");
      await writeSource(root, "go/src/Second.go", "package demo\n\nfunc Second() int { return 2 }\n");
      const session = createPieceWorkspaceSession({
        workspaceRoot: root,
        projects: [{ id: "go", root: "go", sourceRoots: ["src"] }]
      });

      const initial = await session.analyze();
      const unchanged = await session.analyze();
      await writeFile(firstFile, "package demo\n\nfunc First() int { return Second() + 1 }\n", "utf8");
      const edited = await session.analyze();

      expect(initial.metrics).toMatchObject({
        freshFileAnalysisCount: 2,
        reusedFileCount: 0,
        nativeBatchCount: 1,
        nativeBatchFileCount: 2
      });
      expect(unchanged.metrics).toMatchObject({
        freshFileAnalysisCount: 0,
        reusedFileCount: 2,
        nativeBatchCount: 0,
        nativeBatchFileCount: 0
      });
      expect(edited.metrics).toMatchObject({
        freshFileAnalysisCount: 2,
        reusedFileCount: 0,
        nativeBatchCount: 1,
        nativeBatchFileCount: 2
      });
      expect(edited.projects[0].files.map((file) => file.analysis.manifest.parser)).toEqual([
        "go-ast-declaration-extractor",
        "go-ast-declaration-extractor"
      ]);
      const firstAnalysis = initial.projects[0].files.find((file) => basename(file.filePath) === "First.go");
      expect(firstAnalysis).toBeDefined();
      expect(firstAnalysis.analysis.manifest.importBindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ local: "Second", imported: "Second", source: expect.stringMatching(/[\\/]go[\\/]src[\\/]Second\.go$/), kind: "named" })
        ])
      );
    });
  }, 30_000);

  it.runIf(GO_AVAILABLE && process.platform !== "win32")("keeps an unchanged Go package batch cached across an unrelated file edit", async () => {
    await withWorkspace(async (root) => {
      await writeSource(root, "mixed/src/Logic.go", "package mixed\n\nfunc Answer() int { return 42 }\n");
      const webFile = await writeSource(root, "mixed/src/View.ts", "export const view = 'one';\n");
      const session = createPieceWorkspaceSession({
        workspaceRoot: root,
        projects: [{ id: "mixed", root: "mixed", sourceRoots: ["src"] }]
      });

      const initial = await session.analyze();
      await writeFile(webFile, "export const view = 'two';\n", "utf8");
      const edited = await session.analyze();

      expect(initial.metrics).toMatchObject({ freshFileAnalysisCount: 2, nativeBatchCount: 1, nativeBatchFileCount: 1 });
      expect(edited.metrics).toMatchObject({
        freshFileAnalysisCount: 1,
        reusedFileCount: 1,
        nativeBatchCount: 0,
        nativeBatchFileCount: 0
      });
      expect(edited.projects[0].files.find((file) => basename(file.filePath) === "Logic.go")?.analysis.manifest.parser).toBe(
        "go-ast-declaration-extractor"
      );
    });
  }, 30_000);

  it("aggregates explicitly configured projects and emits stable dependency-first fallback batches", async () => {
    await withWorkspace(async (root) => {
      const sharedFile = await writeSource(root, "packages/shared/src/shared.ts", 'export const shared = "ready";\n');
      await writeSource(
        root,
        "apps/web/src/App.ts",
        'import { shared } from "../../../packages/shared/src/shared";\nexport const App = () => shared;\n'
      );

      const workspace = await analyzePieceWorkspace({
        workspaceRoot: root,
        projects: [
          {
            id: "web",
            root: "apps/web",
            sourceRoots: ["src"],
            fallback: { command: "npm", args: ["run", "build"] }
          },
          {
            id: "shared",
            root: "packages/shared",
            sourceRoots: ["src"],
            fallback: { command: "npm", args: ["run", "build"] }
          }
        ]
      });

      expect(workspace.metrics).toMatchObject({ projectCount: 2, sourceFileCount: 2, analyzedFileCount: 2, analysisErrorCount: 0 });
      expect(workspace.projects.map((project) => [project.id, project.metrics.sourceFileCount, project.metrics.analyzedFileCount])).toEqual([
        ["shared", 1, 1],
        ["web", 1, 1]
      ]);
      expect(workspace.projectGraph.edges).toContainEqual(
        expect.objectContaining({ from: "web", to: "shared", kind: "resolved-source" })
      );

      const plan = planPieceWorkspaceBuild(workspace, { changedFiles: [sharedFile] });
      expect(plan).toMatchObject({ executionMode: "project-fallback", status: "ready", selectedProjects: ["shared", "web"] });
      expect(plan.batches.map((batch) => batch.actions.map((action) => action.projectId))).toEqual([["shared"], ["web"]]);
      expect(plan.actions).toContainEqual(
        expect.objectContaining({
          projectId: "web",
          kind: "project-fallback",
          cache: { status: "bypass", reason: "workspace-project-fallback-cache-not-enabled" },
          dependsOn: ["//workspace:shared%project-fallback"]
        })
      );
    });
  });

  it("fails closed to every project when a changed source no longer matches the analyzed snapshot", async () => {
    await withWorkspace(async (root) => {
      const webFile = await writeSource(root, "apps/web/src/Web.ts", 'export const web = "ready";\n');
      await writeSource(root, "libraries/newlib/src/library.ts", "export const library = 1;\n");
      const workspace = await analyzePieceWorkspace({
        workspaceRoot: root,
        projects: [
          { id: "web", root: "apps/web", sourceRoots: ["src"] },
          { id: "newlib", root: "libraries/newlib", sourceRoots: ["src"] }
        ]
      });
      expect(workspace.projects.find((project) => project.id === "web")?.files[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);

      await writeFile(
        webFile,
        'import { library } from "../../../libraries/newlib/src/library";\nexport const web = library;\n',
        "utf8"
      );
      const plan = planPieceWorkspaceBuild(workspace, { changedFiles: [webFile] });

      expect(plan).toMatchObject({ status: "fallback", selectedProjects: ["newlib", "web"] });
      for (const action of plan.actions) {
        expect(action.reasons).toContainEqual(expect.objectContaining({ code: "workspace-snapshot-stale", snapshotState: "content-changed" }));
      }
    });
  });

  it("turns missing dependencies, dependency cycles, and unresolved relative imports into explicit fallback reasons", async () => {
    await withWorkspace(async (root) => {
      await writeSource(root, "a/src/A.ts", "export const a = 1;\n");
      await writeSource(root, "b/src/B.ts", "export const b = 2;\n");
      await writeSource(root, "c/src/C.ts", 'import { missing } from "./missing";\nexport const c = missing;\n');

      const workspace = await analyzePieceWorkspace({
        workspaceRoot: root,
        projects: [
          { id: "a", root: "a", sourceRoots: ["src"], dependsOn: ["b", "missing"] },
          { id: "b", root: "b", sourceRoots: ["src"], dependsOn: ["a"] },
          { id: "c", root: "c", sourceRoots: ["src"] }
        ]
      });
      const plan = planPieceWorkspaceBuild(workspace);

      expect(plan.status).toBe("fallback");
      expect(plan.actions.find((action) => action.projectId === "a")?.reasons.map((reason) => reason.code)).toEqual(
        expect.arrayContaining(["workspace-project-dependency-missing", "workspace-project-dependency-cycle"])
      );
      expect(plan.actions.find((action) => action.projectId === "c")?.reasons.map((reason) => reason.code)).toContain(
        "workspace-relative-import-unresolved"
      );
      expect(plan.batches.some((batch) => batch.kind === "cycle-fallback" && batch.parallelSafe === false)).toBe(true);
    });
  });

  it("rejects source roots that escape the explicit workspace project", async () => {
    await withWorkspace(async (root) => {
      await expect(
        analyzePieceWorkspace({
          workspaceRoot: root,
          projects: [{ id: "escape", root: ".", sourceRoots: ["../outside"] }]
        })
      ).rejects.toMatchObject({ name: PieceWorkspaceError.name, code: "workspace-path-escape" });
    });
  });

  it("rejects the U+001F project id that would collide with an SCC component key", async () => {
    await withWorkspace(async (root) => {
      await expect(
        analyzePieceWorkspace({
          workspaceRoot: root,
          projects: [
            { id: "a", root: "." },
            { id: "b", root: "." },
            { id: "a\u001fb", root: "." }
          ]
        })
      ).rejects.toMatchObject({ name: PieceWorkspaceError.name, code: "invalid-workspace-project-id" });
    });
  });

  it("uses collision-free component keys even for a manually supplied legacy workspace analysis", () => {
    const delimiterId = "a\u001fb";
    const plan = planPieceWorkspaceBuild({
      kind: "piece-workspace",
      workspaceRoot: "/workspace",
      projects: [
        { id: "a", root: "/workspace/a", language: "typescript", fallbackReasons: [] },
        { id: "b", root: "/workspace/b", language: "typescript", fallbackReasons: [] },
        { id: delimiterId, root: "/workspace/c", language: "typescript", fallbackReasons: [] }
      ],
      projectGraph: {
        edges: [
          { from: "a", to: "b", kind: "declared" },
          { from: "b", to: "a", kind: "declared" }
        ],
        fallbackReasons: {}
      }
    });

    expect(plan.selectedProjects).toEqual(["a", delimiterId, "b"]);
    expect(plan.actions.map((action) => action.projectId)).toEqual(["a", delimiterId, "b"]);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].actions.map((action) => action.projectId)).toEqual(["a", delimiterId, "b"]);
  });

  it("rejects side-effecting analyzer controls before a configured Go tool can start", async () => {
    await withWorkspace(async (root) => {
      await writeSource(root, "main.go", "package main\nfunc main() {}\n");
      const sentinel = join(root, "fake-go-ran");
      const fakeGo = join(root, "fake-go");
      await writeFile(fakeGo, `#!${process.execPath}\nrequire(\"node:fs\").writeFileSync(${JSON.stringify(sentinel)}, \"ran\");\n`, "utf8");
      await chmod(fakeGo, 0o755);

      const unsafeFields = {
        goCommand: fakeGo,
        gradleCommand: fakeGo,
        env: { PATH: root },
        actionRunner: { timeoutMs: 1 },
        declarationExtractor: { name: "unsafe", extract() {} }
      };
      for (const [field, value] of Object.entries(unsafeFields)) {
        await expect(
          analyzePieceWorkspace({
            workspaceRoot: root,
            projects: [{ id: "go", root: ".", analysisOptions: { [field]: value } }]
          })
        ).rejects.toMatchObject({ name: PieceWorkspaceError.name, code: "invalid-workspace-analysis-options" });
      }
      await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("forwards only cloned, pure analysis data to a host-provided analyzer", async () => {
    await withWorkspace(async (root) => {
      await writeSource(root, "src/main.ts", "export const answer = 42;\n");
      const compilerOptions = { target: "es2022", nested: { strict: true }, conditions: ["browser"] };
      const globals = ["window"];
      let received;
      await analyzePieceWorkspace({
        workspaceRoot: root,
        projects: [
          {
            id: "app",
            root: ".",
            sourceRoots: ["src"],
            analysisOptions: {
              globals,
              packageScopeSelection: "safe",
              sourceSetScopeSelection: "current-file",
              compilerOptions
            }
          }
        ],
        async analyzeFile(options) {
          received = options;
          return { manifest: { slices: [] }, graph: { edges: [] }, feedbackScope: { fallbackRequired: false, level: "piece" } };
        }
      });

      expect(received).toMatchObject({
        globals,
        packageScopeSelection: "safe",
        sourceSetScopeSelection: "current-file",
        compilerOptions
      });
      expect(received.globals).not.toBe(globals);
      expect(received.compilerOptions).not.toBe(compilerOptions);
      expect(received.compilerOptions.nested).not.toBe(compilerOptions.nested);
      expect(received.compilerOptions.conditions).not.toBe(compilerOptions.conditions);
    });
  });

  it("bounds the total nested data accepted in compilerOptions", async () => {
    await withWorkspace(async (root) => {
      const compilerOptions = { entries: Array.from({ length: 5_001 }, () => ({ enabled: true })) };
      await expect(
        analyzePieceWorkspace({
          workspaceRoot: root,
          projects: [{ id: "app", root: ".", analysisOptions: { compilerOptions } }]
        })
      ).rejects.toMatchObject({ name: PieceWorkspaceError.name, code: "invalid-workspace-analysis-options" });
    });
  });
});
