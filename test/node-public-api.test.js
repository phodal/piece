import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzePieceWorkspace,
  createPieceWorkspaceCompiler,
  createPieceWorkspaceSession,
  executePieceFallback,
  planPieceFallback,
  planPieceWorkspaceBuild
} from "piece-compiler/node";

async function withWorkspace(callback) {
  const root = await mkdtemp(join(tmpdir(), "piece-node-public-api-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Node public API", () => {
  it("exports workspace and fallback APIs through piece-compiler/node without an import cycle failure", async () => {
    expect(typeof analyzePieceWorkspace).toBe("function");
    expect(typeof planPieceWorkspaceBuild).toBe("function");
    expect(typeof createPieceWorkspaceCompiler).toBe("function");
    expect(typeof createPieceWorkspaceSession).toBe("function");
    expect(typeof planPieceFallback).toBe("function");
    expect(typeof executePieceFallback).toBe("function");

    await withWorkspace(async (workspaceRoot) => {
      await mkdir(join(workspaceRoot, "src"));
      await writeFile(join(workspaceRoot, "src", "App.ts"), "export const App = () => 'ready';\n", "utf8");
      const workspace = await analyzePieceWorkspace({
        workspaceRoot,
        projects: [{ id: "app", root: ".", sourceRoots: ["src"] }]
      });
      const compiler = createPieceWorkspaceCompiler({ workspaceRoot, projects: [{ id: "app", root: ".", sourceRoots: ["src"] }] });
      const repeated = await compiler.analyze();
      const plan = planPieceWorkspaceBuild(workspace);

      expect(repeated.metrics.analyzedFileCount).toBe(1);
      expect(plan).toMatchObject({ kind: "piece-workspace-build-plan", selectedProjects: ["app"] });

      await writeFile(join(workspaceRoot, "go.mod"), "module example.com/public-api\n\ngo 1.22\n", "utf8");
      const fallback = await planPieceFallback({
        workspaceRoot,
        analysis: { feedbackScope: { level: "project", fallbackRequired: true, reasons: [] } },
        request: { profile: "go" },
        policy: { profiles: { go: { root: ".", allowActions: ["test"] } } }
      });
      expect(fallback).toMatchObject({ status: "planned", plan: { command: "go", args: ["test", "./..."] } });
    });
  });
});
