import { transform } from "esbuild";
import { describe, expect, it } from "vitest";
import { createNodeEsbuildBuildEngine, createNodeVirtualFileSystem } from "piece-compiler/node";
import {
  compilePieceApp,
  createPieceCompiler,
  createPieceSnapshot,
  reconcilePieceSnapshot
} from "piece-compiler";

function sampleSource() {
  return `import { Tag } from "antd";

interface User {
  id: string;
  status: "active" | "disabled";
}

interface UserCardProps {
  user: User;
}

const statusColorMap = {
  active: "green",
  disabled: "gray"
};

export function UserCard(props: UserCardProps) {
  return <Tag color={statusColorMap[props.user.status]}>{props.user.id}</Tag>;
}

export function OtherCard() {
  return <div>Other</div>;
}
`;
}

function kotlinSource() {
  return `package demo.pricing

import demo.flags.FeatureFlag

data class User(val id: String, val name: String)
data class Greeting(val message: String)

private val prefix = "Hello"

fun renderGreeting(user: User): Greeting {
  return Greeting(prefix + ", " + user.name)
}

class Greeter {
  fun render(user: User): Greeting = renderGreeting(user)
}
`;
}

function changedRange(previousSource, nextSource) {
  let startByte = 0;
  while (startByte < previousSource.length && startByte < nextSource.length && previousSource[startByte] === nextSource[startByte]) {
    startByte += 1;
  }

  let previousEnd = previousSource.length;
  let nextEnd = nextSource.length;
  while (previousEnd > startByte && nextEnd > startByte && previousSource[previousEnd - 1] === nextSource[nextEnd - 1]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    startByte,
    endByte: Math.max(startByte + 1, nextEnd),
    startLine: previousSource.slice(0, startByte).split("\n").length,
    endLine: nextSource.slice(0, nextEnd).split("\n").length
  };
}

