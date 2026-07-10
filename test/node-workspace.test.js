import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PieceWorkspaceError, analyzePieceWorkspace, planPieceWorkspaceBuild } from "../src/node-workspace.js";

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
});
