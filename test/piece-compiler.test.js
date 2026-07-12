import { resolve } from "node:path";
import { transform } from "esbuild";
import { describe, expect, it } from "vitest";
import { compilePieceApp as compileNodePieceApp, createNodeEsbuildBuildEngine, createNodeVirtualFileSystem } from "piece-compiler/node";
import {
  compilePieceApp,
  createKotlinCoreBridge,
  createPackageScopeTargetModel,
  createPieceCompiler,
  createPieceActionCacheRecord,
  createPieceSnapshot,
  createFallbackDeclarationExtractor,
  createSourceSetScopeTargetModel,
  explainPieceActionCacheStatus,
  explainPieceFeedbackScope,
  mergePiecePackages,
  piecePackageToPicDsl,
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

function goSource() {
  return `package pricing

import "fmt"

type User struct {
  ID string
  Name string
}

type Greeting struct {
  Message string
}

const prefix = "Hello"

func RenderGreeting(user User) Greeting {
  fmt.Println(prefix)
  return Greeting{Message: prefix + ", " + user.Name}
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
    expect(analysis.pieceDsl).toContain("language typescript");
    expect(analysis.pieceDsl).toContain('target function "UserCard"');
    expect(analysis.pieceDsl).toContain('externalDeps "antd#Tag"');
    expect(analysis.pieceDslSource).toBe("current-file");
    expect(analysis.feedbackScope).toMatchObject({
      level: "piece",
      fallbackRequired: false
    });
    const userCardAction = analysis.piecePackage.actions.find((action) => action.id === "//repo/src:DashboardPage.tsx__function_UserCard%feedback");
    expect(userCardAction.inputs.some((input) => input.startsWith("source-hash:"))).toBe(true);
    expect(userCardAction.inputs.some((input) => input.startsWith("deps-hash:"))).toBe(true);
    expect(userCardAction.inputs.some((input) => input.startsWith("feedback-scope:"))).toBe(true);
    expect(analysis.snapshot.feedbackScope.hashes.fallbackScopeHash).toBe(analysis.feedbackScope.hashes.fallbackScopeHash);
  });

  it("includes compiler options and dependency artifacts in action cache identity", async () => {
    const compiler = createPieceCompiler();
    const analysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: sampleSource(),
      compilerOptions: {
        jsx: "react-jsx",
        target: "es2022",
        define: {
          __DEV__: true
        }
      },
      dependencyArtifacts: [
        {
          id: "react",
          path: "/repo/node_modules/react/index.js",
          hash: "react-source-hash",
          cacheKey: "react-cache-key"
        }
      ]
    });
    const changedOptionsAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: sampleSource(),
      compilerOptions: {
        jsx: "react-jsx",
        target: "es2022",
        define: {
          __DEV__: false
        }
      },
      dependencyArtifacts: [
        {
          id: "react",
          path: "/repo/node_modules/react/index.js",
          hash: "react-source-hash",
          cacheKey: "react-cache-key"
        }
      ]
    });
    const userCardId = analysis.manifest.slices.find((slice) => slice.name === "UserCard").id;
    const userCardAction = analysis.piecePackage.actions.find((action) => action.id === "//repo/src:DashboardPage.tsx__function_UserCard%feedback");

    expect(analysis.actionCache.compilerOptionsHash).toBeTruthy();
    expect(analysis.actionCache.dependencyArtifactsHash).toBeTruthy();
    expect(userCardAction.inputs).toContain(`compiler-options:${analysis.actionCache.compilerOptionsHash}`);
    expect(userCardAction.inputs).toContain(`dependency-artifacts:${analysis.actionCache.dependencyArtifactsHash}`);
    expect(analysis.snapshot.actionCache.compilerOptionsHash).toBe(analysis.actionCache.compilerOptionsHash);
    expect(analysis.snapshot.artifacts[userCardId].cacheKey).not.toBe(changedOptionsAnalysis.snapshot.artifacts[userCardId].cacheKey);
  });

  it("builds local compile action cache records and explains status without skipping execution", () => {
    const target = {
      id: "/repo/src/User.kt#type:User",
      label: "//repo/src:User.kt__type_User",
      name: "User",
      kind: "type",
      rule: "kotlin_piece_type",
      source: "//repo/src:User.kt",
      deps: [],
      runtimeDeps: [],
      typeDeps: [],
      externalDeps: [],
      actions: ["//repo/src:User.kt__type_User%compile"],
      artifacts: ["//repo/src:User.kt__type_User.compile.json"],
      visibility: ["//visibility:private"]
    };
    const action = {
      id: "//repo/src:User.kt__type_User%compile",
      target: target.label,
      kind: "compile",
      mnemonic: "PieceCompile",
      inputs: ["//repo/src:User.kt", "source-set:scope-hash", "project-model:scope-hash"],
      outputs: ["//repo/src:User.kt__type_User.compile.json"]
    };
    const artifact = {
      id: "//repo/src:User.kt__type_User.compile.json",
      target: target.label,
      kind: "piece-compile",
      path: "user.compile.json",
      cacheKey: "user-compile-cache-key"
    };
    const actionPackage = {
      version: 1,
      kind: "single-file-package",
      language: "kotlin",
      packageName: "repo/src",
      label: "//repo/src:User.kt",
      filePath: "/repo/src/User.kt",
      sourceFile: "//repo/src:User.kt",
      rules: [],
      targets: [target],
      actions: [action],
      artifacts: [artifact]
    };
    const analysis = {
      actionCache: {
        version: 1,
        compilerOptionsHash: "compiler-options-hash",
        dependencyArtifactsHash: "dependency-artifacts-hash",
        toolchainInputsHash: "toolchain-inputs-hash",
        dependencyArtifacts: [],
        toolchainInputs: ["kotlin-toolchain:hash"],
        inputs: ["compiler-options:compiler-options-hash", "dependency-artifacts:dependency-artifacts-hash", "kotlin-toolchain:hash"]
      },
      feedbackScope: {
        level: "source-set",
        fallbackRequired: false,
        reasons: [],
        hashes: {
          fallbackScopeHash: "feedback-scope-hash"
        }
      },
      manifest: {
        projectModel: {
          analysisScope: {
            hashes: {
              scopeHash: "source-set-scope-hash"
            }
          }
        }
      },
      snapshot: {
        sourceHash: "snapshot-source-hash",
        projectModelHash: "source-set-scope-hash",
        feedbackScope: {
          hashes: {
            fallbackScopeHash: "feedback-scope-hash"
          }
        }
      }
    };
    const record = createPieceActionCacheRecord({
      actionPackage,
      target,
      action,
      artifact,
      analysis,
      language: "kotlin",
      filePath: "/repo/src/User.kt",
      source: "data class User(val name: String)"
    });
    expect(record).toMatchObject({
      kind: "piece-action-cache-record",
      action: {
        targetLabel: target.label,
        actionId: action.id,
        kind: "compile"
      },
      artifact: {
        id: artifact.id,
        cacheKey: "user-compile-cache-key"
      },
      identity: {
        compilerOptionsHash: "compiler-options-hash",
        dependencyArtifactsHash: "dependency-artifacts-hash",
        toolchainInputsHash: "toolchain-inputs-hash",
        projectModelHash: "source-set-scope-hash",
        feedbackScopeHash: "feedback-scope-hash"
      }
    });

    expect(explainPieceActionCacheStatus({ record }).status).toBe("miss");
    const hit = explainPieceActionCacheStatus({ record, records: [record] });
    expect(hit).toMatchObject({
      status: "hit",
      matchedRecordKey: record.key,
      execution: {
        skipped: false,
        reason: "status-only"
      }
    });
    expect(explainPieceActionCacheStatus({ record, records: false }).status).toBe("bypass");
    expect(
      explainPieceActionCacheStatus({
        record,
        records: [record],
        analysis: {
          feedbackScope: {
            level: "file",
            fallbackRequired: true,
            reasons: [{ code: "unknown-edge-fallback" }]
          }
        }
      })
    ).toMatchObject({
      status: "unsafe",
      reasons: [expect.objectContaining({ code: "feedback-scope-fallback" })]
    });
    expect(
      explainPieceActionCacheStatus({
        record,
        records: [record],
        analysis: {
          manifest: {
            projectModel: {
              analysisScope: {
                status: "fallback",
                fallbackReason: "source set not found",
                sourceSet: "jvmMain"
              }
            }
          }
        }
      })
    ).toMatchObject({
      status: "unsafe",
      reasons: [expect.objectContaining({ code: "project-model-fallback" })]
    });
    expect(
      explainPieceActionCacheStatus({
        record,
        records: [record],
        analysis: {
          packageScope: {
            status: "candidate",
            promotion: {
              requested: "safe",
              appliedToPackageView: false,
              reason: "feedback fallback"
            }
          }
        }
      })
    ).toMatchObject({
      status: "unsafe",
      reasons: [expect.objectContaining({ code: "package-scope-not-selected" })]
    });
    const recordWithoutArtifactCacheKey = {
      ...record,
      artifact: {
        ...record.artifact,
        cacheKey: ""
      },
      identity: {
        ...record.identity,
        artifactCacheKey: ""
      }
    };
    const missingArtifactCacheKey = explainPieceActionCacheStatus({
      record: recordWithoutArtifactCacheKey,
      records: [recordWithoutArtifactCacheKey]
    });
    expect(missingArtifactCacheKey.status).toBe("miss");
    expect(missingArtifactCacheKey.reasons).toContainEqual(expect.objectContaining({ code: "artifact-cache-key-missing" }));
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
    expect(preview.closure.feedbackScope.level).toBe("piece");
  });

  it("explains unknown-edge fallback and carries it into closure scope", async () => {
    const source = `export function Broken() {
  return missingValue + 1;
}
`;
    const compiler = createPieceCompiler();
    const analysis = await compiler.analyzeFile({
      filePath: "/repo/src/Broken.ts",
      source
    });
    const preview = await compiler.buildPreview({
      analysis,
      target: "Broken"
    });

    expect(analysis.graph.diagnostics.map((diagnostic) => diagnostic.code)).toContain("unknown-reference");
    expect(analysis.feedbackScope.level).toBe("file");
    expect(analysis.feedbackScope.fallbackRequired).toBe(true);
    expect(analysis.feedbackScope.reasons.map((reason) => reason.code)).toContain("unknown-edge-fallback");
    const brokenAction = analysis.piecePackage.actions.find((action) => action.id === "//repo/src:Broken.ts__function_Broken%feedback");
    expect(brokenAction.inputs.some((input) => input.startsWith("fallback-reason:unknown-edge-fallback:"))).toBe(true);
    expect(preview.closure.fallbackMode).toBe("whole-file");
    expect(preview.closure.feedbackScope.level).toBe("file");
    expect(preview.closure.hashes.runtimeClosureHash).not.toBe(analysis.snapshot.declarations[analysis.previewTargets[0]].artifactCacheKey);
  });

  it("changes artifact cache keys when fallback scope metadata changes", async () => {
    const unsafeSource = `export function Broken() {
  return missingValue + 1;
}

export function Other() {
  return 1;
}
`;
    const safeSource = `const missingValue = 1;

export function Broken() {
  return missingValue + 1;
}

export function Other() {
  return 1;
}
`;
    const compiler = createPieceCompiler();
    const unsafeAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/Broken.ts",
      source: unsafeSource
    });
    const safeAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/Broken.ts",
      source: safeSource
    });
    const brokenId = unsafeAnalysis.manifest.slices.find((slice) => slice.name === "Broken").id;

    expect(unsafeAnalysis.feedbackScope.level).toBe("file");
    expect(safeAnalysis.feedbackScope.level).toBe("piece");
    expect(unsafeAnalysis.snapshot.feedbackScope.hashes.fallbackScopeHash).not.toBe(safeAnalysis.snapshot.feedbackScope.hashes.fallbackScopeHash);
    expect(unsafeAnalysis.snapshot.artifacts[brokenId].cacheKey).not.toBe(safeAnalysis.snapshot.artifacts[brokenId].cacheKey);
  });

  it("preserves artifact cache keys through package override merges and .pic output", () => {
    const targetLabel = "//repo/src:User.kt__type_User";
    const generatedPackage = {
      version: 1,
      kind: "single-file-package",
      language: "kotlin",
      packageName: "repo/src",
      label: "//repo/src:User.kt",
      filePath: "/repo/src/User.kt",
      sourceFile: "//repo/src:User.kt",
      rules: [],
      targets: [
        {
          id: "/repo/src/User.kt#type:User",
          label: targetLabel,
          name: "User",
          kind: "type",
          rule: "kotlin_piece_type",
          source: "//repo/src:User.kt",
          deps: [],
          runtimeDeps: [],
          typeDeps: [],
          externalDeps: [],
          actions: [`${targetLabel}%compile`],
          artifacts: [`${targetLabel}.compile.json`],
          visibility: ["//visibility:private"]
        }
      ],
      actions: [
        {
          id: `${targetLabel}%compile`,
          target: targetLabel,
          kind: "compile",
          mnemonic: "PieceCompile",
          inputs: ["//repo/src:User.kt", "source-set:source-set-scope-hash"],
          outputs: [`${targetLabel}.compile.json`]
        }
      ],
      artifacts: [
        {
          id: `${targetLabel}.compile.json`,
          target: targetLabel,
          kind: "piece-compile",
          path: "repo/src__User.kt__type_User.compile.json",
          cacheKey: "generated-cache-key"
        }
      ]
    };
    const overridePackage = {
      ...generatedPackage,
      targets: [
        {
          ...generatedPackage.targets[0],
          visibility: ["//visibility:public"]
        }
      ],
      actions: [
        {
          ...generatedPackage.actions[0],
          mnemonic: "UserFixture",
          inputs: ["//repo/src:User.kt", "fixtures/user.json"],
          outputs: [`${targetLabel}.compile.json`]
        }
      ],
      artifacts: [
        {
          ...generatedPackage.artifacts[0],
          path: "artifacts/user.fixture.json"
        }
      ]
    };

    const merged = mergePiecePackages(generatedPackage, overridePackage);
    const mergedArtifact = merged.piecePackage.artifacts.find((artifact) => artifact.id === `${targetLabel}.compile.json`);
    expect(mergedArtifact).toMatchObject({
      path: "artifacts/user.fixture.json",
      cacheKey: "generated-cache-key"
    });
    expect(piecePackageToPicDsl(merged.piecePackage)).toContain('cacheKey "generated-cache-key"');

    const mergedWithOverrideCacheKey = mergePiecePackages(generatedPackage, {
      ...overridePackage,
      artifacts: [
        {
          ...overridePackage.artifacts[0],
          cacheKey: "override-cache-key"
        }
      ]
    });
    expect(mergedWithOverrideCacheKey.piecePackage.artifacts.find((artifact) => artifact.id === `${targetLabel}.compile.json`)).toMatchObject({
      cacheKey: "override-cache-key"
    });
  });

  it("keeps selected Go package scope as a current-file fast path until package targets exist", () => {
    const targetPolicy = {
      version: 1,
      kind: "current-file-external-bindings",
      targetScope: "current-file",
      companionTargetMode: "external-binding",
      companionTargets: false,
      fastPath: true,
      companionFileCount: 1,
      reason: "Go companion declarations stay as package-local external bindings until Piece has a multi-file package target model."
    };
    const manifest = {
      version: 1,
      filePath: "/repo/src/Pricing.go",
      source: goSource(),
      parser: "go-ast-declaration-extractor",
      slices: [],
      headers: [],
      effects: [],
      importBindings: [],
      hasTopLevelEffect: false,
      toolchain: {
        version: 1,
        kind: "go-list",
        status: "success",
        hash: "go-list-hash",
        inputs: ["go-list:go-list-hash", "go-package-scope:package-scope-hash"],
        packageScope: {
          version: 1,
          status: "selected",
          files: [
            { filePath: "/repo/src/Pricing.go", hash: "pricing-hash" },
            { filePath: "/repo/src/Discount.go", hash: "discount-hash" }
          ],
          hash: "package-scope-hash",
          input: "go-package-scope:package-scope-hash",
          targetPolicy
        },
        goList: {
          version: 1,
          status: "success",
          packageHash: "go-list-hash",
          packages: []
        }
      },
      diagnostics: []
    };
    const graph = {
      version: 1,
      filePath: manifest.filePath,
      slices: [],
      edges: [],
      symbolTable: { local: {}, imports: {}, importsByLocal: {}, exports: {} },
      diagnostics: []
    };
    const scope = explainPieceFeedbackScope({ manifest, graph });
    const changedManifest = JSON.parse(JSON.stringify(manifest));
    changedManifest.toolchain.packageScope.hash = "package-scope-hash-2";
    changedManifest.toolchain.packageScope.input = "go-package-scope:package-scope-hash-2";
    changedManifest.toolchain.inputs = ["go-list:go-list-hash", "go-package-scope:package-scope-hash-2"];
    const changedScope = explainPieceFeedbackScope({ manifest: changedManifest, graph });

    expect(scope.level).toBe("piece");
    expect(scope.fallbackRequired).toBe(false);
    expect(scope.reasons).toContainEqual(
      expect.objectContaining({
        code: "go-package-scope-fast-path",
        packageScopeHash: "package-scope-hash",
        targetScope: "current-file",
        companionTargetMode: "external-binding",
        companionTargets: false,
        fastPath: true
      })
    );
    expect(scope.hashes.dependencyHash).not.toBe(changedScope.hashes.dependencyHash);
    expect(scope.hashes.fallbackScopeHash).not.toBe(changedScope.hashes.fallbackScopeHash);
  });

  it("models package-scope companion targets without applying them to the default package", () => {
    const manifest = {
      version: 1,
      filePath: "/repo/src/Pricing.go",
      source: goSource(),
      parser: "go-ast-declaration-extractor",
      slices: [],
      headers: [],
      effects: [],
      importBindings: [],
      hasTopLevelEffect: false,
      toolchain: {
        version: 1,
        kind: "go-list",
        status: "success",
        hash: "go-list-hash",
        inputs: ["go-list:go-list-hash", "go-package-scope:package-scope-hash"],
        packageScope: {
          version: 1,
          status: "selected",
          files: [
            { filePath: "/repo/src/Pricing.go", hash: "pricing-hash" },
            { filePath: "/repo/src/Discount.go", hash: "discount-hash" }
          ],
          declarations: [
            {
              id: "/repo/src/Discount.go#type:Discount",
              filePath: "/repo/src/Discount.go",
              name: "Discount",
              kind: "type",
              hash: "discount-body-hash"
            }
          ],
          hash: "package-scope-hash",
          input: "go-package-scope:package-scope-hash",
          targetPolicy: {
            version: 1,
            kind: "current-file-external-bindings",
            targetScope: "current-file",
            companionTargetMode: "external-binding",
            companionTargets: false,
            fastPath: true,
            companionFileCount: 1,
            reason: "Go companion declarations stay as package-local external bindings until Piece has a multi-file package target model."
          }
        },
        goList: {
          version: 1,
          status: "success",
          packageHash: "go-list-hash",
          packages: []
        }
      },
      diagnostics: []
    };
    const graph = {
      version: 1,
      filePath: manifest.filePath,
      slices: [],
      edges: [
        {
          from: "/repo/src/Pricing.go#type:Greeting",
          to: "/repo/src/Discount.go#Discount",
          kind: "external",
          symbols: ["Discount"],
          import: {
            local: "Discount",
            imported: "Discount",
            source: "/repo/src/Discount.go",
            kind: "named",
            isTypeOnly: true
          }
        }
      ],
      symbolTable: { local: {}, imports: {}, importsByLocal: {}, exports: {} },
      diagnostics: []
    };
    const piecePackage = {
      version: 1,
      kind: "single-file-package",
      language: "go",
      packageName: "repo/src",
      label: "//repo/src:Pricing.go",
      filePath: "/repo/src/Pricing.go",
      sourceFile: "//repo/src:Pricing.go",
      rules: [],
      targets: [
        {
          id: "/repo/src/Pricing.go#type:Greeting",
          label: "//repo/src:Pricing.go__type_Greeting",
          name: "Greeting",
          kind: "type",
          rule: "go_piece_type",
          source: "//repo/src:Pricing.go",
          deps: [],
          runtimeDeps: [],
          typeDeps: [],
          externalDeps: ["/repo/src/Discount.go#Discount"],
          actions: [],
          artifacts: [],
          visibility: ["//visibility:private"]
        }
      ],
      actions: [
        {
          id: "//repo/src:Pricing.go__type_Greeting%feedback",
          target: "//repo/src:Pricing.go__type_Greeting",
          kind: "feedback",
          mnemonic: "PieceFeedback",
          inputs: ["//repo/src:Pricing.go", "/repo/src/Discount.go#Discount"],
          outputs: ["//repo/src:Pricing.go__type_Greeting.piece.json"]
        }
      ],
      artifacts: []
    };
    const packageScope = createPackageScopeTargetModel({ filePath: manifest.filePath, manifest, graph, piecePackage });
    const selectedPackageScope = createPackageScopeTargetModel({
      filePath: manifest.filePath,
      manifest,
      graph,
      piecePackage,
      feedbackScope: { level: "piece", fallbackRequired: false },
      selection: "safe"
    });

    expect(packageScope).toMatchObject({
      kind: "package-scope-target-model",
      status: "candidate",
      promotion: {
        appliedToDefaultPackage: false
      }
    });
    expect(packageScope.promotedTargets).toContainEqual(
      expect.objectContaining({
        label: "//repo/src:Discount.go__type_Discount",
        kind: "type",
        sourceFile: "/repo/src/Discount.go",
        externalIdentity: "/repo/src/Discount.go#Discount"
      })
    );
    expect(packageScope.promotedEdges).toContainEqual(
      expect.objectContaining({
        from: "//repo/src:Pricing.go__type_Greeting",
        to: "//repo/src:Discount.go__type_Discount",
        symbols: ["Discount"]
      })
    );
    expect(selectedPackageScope).toMatchObject({
      status: "selected",
      promotion: {
        requested: "safe",
        appliedToDefaultPackage: false,
        appliedToPackageView: true
      }
    });
    expect(selectedPackageScope.packageView.targets).toContainEqual(
      expect.objectContaining({
        label: "//repo/src:Discount.go__type_Discount",
        source: "//repo/src:Discount.go"
      })
    );
    expect(selectedPackageScope.packageView.targets.find((target) => target.label === "//repo/src:Pricing.go__type_Greeting")).toMatchObject({
      deps: ["//repo/src:Discount.go__type_Discount"],
      externalDeps: []
    });
    expect(
      selectedPackageScope.packageView.actions.find((action) => action.id === "//repo/src:Pricing.go__type_Greeting%feedback")?.inputs
    ).toContain("//repo/src:Discount.go__type_Discount");
    expect(
      selectedPackageScope.packageView.actions.find((action) => action.id === "//repo/src:Discount.go__type_Discount%compile")?.inputs
    ).toContain("go-package-scope:package-scope-hash");
  });

  it("models source-set companion targets without promoting classpath deps", () => {
    const renderPath = "/repo/app/src/jvmMain/kotlin/demo/app/Render.kt";
    const userPath = "/repo/domain/src/commonMain/kotlin/demo/model/User.kt";
    const externalSource = "classpath:/repo/external-user.jar!demo/external";
    const manifest = {
      version: 1,
      filePath: renderPath,
      source: "package demo.app\nfun render(user: User, external: ExternalUser): String = user.name + external.name\n",
      parser: "kotlin-psi-declaration-extractor",
      slices: [],
      headers: [],
      effects: [],
      importBindings: [],
      hasTopLevelEffect: false,
      projectModel: {
        kind: "gradle-kmp",
        projectRoot: "/repo",
        status: "success",
        sourceRoots: ["/repo/app/src/jvmMain/kotlin", "/repo/domain/src/commonMain/kotlin"],
        classpath: ["/repo/external-user.jar"],
        sourceSets: [],
        classpaths: [],
        dependencies: [],
        projectDependencies: [],
        targetVariants: [],
        hashes: {
          sourceRootsHash: "roots-hash",
          classpathHash: "classpath-hash",
          modelHash: "model-hash"
        },
        analysisScope: {
          status: "selected",
          projectPath: ":app",
          projectPaths: [":app", ":domain"],
          sourceSet: "jvmMain",
          requiredSourceSets: ["commonMain", "jvmMain"],
          sourceRoots: ["/repo/app/src/jvmMain/kotlin", "/repo/domain/src/commonMain/kotlin"],
          classpath: ["/repo/external-user.jar"],
          classpathConfigurations: ["jvmCompileClasspath"],
          dependencyCoordinates: ["demo.external:external-user:1.0.0"],
          projectDependencies: [],
          targetVariants: [],
          diagnostics: [],
          hashes: {
            sourceRootsHash: "scope-roots-hash",
            classpathHash: "scope-classpath-hash",
            scopeHash: "source-set-scope-hash"
          }
        }
      },
      diagnostics: []
    };
    const graph = {
      version: 1,
      filePath: renderPath,
      slices: [],
      edges: [
        {
          from: `${renderPath}#function:render`,
          to: `${userPath}#User`,
          kind: "external",
          symbols: ["User"],
          import: {
            local: "User",
            imported: "User",
            source: userPath,
            kind: "named",
            isTypeOnly: true
          }
        },
        {
          from: `${renderPath}#function:render`,
          to: `${externalSource}#ExternalUser`,
          kind: "external",
          symbols: ["ExternalUser"],
          import: {
            local: "ExternalUser",
            imported: "ExternalUser",
            source: externalSource,
            kind: "named",
            isTypeOnly: true
          }
        }
      ],
      symbolTable: { local: {}, imports: {}, importsByLocal: {}, exports: {} },
      diagnostics: []
    };
    const piecePackage = {
      version: 1,
      kind: "single-file-package",
      language: "kotlin",
      packageName: "repo/app/src/jvmMain/kotlin/demo/app",
      label: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
      filePath: renderPath,
      sourceFile: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
      rules: [],
      targets: [
        {
          id: `${renderPath}#function:render`,
          label: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt__function_render",
          name: "render",
          kind: "function",
          rule: "kotlin_piece_function",
          source: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
          deps: [],
          runtimeDeps: [],
          typeDeps: [],
          externalDeps: [`${userPath}#User`, `${externalSource}#ExternalUser`],
          actions: ["//repo/app/src/jvmMain/kotlin/demo/app:Render.kt__function_render%feedback", "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt__function_render%compile"],
          artifacts: [],
          visibility: ["//visibility:private"]
        }
      ],
      actions: [
        {
          id: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt__function_render%compile",
          target: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt__function_render",
          kind: "compile",
          mnemonic: "PieceCompile",
          inputs: ["//repo/app/src/jvmMain/kotlin/demo/app:Render.kt", `${userPath}#User`, `${externalSource}#ExternalUser`],
          outputs: ["//repo/app/src/jvmMain/kotlin/demo/app:Render.kt__function_render.compile.json"]
        }
      ],
      artifacts: []
    };
    const sourceSetScope = createSourceSetScopeTargetModel({
      filePath: renderPath,
      manifest,
      graph,
      piecePackage,
      feedbackScope: { level: "source-set", fallbackRequired: false },
      selection: "safe"
    });

    expect(sourceSetScope).toMatchObject({
      kind: "source-set-scope-target-model",
      status: "selected",
      sourceSetScopeHash: "source-set-scope-hash",
      promotion: {
        requested: "safe",
        appliedToDefaultPackage: false,
        appliedToPackageView: true
      }
    });
    const promotedUser = sourceSetScope.promotedTargets.find((target) => target.name === "User");
    expect(promotedUser).toMatchObject({
      sourceFile: userPath,
      externalIdentity: `${userPath}#User`
    });
    expect(sourceSetScope.promotedTargets.some((target) => target.name === "ExternalUser")).toBe(false);
    const packageViewRenderTarget = sourceSetScope.packageView.targets.find((target) => target.name === "render");
    expect(packageViewRenderTarget.deps).toContain(promotedUser.label);
    expect(packageViewRenderTarget.externalDeps).toContain(`${externalSource}#ExternalUser`);
    expect(packageViewRenderTarget.externalDeps).not.toContain(`${userPath}#User`);
    expect(
      sourceSetScope.packageView.actions.find((action) => action.id === `${promotedUser.label}%compile`)?.inputs
    ).toContain("source-set:source-set-scope-hash");
    const promotedCompileArtifact = sourceSetScope.packageView.artifacts.find(
      (artifact) => artifact.id === `${promotedUser.label}.compile.json`
    );
    const promotedFeedbackArtifact = sourceSetScope.packageView.artifacts.find(
      (artifact) => artifact.id === `${promotedUser.label}.piece.json`
    );
    expect(promotedCompileArtifact).toMatchObject({
      target: promotedUser.label,
      kind: "piece-compile",
      cacheKey: expect.any(String)
    });
    expect(promotedFeedbackArtifact).toMatchObject({
      target: promotedUser.label,
      kind: "piece-feedback",
      cacheKey: expect.any(String)
    });
    expect(promotedCompileArtifact.cacheKey).not.toBe(promotedFeedbackArtifact.cacheKey);

    const changedScopeManifest = {
      ...manifest,
      projectModel: {
        ...manifest.projectModel,
        analysisScope: {
          ...manifest.projectModel.analysisScope,
          hashes: {
            ...manifest.projectModel.analysisScope.hashes,
            scopeHash: "source-set-scope-hash-next"
          }
        }
      }
    };
    const changedSourceSetScope = createSourceSetScopeTargetModel({
      filePath: renderPath,
      manifest: changedScopeManifest,
      graph,
      piecePackage,
      feedbackScope: { level: "source-set", fallbackRequired: false },
      selection: "safe"
    });
    const changedPromotedUser = changedSourceSetScope.promotedTargets.find((target) => target.name === "User");
    const changedPromotedCompileArtifact = changedSourceSetScope.packageView.artifacts.find(
      (artifact) => artifact.id === `${changedPromotedUser.label}.compile.json`
    );
    expect(changedPromotedCompileArtifact.cacheKey).not.toBe(promotedCompileArtifact.cacheKey);
  });

  it("keeps source-set package views behind fallback gates", () => {
    const renderPath = "/repo/app/src/jvmMain/kotlin/demo/app/Render.kt";
    const userPath = "/repo/domain/src/commonMain/kotlin/demo/model/User.kt";
    const selectedAnalysisScope = {
      status: "selected",
      projectPath: ":app",
      projectPaths: [":app", ":domain"],
      sourceSet: "jvmMain",
      requiredSourceSets: ["commonMain", "jvmMain"],
      sourceRoots: ["/repo/app/src/jvmMain/kotlin", "/repo/domain/src/commonMain/kotlin"],
      classpath: [],
      classpathConfigurations: [],
      dependencyCoordinates: [],
      projectDependencies: [],
      targetVariants: [],
      diagnostics: [],
      hashes: {
        sourceRootsHash: "scope-roots-hash",
        classpathHash: "scope-classpath-hash",
        scopeHash: "source-set-scope-hash"
      }
    };
    const manifest = {
      version: 1,
      filePath: renderPath,
      source: "package demo.app\nfun render(user: User): String = user.name\n",
      parser: "kotlin-psi-declaration-extractor",
      slices: [],
      headers: [],
      effects: [],
      importBindings: [],
      hasTopLevelEffect: false,
      projectModel: {
        kind: "gradle-kmp",
        projectRoot: "/repo",
        status: "success",
        sourceRoots: selectedAnalysisScope.sourceRoots,
        classpath: [],
        sourceSets: [],
        classpaths: [],
        dependencies: [],
        projectDependencies: [],
        targetVariants: [],
        hashes: {
          sourceRootsHash: "roots-hash",
          classpathHash: "classpath-hash",
          modelHash: "model-hash"
        },
        analysisScope: selectedAnalysisScope
      },
      diagnostics: []
    };
    const graph = {
      version: 1,
      filePath: renderPath,
      slices: [],
      edges: [
        {
          from: `${renderPath}#function:render`,
          to: `${userPath}#User`,
          kind: "external",
          symbols: ["User"],
          import: {
            local: "User",
            imported: "User",
            source: userPath,
            kind: "named",
            isTypeOnly: true
          }
        }
      ],
      symbolTable: { local: {}, imports: {}, importsByLocal: {}, exports: {} },
      diagnostics: []
    };
    const piecePackage = {
      version: 1,
      kind: "single-file-package",
      language: "kotlin",
      packageName: "repo/app/src/jvmMain/kotlin/demo/app",
      label: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
      filePath: renderPath,
      sourceFile: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
      rules: [],
      targets: [
        {
          id: `${renderPath}#function:render`,
          label: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt__function_render",
          name: "render",
          kind: "function",
          rule: "kotlin_piece_function",
          source: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
          deps: [],
          runtimeDeps: [],
          typeDeps: [],
          externalDeps: [`${userPath}#User`],
          actions: [],
          artifacts: [],
          visibility: ["//visibility:private"]
        }
      ],
      actions: [],
      artifacts: []
    };

    const fallbackScope = createSourceSetScopeTargetModel({
      filePath: renderPath,
      manifest,
      graph,
      piecePackage,
      feedbackScope: {
        level: "file",
        fallbackRequired: true,
        reasons: [
          {
            code: "unknown-edge-fallback",
            severity: "warning",
            message: "Unresolved reference keeps feedback at the file boundary."
          }
        ]
      },
      selection: "safe"
    });
    expect(fallbackScope).toMatchObject({
      status: "candidate",
      promotion: {
        appliedToPackageView: false
      }
    });
    expect(fallbackScope.packageView).toBeUndefined();
    expect(fallbackScope.promotion.blockedReasons).toContainEqual(
      expect.objectContaining({
        code: "source-set-scope-feedback-fallback",
        fallbackLevel: "file",
        fallbackReasonCodes: ["unknown-edge-fallback"]
      })
    );

    const projectModelFallback = createSourceSetScopeTargetModel({
      filePath: renderPath,
      manifest: {
        ...manifest,
        projectModel: {
          ...manifest.projectModel,
          analysisScope: {
            ...selectedAnalysisScope,
            status: "fallback",
            fallbackReason: "No matching source set."
          }
        }
      },
      graph,
      piecePackage,
      feedbackScope: { level: "project", fallbackRequired: true },
      selection: "safe"
    });
    expect(projectModelFallback).toBeUndefined();
  });

  it("exposes source-set scope blockers on node app compile action selection", async () => {
    const filePath = "/repo/app/src/jvmMain/kotlin/demo/app/Render.kt";
    const source = "package demo.app\nfun render(): String = missing()\n";
    const renderTargetLabel = "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt__function_render";
    const analysis = {
      version: 1,
      filePath,
      manifest: {
        version: 1,
        filePath,
        source,
        parser: "kotlin-psi-declaration-extractor",
        slices: [],
        headers: [],
        effects: [],
        importBindings: [],
        hasTopLevelEffect: false,
        diagnostics: []
      },
      graph: {
        version: 1,
        filePath,
        slices: [],
        edges: [],
        symbolTable: { local: {}, imports: {}, importsByLocal: {}, exports: {} },
        diagnostics: []
      },
      feedbackScope: {
        version: 1,
        level: "file",
        fallbackRequired: true,
        reasons: [
          {
            code: "unknown-edge-fallback",
            severity: "warning",
            message: "Unresolved reference keeps feedback at the file boundary."
          }
        ],
        hashes: {
          sourceHash: "source-hash",
          dependencyHash: "dependency-hash",
          projectModelHash: "project-model-hash",
          fallbackScopeHash: "fallback-scope-hash"
        }
      },
      piecePackage: {
        version: 1,
        kind: "single-file-package",
        language: "kotlin",
        packageName: "repo/app/src/jvmMain/kotlin/demo/app",
        label: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
        filePath,
        sourceFile: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
        rules: [],
        targets: [
          {
            id: `${filePath}#function:render`,
            label: renderTargetLabel,
            name: "render",
            kind: "function",
            rule: "kotlin_piece_function",
            source: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
            deps: [],
            runtimeDeps: [],
            typeDeps: [],
            externalDeps: [],
            actions: [`${renderTargetLabel}%compile`],
            artifacts: [],
            visibility: ["//visibility:private"]
          }
        ],
        actions: [
          {
            id: `${renderTargetLabel}%compile`,
            target: renderTargetLabel,
            kind: "compile",
            mnemonic: "PieceCompile",
            inputs: ["//repo/app/src/jvmMain/kotlin/demo/app:Render.kt"],
            outputs: [`${renderTargetLabel}.compile.json`]
          }
        ],
        artifacts: []
      },
      sourceSetScope: {
        version: 1,
        kind: "source-set-scope-target-model",
        status: "candidate",
        language: "kotlin",
        packageName: "repo/app/src/jvmMain/kotlin/demo/app",
        label: "//repo/app/src/jvmMain/kotlin/demo/app:__source_set_scope",
        filePath,
        sourceFile: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
        sourceSetScopeHash: "source-set-scope-hash",
        sourceSetScopeInput: "source-set:source-set-scope-hash",
        projectModelInput: "project-model:source-set-scope-hash",
        projectPath: ":app",
        projectPaths: [":app", ":domain"],
        sourceSet: "jvmMain",
        requiredSourceSets: ["commonMain", "jvmMain"],
        promotion: {
          status: "candidate",
          requested: "safe",
          appliedToDefaultPackage: false,
          appliedToPackageView: false,
          reason: "Source-set companion targets are available as a candidate model while the default feedback package keeps the current-file fast path.",
          blockedReasons: [
            {
              code: "source-set-scope-feedback-fallback",
              severity: "warning",
              message: "Source-set package view selection is disabled while feedback scope already requires file or project fallback.",
              fallbackLevel: "file",
              fallbackReasonCodes: ["unknown-edge-fallback"]
            }
          ]
        },
        sourceFiles: [],
        currentTargets: [],
        promotedTargets: [],
        promotedEdges: [],
        scopeInputs: ["project-model:source-set-scope-hash", "source-set:source-set-scope-hash"]
      },
      pieceDsl: "",
      pieceDslSource: "current-file",
      previewTargets: [],
      metrics: {
        totalMs: 0,
        phases: { extractMs: 0, graphMs: 0 },
        sourceBytes: source.length,
        sliceCount: 0,
        edgeCount: 0,
        previewTargetCount: 0
      }
    };

    const status = await compileNodePieceApp({
      filePath,
      source,
      analysis,
      target: "__no_preview__",
      compileAction: true,
      pieceTarget: "__missing_piece_target__"
    });

    expect(status.compileActionDiagnostics?.[0]?.code).toBe("piece-compile-action-dispatch-failed");
    expect(status.compileActionSelection?.sourceSetScope).toMatchObject({
      status: "candidate",
      requested: "safe",
      appliedToPackageView: false,
      blockers: [
        expect.objectContaining({
          code: "source-set-scope-feedback-fallback",
          fallbackLevel: "file",
          fallbackReasonCodes: ["unknown-edge-fallback"]
        })
      ]
    });
  });

  it("exposes source-set package view artifact cache metadata on node app compile action selection", async () => {
    const filePath = "/repo/app/src/jvmMain/kotlin/demo/app/Render.kt";
    const source = "package demo.app\nfun render(user: User): String = user.name\n";
    const renderTargetLabel = "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt__function_render";
    const promotedUserLabel = "//repo/domain/src/commonMain/kotlin/demo/model:User.kt__type_User";
    const packageView = {
      version: 1,
      kind: "single-file-package",
      language: "kotlin",
      packageName: "repo/app/src/jvmMain/kotlin/demo/app",
      label: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
      filePath,
      sourceFile: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
      rules: [],
      targets: [
        {
          id: `${filePath}#function:render`,
          label: renderTargetLabel,
          name: "render",
          kind: "function",
          rule: "kotlin_piece_function",
          source: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
          deps: [promotedUserLabel],
          runtimeDeps: [],
          typeDeps: [promotedUserLabel],
          externalDeps: [],
          actions: [`${renderTargetLabel}%compile`],
          artifacts: [],
          visibility: ["//visibility:private"]
        },
        {
          id: "/repo/domain/src/commonMain/kotlin/demo/model/User.kt#type:User",
          label: promotedUserLabel,
          name: "User",
          kind: "type",
          rule: "kotlin_piece_type",
          sourceFile: "/repo/domain/src/commonMain/kotlin/demo/model/User.kt",
          source: "//repo/domain/src/commonMain/kotlin/demo/model:User.kt",
          externalIdentity: "/repo/domain/src/commonMain/kotlin/demo/model/User.kt#User",
          deps: [],
          runtimeDeps: [],
          typeDeps: [],
          externalDeps: [],
          actions: [`${promotedUserLabel}%feedback`, `${promotedUserLabel}%compile`],
          artifacts: [`${promotedUserLabel}.piece.json`, `${promotedUserLabel}.compile.json`],
          visibility: ["//visibility:private"]
        }
      ],
      actions: [
        {
          id: `${promotedUserLabel}%compile`,
          target: promotedUserLabel,
          kind: "compile",
          mnemonic: "PieceCompile",
          inputs: ["//repo/domain/src/commonMain/kotlin/demo/model:User.kt", "source-set:source-set-scope-hash"],
          outputs: [`${promotedUserLabel}.compile.json`]
        }
      ],
      artifacts: [
        {
          id: `${promotedUserLabel}.piece.json`,
          target: promotedUserLabel,
          kind: "piece-feedback",
          path: "user.piece.json",
          cacheKey: "user-feedback-cache-key"
        },
        {
          id: `${promotedUserLabel}.compile.json`,
          target: promotedUserLabel,
          kind: "piece-compile",
          path: "user.compile.json",
          cacheKey: "user-compile-cache-key"
        }
      ]
    };
    const analysis = {
      version: 1,
      filePath,
      manifest: {
        version: 1,
        filePath,
        source,
        parser: "kotlin-psi-declaration-extractor",
        slices: [],
        headers: [],
        effects: [],
        importBindings: [],
        hasTopLevelEffect: false,
        diagnostics: []
      },
      graph: {
        version: 1,
        filePath,
        slices: [],
        edges: [],
        symbolTable: { local: {}, imports: {}, importsByLocal: {}, exports: {} },
        diagnostics: []
      },
      feedbackScope: {
        version: 1,
        level: "source-set",
        fallbackRequired: false,
        reasons: [],
        hashes: {
          sourceHash: "source-hash",
          dependencyHash: "dependency-hash",
          projectModelHash: "project-model-hash",
          fallbackScopeHash: "fallback-scope-hash"
        }
      },
      piecePackage: {
        ...packageView,
        targets: [packageView.targets[0]],
        actions: [],
        artifacts: []
      },
      sourceSetScope: {
        version: 1,
        kind: "source-set-scope-target-model",
        status: "selected",
        language: "kotlin",
        packageName: "repo/app/src/jvmMain/kotlin/demo/app",
        label: "//repo/app/src/jvmMain/kotlin/demo/app:__source_set_scope",
        filePath,
        sourceFile: "//repo/app/src/jvmMain/kotlin/demo/app:Render.kt",
        sourceSetScopeHash: "source-set-scope-hash",
        sourceSetScopeInput: "source-set:source-set-scope-hash",
        projectModelInput: "project-model:source-set-scope-hash",
        projectPath: ":app",
        projectPaths: [":app", ":domain"],
        sourceSet: "jvmMain",
        requiredSourceSets: ["commonMain", "jvmMain"],
        promotion: {
          status: "selected",
          requested: "safe",
          appliedToDefaultPackage: false,
          appliedToPackageView: true,
          reason: "Source-set companion targets passed the safe selection gate and are available in packageView.",
          blockedReasons: []
        },
        sourceFiles: [],
        currentTargets: [],
        promotedTargets: [packageView.targets[1]],
        promotedEdges: [],
        scopeInputs: ["project-model:source-set-scope-hash", "source-set:source-set-scope-hash"],
        packageView
      },
      pieceDsl: "",
      pieceDslSource: "current-file",
      previewTargets: [],
      metrics: {
        totalMs: 0,
        phases: { extractMs: 0, graphMs: 0 },
        sourceBytes: source.length,
        sliceCount: 0,
        edgeCount: 0,
        previewTargetCount: 0
      }
    };

    const status = await compileNodePieceApp({
      filePath,
      source,
      analysis,
      target: "__no_preview__",
      compileAction: true,
      pieceTarget: "__missing_piece_target__"
    });

    expect(status.compileActionSelection?.actionPackageSource).toBe("selected-source-set-view");
    expect(status.compileActionSelection?.sourceSetScope?.packageViewArtifactCache).toMatchObject({
      artifactCount: 2,
      cachedArtifactCount: 2,
      artifacts: [
        expect.objectContaining({
          id: `${promotedUserLabel}.piece.json`,
          target: promotedUserLabel,
          kind: "piece-feedback",
          cacheKey: "user-feedback-cache-key"
        }),
        expect.objectContaining({
          id: `${promotedUserLabel}.compile.json`,
          target: promotedUserLabel,
          kind: "piece-compile",
          cacheKey: "user-compile-cache-key"
        })
      ]
    });
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

  it("rebuilds a cached preview when its virtual fixture props change", async () => {
    const source = `import * as React from "react";

interface UserCardProps {
  name: string;
}

export function UserCard(props: UserCardProps) {
  return <section>{props.name}</section>;
}
`;
    const fixturePath = "/@fixture/UserCard.props.ts";
    let transformCalls = 0;
    const buildEngine = {
      name: "virtual-fixture-test-engine",
      async build() {
        throw new Error("build should not be called");
      },
      async transform(input) {
        transformCalls += 1;
        return { code: input };
      }
    };
    const compiler = createPieceCompiler();
    const analysis = await compiler.analyzeFile({ filePath: "/repo/src/UserCard.tsx", source });
    const buildPreview = (name, previousPreview) =>
      compiler.buildPreview({
        analysis,
        target: "UserCard",
        previousPreview,
        compileStrategy: "transform",
        buildEngine,
        preview: {
          propsModulePath: fixturePath,
          virtualFiles: {
            [fixturePath]: `export const previewProps = { name: ${JSON.stringify(name)} };`
          }
        }
      });

    const first = await buildPreview("Ada Lovelace");
    const changedFixture = await buildPreview("Grace Hopper", first);
    const unchangedFixture = await buildPreview("Grace Hopper", changedFixture);

    expect(first.metrics.cache.status).toBe("miss");
    expect(changedFixture.metrics.cache.status).toBe("miss");
    expect(changedFixture.bundle?.code).toContain("Grace Hopper");
    expect(unchangedFixture.metrics.cache.status).toBe("hit");
    expect(transformCalls).toBe(2);
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
    expect(fileSystem.toAbsolutePath("src/index.js")).toBe(resolve(process.cwd(), "src", "index.js"));
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
    expect(editResult.analysis.snapshot).toBe(editResult.reconciliation.snapshot);
    expect(editResult.analysis.snapshot.revision).toBe(previousAnalysis.snapshot.revision + 1);
  });

  it("uses incremental analysis with the browser-safe fallback extractor", async () => {
    const compiler = createPieceCompiler();
    const declarationExtractor = createFallbackDeclarationExtractor();
    const previousSource = sampleSource();
    const previousAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: previousSource,
      declarationExtractor
    });
    const nextSource = previousSource.replace("props.user.id", "props.user.ID");
    const editResult = await compiler.applyEdit({
      filePath: "/repo/src/DashboardPage.tsx",
      source: nextSource,
      previousAnalysis,
      declarationExtractor,
      changedRanges: [changedRange(previousSource, nextSource)]
    });

    expect(editResult.analysis.metrics.incremental).toBe(true);
    expect(editResult.edit.changedSlices.map((id) => id.split("#")[1])).toEqual(["function:UserCard"]);
  });

  it("reuses unchanged declaration records when an equal-length incremental edit keeps their ranges stable", async () => {
    const compiler = createPieceCompiler();
    const previousSource = sampleSource();
    const previousAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: previousSource
    });
    const nextSource = previousSource.replace("props.user.id", "props.user.ID");
    const editResult = await compiler.applyEdit({
      filePath: "/repo/src/DashboardPage.tsx",
      source: nextSource,
      previousAnalysis,
      changedRanges: [changedRange(previousSource, nextSource)]
    });

    const previousDeclarations = previousAnalysis.snapshot.declarations;
    const nextDeclarations = editResult.analysis.snapshot.declarations;
    expect(nextDeclarations["/repo/src/DashboardPage.tsx#function:UserCard"]).not.toBe(previousDeclarations["/repo/src/DashboardPage.tsx#function:UserCard"]);
    expect(nextDeclarations["/repo/src/DashboardPage.tsx#function:OtherCard"]).toBe(previousDeclarations["/repo/src/DashboardPage.tsx#function:OtherCard"]);
    expect(nextDeclarations["/repo/src/DashboardPage.tsx#value:statusColorMap"]).toBe(previousDeclarations["/repo/src/DashboardPage.tsx#value:statusColorMap"]);
    expect(editResult.analysis.snapshot.artifacts["/repo/src/DashboardPage.tsx#function:OtherCard"]).toBe(
      previousAnalysis.snapshot.artifacts["/repo/src/DashboardPage.tsx#function:OtherCard"]
    );
  });

  it("reuses unchanged declaration and artifact maps without rematerializing their records", async () => {
    const compiler = createPieceCompiler();
    const analysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: sampleSource()
    });
    const previousSnapshot = createPieceSnapshot({ analysis });

    const reconciliation = reconcilePieceSnapshot({ previousSnapshot, analysis });

    expect(reconciliation.changedPieces).toEqual([]);
    expect(reconciliation.snapshot.declarations).toBe(previousSnapshot.declarations);
    expect(reconciliation.snapshot.artifacts).toBe(previousSnapshot.artifacts);
    expect(reconciliation.snapshot.artifacts["/repo/src/DashboardPage.tsx#function:UserCard"]).toBe(
      previousSnapshot.artifacts["/repo/src/DashboardPage.tsx#function:UserCard"]
    );
  });

  it("backfills rename metadata on an older v2 snapshot without invalidating artifacts", async () => {
    const compiler = createPieceCompiler();
    const analysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: sampleSource()
    });
    const snapshot = {
      ...analysis.snapshot,
      declarations: Object.fromEntries(
        Object.entries(analysis.snapshot.declarations).map(([id, declaration]) => {
          const { renameFingerprint, renamePublicShapeHash, ...withoutRenameMetadata } = declaration;
          return [id, withoutRenameMetadata];
        })
      )
    };

    const reconciliation = reconcilePieceSnapshot({ previousSnapshot: snapshot, analysis });

    expect(reconciliation.changedPieces).toEqual([]);
    expect(reconciliation.snapshot.artifacts).toBe(snapshot.artifacts);
    expect(reconciliation.reusedArtifactIds).toEqual(Object.keys(snapshot.artifacts).sort());
  });

  it("pairs an unambiguous internal rename without marking downstream pieces public-shape dirty", async () => {
    const compiler = createPieceCompiler();
    const previousSource = `function helper() {
  return "ready";
}

function render() {
  return helper();
}

export function Preview() {
  return <div>{render()}</div>;
}
`;
    const nextSource = previousSource.replaceAll("helper", "compute");
    const previousAnalysis = await compiler.analyzeFile({ filePath: "/repo/src/Rename.tsx", source: previousSource });
    const nextAnalysis = await compiler.analyzeFile({ filePath: "/repo/src/Rename.tsx", source: nextSource });

    const reconciliation = reconcilePieceSnapshot({
      previousSnapshot: previousAnalysis.snapshot,
      analysis: nextAnalysis,
      changedRanges: [changedRange(previousSource, nextSource)]
    });

    expect(reconciliation.renamedPieces).toEqual([
      {
        from: "/repo/src/Rename.tsx#function:helper",
        to: "/repo/src/Rename.tsx#function:compute",
        reason: "structural-fingerprint"
      }
    ]);
    expect(reconciliation.changedPieces.map((id) => id.split("#")[1])).toEqual(["function:compute", "function:render"]);
    expect(reconciliation.publicShapeChangedPieces).toEqual([]);
    expect(reconciliation.dirtyPieces.map((id) => id.split("#")[1])).toEqual(["function:compute", "function:render"]);
  });

  it("does not pair ambiguous structural rename candidates", async () => {
    const compiler = createPieceCompiler();
    const previousSource = `function first() { return 1; }
function second() { return 1; }
`;
    const nextSource = `function third() { return 1; }
function fourth() { return 1; }
`;
    const duplicateStructuralSource = "function __piece_duplicate__() { return 1; }";
    const withAmbiguousStructuralFingerprint = (analysis) => ({
      ...analysis,
      manifest: {
        ...analysis.manifest,
        // Simulate two extractor results whose structure fingerprint is equal.
        // Reconciliation must decline to guess a pairing in that situation.
        slices: analysis.manifest.slices.map((slice) => ({ ...slice, source: duplicateStructuralSource }))
      }
    });
    const previousAnalysis = withAmbiguousStructuralFingerprint(
      await compiler.analyzeFile({ filePath: "/repo/src/Ambiguous.ts", source: previousSource })
    );
    const nextAnalysis = withAmbiguousStructuralFingerprint(
      await compiler.analyzeFile({ filePath: "/repo/src/Ambiguous.ts", source: nextSource })
    );

    const reconciliation = reconcilePieceSnapshot({ previousSnapshot: createPieceSnapshot({ analysis: previousAnalysis }), analysis: nextAnalysis });

    expect(reconciliation.renamedPieces).toEqual([]);
    expect(reconciliation.changedPieces.map((id) => id.split("#")[1])).toEqual(
      expect.arrayContaining(["function:first", "function:second", "function:third", "function:fourth"])
    );
  });

  it("uses an explicit stable ID when a rename also changes the implementation", async () => {
    const compiler = createPieceCompiler();
    const previousSource = `function helper() {
  return 1;
}
`;
    const nextSource = `function compute() {
  return 2;
}
`;
    const withStableId = (analysis) => ({
      ...analysis,
      manifest: {
        ...analysis.manifest,
        slices: analysis.manifest.slices.map((slice) => ({ ...slice, stableId: "stable-helper" }))
      }
    });
    const previousAnalysis = withStableId(await compiler.analyzeFile({ filePath: "/repo/src/StableRename.ts", source: previousSource }));
    const nextAnalysis = withStableId(await compiler.analyzeFile({ filePath: "/repo/src/StableRename.ts", source: nextSource }));

    const reconciliation = reconcilePieceSnapshot({ previousSnapshot: createPieceSnapshot({ analysis: previousAnalysis }), analysis: nextAnalysis });

    expect(reconciliation.renamedPieces).toEqual([
      {
        from: "/repo/src/StableRename.ts#function:helper",
        to: "/repo/src/StableRename.ts#function:compute",
        reason: "stable-id"
      }
    ]);
    expect(reconciliation.publicShapeChangedPieces).toEqual([]);
  });

  it("keeps public-shape invalidation when a rename changes preview eligibility", async () => {
    const compiler = createPieceCompiler();
    const previousSource = `function helper() {
  return "ready";
}

function render() {
  return helper();
}
`;
    const nextSource = previousSource.replaceAll("helper", "Helper");
    const previousAnalysis = await compiler.analyzeFile({ filePath: "/repo/src/PreviewRename.ts", source: previousSource });
    const nextAnalysis = await compiler.analyzeFile({ filePath: "/repo/src/PreviewRename.ts", source: nextSource });

    const reconciliation = reconcilePieceSnapshot({ previousSnapshot: previousAnalysis.snapshot, analysis: nextAnalysis });

    expect(reconciliation.renamedPieces).toEqual([
      {
        from: "/repo/src/PreviewRename.ts#function:helper",
        to: "/repo/src/PreviewRename.ts#function:Helper",
        reason: "structural-fingerprint"
      }
    ]);
    expect(reconciliation.publicShapeChangedPieces).toEqual(["/repo/src/PreviewRename.ts#function:Helper"]);
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

  it("invalidates a legacy snapshot instead of reusing pre-v2 fingerprints", async () => {
    const compiler = createPieceCompiler();
    const analysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: sampleSource()
    });
    const legacySnapshot = { ...analysis.snapshot, fingerprintVersion: 1 };
    const reconciliation = reconcilePieceSnapshot({ previousSnapshot: legacySnapshot, analysis });

    expect(reconciliation.changedPieces).toEqual(Object.keys(analysis.snapshot.declarations).sort());
    expect(reconciliation.reusedArtifactIds).toEqual([]);
    expect(reconciliation.invalidatedArtifactIds).toEqual(Object.keys(analysis.snapshot.artifacts).sort());
    expect(reconciliation.changedHeaders).toBe(true);
  });

  it("keeps touched pieces from both declaration coordinate spaces across insertions and deletions", async () => {
    const compiler = createPieceCompiler();
    const previousSource = sampleSource();
    const previousAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: previousSource
    });
    const previousSnapshot = createPieceSnapshot({ analysis: previousAnalysis });

    const insertedSource = previousSource.replace("\nexport function UserCard", '\nconst addedLabel = "Added";\n\nexport function UserCard');
    const insertedAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: insertedSource
    });
    const insertion = reconcilePieceSnapshot({
      previousSnapshot,
      analysis: insertedAnalysis,
      changedRanges: [changedRange(previousSource, insertedSource)]
    });

    expect(insertion.touchedPieces.map((id) => id.split("#")[1])).toContain("value:addedLabel");

    const deletedSource = previousSource.replace('const statusColorMap = {\n  active: "green",\n  disabled: "gray"\n};\n\n', "");
    const deletedAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/DashboardPage.tsx",
      source: deletedSource
    });
    const deletion = reconcilePieceSnapshot({
      previousSnapshot,
      analysis: deletedAnalysis,
      changedRanges: [changedRange(previousSource, deletedSource)]
    });

    expect(deletion.touchedPieces.map((id) => id.split("#")[1])).toContain("value:statusColorMap");
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
    expect(analysis.piecePackage.rules.find((rule) => rule.name === "kotlin_piece_function")).toMatchObject({
      actionKind: "compile",
      implementation: "kotlin.function.compile"
    });
    expect(analysis.piecePackage.targets.map((target) => [target.rule, target.label])).toContainEqual([
      "kotlin_piece_function",
      "//repo/src:Pricing.kt__function_renderGreeting"
    ]);
    expect(analysis.piecePackage.actions.map((action) => [action.id, action.kind, action.mnemonic])).toContainEqual([
      "//repo/src:Pricing.kt__function_renderGreeting%compile",
      "compile",
      "PieceCompile"
    ]);
  });

  it("updates Kotlin function edits incrementally and preserves dependent targets", async () => {
    const compiler = createPieceCompiler();
    const previousSource = kotlinSource();
    const previousAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/Pricing.kt",
      source: previousSource
    });
    const nextSource = previousSource.replace("user.name)", "user.name.trim())");
    const editResult = await compiler.applyEdit({
      filePath: "/repo/src/Pricing.kt",
      source: nextSource,
      previousAnalysis,
      changedRanges: [changedRange(previousSource, nextSource)]
    });

    expect(editResult.analysis.metrics.incremental).toBe(true);
    expect(editResult.edit.changedSlices.map((id) => id.split("#")[1])).toEqual(["function:renderGreeting"]);
    expect(editResult.affectedTargets.map((id) => id.split("#")[1])).toEqual(["class:Greeter", "function:renderGreeting"]);
  });

  it("updates Kotlin value edits incrementally and preserves dependent targets", async () => {
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

    expect(editResult.analysis.metrics.incremental).toBe(true);
    expect(editResult.edit.changedSlices.map((id) => id.split("#")[1])).toEqual(["value:prefix"]);
    expect(editResult.affectedTargets.map((id) => id.split("#")[1])).toEqual(["class:Greeter", "function:renderGreeting"]);
  });

  it("falls back to full Kotlin reanalysis for header edits", async () => {
    const compiler = createPieceCompiler();
    const previousSource = kotlinSource();
    const previousAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/Pricing.kt",
      source: previousSource
    });
    const nextSource = previousSource.replace("import demo.flags.FeatureFlag", "import demo.flags.OtherFlag");
    const editResult = await compiler.applyEdit({
      filePath: "/repo/src/Pricing.kt",
      source: nextSource,
      previousAnalysis,
      changedRanges: [changedRange(previousSource, nextSource)]
    });

    expect(editResult.analysis.metrics.incremental).toBeUndefined();
    expect(editResult.reconciliation.changedHeaders).toBe(true);
    expect(editResult.affectedTargets.map((id) => id.split("#")[1])).toEqual(["class:User", "class:Greeting", "function:renderGreeting", "class:Greeter"]);
  });

  it("extracts Go single-file pieces and exposes Bazel-like targets", async () => {
    const compiler = createPieceCompiler();
    const analysis = await compiler.analyzeFile({
      filePath: "/repo/src/Pricing.go",
      source: goSource()
    });

    expect(analysis.manifest.parser).toBe("go-declaration-extractor");
    expect(analysis.manifest.importBindings).toEqual([{ local: "fmt", imported: "fmt", source: "fmt", kind: "namespace", isTypeOnly: false }]);
    expect(analysis.manifest.slices.map((slice) => [slice.kind, slice.name, slice.preview.previewable])).toEqual([
      ["type", "User", true],
      ["type", "Greeting", true],
      ["value", "prefix", false],
      ["function", "RenderGreeting", true]
    ]);
    expect(analysis.graph.edges.map((edge) => [edge.from.split("#")[1], edge.kind, edge.to.split("#")[1] ?? edge.to, edge.symbols])).toEqual([
      ["function:RenderGreeting", "type", "type:Greeting", ["Greeting"]],
      ["function:RenderGreeting", "type", "type:User", ["User"]],
      ["function:RenderGreeting", "runtime", "value:prefix", ["prefix"]],
      ["function:RenderGreeting", "external", "fmt", ["fmt"]]
    ]);
    expect(analysis.piecePackage).toMatchObject({
      language: "go",
      label: "//repo/src:Pricing.go"
    });
    expect(analysis.piecePackage.rules.find((rule) => rule.name === "go_piece_function")).toMatchObject({
      actionKind: "compile",
      implementation: "go.function.compile"
    });
    expect(analysis.piecePackage.targets.map((target) => [target.rule, target.label])).toContainEqual([
      "go_piece_function",
      "//repo/src:Pricing.go__function_RenderGreeting"
    ]);
    expect(analysis.piecePackage.actions.map((action) => [action.id, action.kind, action.mnemonic])).toContainEqual([
      "//repo/src:Pricing.go__function_RenderGreeting%compile",
      "compile",
      "PieceCompile"
    ]);
    expect(analysis.pieceDsl).toContain("language go");
    expect(analysis.pieceDsl).toContain('target function "RenderGreeting"');
    expect(analysis.pieceDsl).toContain('action compile {');
    expect(analysis.pieceDslSource).toBe("current-file");
  });

  it("rebuilds Go affected targets with full reanalysis", async () => {
    const compiler = createPieceCompiler();
    const previousSource = goSource();
    const previousAnalysis = await compiler.analyzeFile({
      filePath: "/repo/src/Pricing.go",
      source: previousSource
    });
    const nextSource = previousSource.replace('"Hello"', '"Hi"');
    const editResult = await compiler.applyEdit({
      filePath: "/repo/src/Pricing.go",
      source: nextSource,
      previousAnalysis,
      changedRanges: [changedRange(previousSource, nextSource)]
    });

    expect(editResult.analysis.metrics.incremental).toBeUndefined();
    expect(editResult.edit.changedSlices.map((id) => id.split("#")[1])).toEqual(["value:prefix"]);
    expect(editResult.affectedTargets.map((id) => id.split("#")[1])).toEqual(["function:RenderGreeting"]);
  });

  it("adapts a Kotlin core JS bridge module into plain PiecePackage objects", () => {
    const bridge = createKotlinCoreBridge({
      piece: {
        bridge: {
          createPiecePackageJson(filePath, language, targetSpecs) {
            expect(filePath).toBe("/repo/src/Pricing.kt");
            expect(language).toBe("kotlin");
            expect(targetSpecs).toContain("function\trenderGreeting\t:prefix\tanalysis");
            expect(targetSpecs).toContain("function\tcompileGreeting\t\tcompile\tcompile");
            return JSON.stringify({
              version: 1,
              kind: "single-file-package",
              language,
              packageName: "repo/src",
              label: "//repo/src:Pricing.kt",
              filePath,
              sourceFile: "//repo/src:Pricing.kt",
              rules: [],
              targets: [{ name: "renderGreeting", label: "//repo/src:Pricing.kt__function_renderGreeting" }],
              actions: [],
              artifacts: []
            });
          },
          createPieceGraphJson() {
            return JSON.stringify({
              packageLabel: "//repo/src:Pricing.kt",
              targets: [],
              edges: [{ from: "//repo/src:Pricing.kt__function_renderGreeting", to: "//repo/src:Pricing.kt__value_prefix", kind: "runtime", symbols: [] }]
            });
          },
          sampleKotlinPackageJson() {
            return JSON.stringify({
              version: 1,
              kind: "single-file-package",
              language: "kotlin",
              packageName: "repo/src",
              label: "//repo/src:Pricing.kt",
              filePath: "/repo/src/Pricing.kt",
              sourceFile: "//repo/src:Pricing.kt",
              rules: [],
              targets: [],
              actions: [],
              artifacts: []
            });
          }
        }
      }
    });

    const piecePackage = bridge.createPackageFromTargets({
      filePath: "/repo/src/Pricing.kt",
      targets: [
        { kind: "value", name: "prefix" },
        { kind: "function", name: "renderGreeting", deps: [":prefix"] },
        { kind: "function", name: "compileGreeting", actionKind: "compile" }
      ]
    });
    const graph = bridge.createGraphFromTargets({
      filePath: "/repo/src/Pricing.kt",
      targets: [{ kind: "function", name: "renderGreeting" }]
    });

    expect(piecePackage.targets[0].label).toBe("//repo/src:Pricing.kt__function_renderGreeting");
    expect(graph.edges[0].kind).toBe("runtime");
  });
});