describe("piece compiler", () => {
  it("builds a declaration manifest and separates runtime, type, and external graph edges", async () => {
    const compiler = createPieceCompiler();
    const analysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: sampleSource()
    });

    expect(analysis.manifest.slices.map((slice) => [slice.kind, slice.name, slice.preview.previewable])).toEqual([
      ["type", "User", false],
      ["type", "UserCardProps", false],
      ["value", "statusColorMap", false],
      ["function", "UserCard", true],
      ["function", "OtherCard", true]
    ]);
    expect(analysis.graph.edges.map((edge) => [edge.from.split("#")[1], edge.kind, edge.to.split("#")[1] ?? edge.to, edge.symbols])).toEqual([
      ["function:UserCard", "type", "type:UserCardProps", ["UserCardProps"]],
      ["function:UserCard", "runtime", "value:statusColorMap", ["statusColorMap"]],
      ["function:UserCard", "external", "Tag", ["Tag"]],
      ["type:UserCardProps", "type", "type:User", ["User"]]
    ]);
  });

  it("maps TypeScript-family pieces into a Bazel-like single-file package", async () => {
    const compiler = createPieceCompiler();
    const analysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: sampleSource()
    });

    expect(analysis.piecePackage).toMatchObject({
      kind: "single-file-package",
      language: "typescript",
      packageName: "repo/src",
      label: "//repo/src:DashboardPage.tsx"
    });
    expect(analysis.piecePackage.targets.map((target) => [target.rule, target.label])).toContainEqual([
      "typescript_piece_function",
      "//repo/src:DashboardPage.tsx__function_UserCard"
    ]);
  });

  it("creates a minimal closure module for a preview target", async () => {
    const compiler = createPieceCompiler();
    const preview = await compiler.buildPreview({
      filePath: "/repo/src/DashboardPage.tsx",
      source: sampleSource(),
      target: "UserCard"
    });

    const closureSource = preview.virtualModules.files[preview.virtualModules.closurePath];
    expect(preview.closure.runtimeSlices.map((id) => id.split("#")[1])).toEqual(["value:statusColorMap", "function:UserCard"]);
    expect(preview.closure.typeSlices.map((id) => id.split("#")[1])).toEqual(["type:User", "type:UserCardProps"]);
    expect(preview.closure.externalImports).toEqual([
      { local: "Tag", imported: "Tag", source: "antd", kind: "named", isTypeOnly: false }
    ]);
    expect(closureSource).toContain("interface User ");
    expect(closureSource).toContain("const statusColorMap");
    expect(closureSource).toContain("export function UserCard");
    expect(closureSource).not.toContain("function OtherCard");
  });

  it("compiles virtual closure modules with node esbuild", async () => {
    const source = `import * as React from "react";

interface UserCardProps {
  name: string;
}

const label = "Hello";

export function UserCard(props: UserCardProps) {
  return <section>{label} {props.name}</section>;
}
`;
    const compiler = createPieceCompiler();
    const preview = await compiler.buildPreview({
      filePath: "/repo/src/UserCard.tsx",
      source,
      target: "UserCard",
      buildEngine: createNodeEsbuildBuildEngine()
    });

    expect(preview.bundle?.code).toContain("UserCard");
    expect(preview.bundle?.entryPath).toBe("/@preview/UserCard.UserCard.entry.tsx");
    expect(preview.metrics.closureBytes).toBeGreaterThan(0);
  });

  it("can compile a closure preview with the transform strategy", async () => {
    let buildCalled = false;
    const compiler = createPieceCompiler();
    const preview = await compiler.buildPreview({
      filePath: "/repo/src/UserCard.tsx",
      source: `import * as React from "react";

export function UserCard() {
  return <section>Ready</section>;
}
`,
      target: "UserCard",
      compileStrategy: "transform",
      buildEngine: {
        name: "transform-test-engine",
        async build() {
          buildCalled = true;
          throw new Error("build should not be called");
        },
        transform
      }
    });

    expect(buildCalled).toBe(false);
    expect(preview.bundle?.compileStrategy).toBe("transform");
    expect(preview.bundle?.code).toContain("createRoot");
  });

  it("returns standalone compile status for a piece preview", async () => {
    const status = await compilePieceApp({
      filePath: "/repo/src/DashboardPage.tsx",
      source: sampleSource(),
      target: "UserCard",
      piece: { id: "DashboardPage" }
    });

    expect(status.compiler).toBe("piece-compiler");
    expect(status).not.toHaveProperty("compatibility");
    expect(status.piece.mode).toBe("standalone");
    expect(status.preview?.target.split("#")[1]).toBe("function:UserCard");
    expect(status.sourceFileCount).toBe(1);
  });

  it("normalizes source from a virtual file system", async () => {
    const files = new Map([["/repo/src/DashboardPage.tsx", sampleSource()]]);
    const fileSystem = {
      kind: "memory",
      cwd: "/repo",
      async readText(path) {
        return files.get(path);
      },
      async collectSourceFiles() {
        return [...files.keys()];
      }
    };
    const compiler = createPieceCompiler({ fileSystem, sourceRoots: ["/repo/src"] });
    const normalized = await compiler.normalize({ entry: "/repo/src/DashboardPage.tsx" });

    expect(normalized.source).toBe(sampleSource());
    expect(normalized.sourceFiles).toEqual(["/repo/src/DashboardPage.tsx"]);
  });

  it("creates a node virtual file system with stable path helpers", async () => {
    const fileSystem = createNodeVirtualFileSystem({ cwd: process.cwd() });

    expect(fileSystem.kind).toBe("node");
    expect(fileSystem.toAbsolutePath("src/index.js")).toBe(`${process.cwd()}/src/index.js`);
    expect(fileSystem.relativePath(`${process.cwd()}/src/index.js`)).toBe("src/index.js");
  });

  it("uses incremental analysis only when a changed range stays inside one declaration", async () => {
    const compiler = createPieceCompiler();
    const previousSource = sampleSource();
    const previousAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: previousSource
    });
    const nextSource = previousSource.replace("statusColorMap[props.user.status]", "statusColorMap[props.user.status] ?? \"black\"");
    const editResult = await compiler.applyEdit({
      filePath: "/repo/src/DashboardPage.tsx",
      source: nextSource,
      previousAnalysis,
      changedRanges: [changedRange(previousSource, nextSource)]
    });

    expect(editResult.analysis.metrics.incremental).toBe(true);
    expect(editResult.edit.changedSlices.map((id) => id.split("#")[1])).toEqual(["function:UserCard"]);
    expect(editResult.affectedTargets.map((id) => id.split("#")[1])).toEqual(["function:UserCard"]);
  });

  it("reconciles declaration snapshots with stable piece identities and artifact reuse", async () => {
    const compiler = createPieceCompiler();
    const previousSource = sampleSource();
    const previousAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: previousSource
    });
    const previousSnapshot = createPieceSnapshot({ analysis: previousAnalysis });
    const nextSource = previousSource.replace('status: "active" | "disabled";', 'status: "active" | "disabled" | "paused";');
    const nextAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: nextSource
    });
    const reconciliation = reconcilePieceSnapshot({
      previousSnapshot,
      analysis: nextAnalysis,
      changedRanges: [changedRange(previousSource, nextSource)]
    });

    expect(reconciliation.changedPieces.map((id) => id.split("#")[1])).toEqual(["type:User"]);
    expect(reconciliation.publicShapeChangedPieces.map((id) => id.split("#")[1])).toEqual(["type:User"]);
    expect(reconciliation.affectedTargets.map((id) => id.split("#")[1])).toEqual(["function:UserCard"]);
    expect(reconciliation.reusedArtifactIds.map((id) => id.split("#")[1])).toEqual(["function:OtherCard", "value:statusColorMap"]);
  });

  it("extracts Kotlin single-file pieces and exposes Bazel-like targets", async () => {
    const compiler = createPieceCompiler();
    const analysis = await compiler.analyzeFile({
      filePath: "/repo/src/Pricing.kt",
      source: kotlinSource()
    });

    expect(analysis.manifest.parser).toBe("kotlin-declaration-extractor");
    expect(analysis.manifest.importBindings).toEqual([
      { local: "FeatureFlag", imported: "FeatureFlag", source: "demo.flags", kind: "named", isTypeOnly: false }
    ]);
    expect(analysis.manifest.slices.map((slice) => [slice.kind, slice.name, slice.preview.previewable])).toEqual([
      ["class", "User", true],
      ["class", "Greeting", true],
      ["value", "prefix", false],
      ["function", "renderGreeting", true],
      ["class", "Greeter", true]
    ]);
    expect(analysis.graph.edges.map((edge) => [edge.from.split("#")[1], edge.kind, edge.to.split("#")[1] ?? edge.to, edge.symbols])).toEqual([
      ["class:Greeter", "type", "class:Greeting", ["Greeting"]],
      ["class:Greeter", "type", "class:User", ["User"]],
      ["class:Greeter", "runtime", "function:renderGreeting", ["renderGreeting"]],
      ["function:renderGreeting", "type", "class:Greeting", ["Greeting"]],
      ["function:renderGreeting", "type", "class:User", ["User"]],
      ["function:renderGreeting", "runtime", "value:prefix", ["prefix"]]
    ]);
    expect(analysis.piecePackage).toMatchObject({
      language: "kotlin",
      label: "//repo/src:Pricing.kt"
    });
    expect(analysis.piecePackage.targets.map((target) => [target.rule, target.label])).toContainEqual([
      "kotlin_piece_function",
      "//repo/src:Pricing.kt__function_renderGreeting"
    ]);
  });

  it("rebuilds Kotlin affected targets with full reanalysis while preserving React incremental behavior", async () => {
    const compiler = createPieceCompiler();
    const previousSource = kotlinSource();
    const previousAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/Pricing.kt",
      source: previousSource
    });
    const nextSource = previousSource.replace('"Hello"', '"Hi"');
    const editResult = await compiler.applyEdit({
      filePath: "/repo/src/Pricing.kt",
      source: nextSource,
      previousAnalysis,
      changedRanges: [changedRange(previousSource, nextSource)]
    });

    expect(editResult.analysis.metrics.incremental).toBeUndefined();
    expect(editResult.edit.changedSlices.map((id) => id.split("#")[1])).toEqual(["value:prefix"]);
    expect(editResult.affectedTargets.map((id) => id.split("#")[1])).toEqual(["class:Greeter", "function:renderGreeting"]);
  });
});
