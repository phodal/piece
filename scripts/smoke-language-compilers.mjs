import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzePieceFile, compileGoPieceFile, compilePieceAction, compilePieceApp } from "../src/node.js";

const goSource = `package main

import "fmt"

type User struct {
  Name string
}

func RenderGreeting(user User) string {
  return "Hello, " + user.Name
}

func main() {
  fmt.Println(RenderGreeting(User{Name: "Ada"}))
}
`;

const goPricingSource = `package pricing

type Greeting struct {
  Discount Discount
}
`;

const goPricingCompanionSource = `package pricing

type Discount struct {
  Percent int
}
`;

const tsSource = `export function renderGreeting(name: string): string {
  return "Hello, " + name;
}
`;

const kotlinSource = `package demo.pricing

fun renderGreeting(user: User): Greeting {
    return Greeting("Hello, " + user.name)
}
`;

const kotlinModelSource = `package demo.pricing

data class User(val name: String)
data class Greeting(val message: String)
`;

const simpleKotlinSource = `package demo.pricing

fun renderGreeting(name: String): String {
    return "Hello, " + name
}
`;

const kotlinOverrideSource = `package "//repo/src:Pricing.kt" {
  language kotlin
  source "/repo/src/Pricing.kt"

  target function "renderGreeting" {
    label "//repo/src:pricing_kotlin_render_greeting"
    action compile {
      output "kotlin-render-greeting.compile.json"
      cacheKey "kotlin-render-greeting.compile.json:cache-key"
    }
  }
}
`;

const simpleKotlinOverrideSource = `package "//repo/src/SimplePricing.kt" {
  language kotlin
  source "/repo/src/SimplePricing.kt"

  target function "renderGreeting" {
    label "//repo/src:simple_kotlin_render_greeting"
    action compile {
      output "simple-kotlin-render-greeting.compile.json"
      cacheKey "simple-kotlin-render-greeting.compile.json:cache-key"
    }
  }
}
`;

function sourceLabelFor(filePath) {
  const parts = filePath.replace(/\\/g, "/").split("/");
  const sourceName = parts.pop();
  const packageName = parts.filter(Boolean).join("/") || ".";
  return `//${packageName}:${sourceName}`;
}

function compileActionPackage({ language, filePath, targetName, targetLabel, output }) {
  const sourceLabel = sourceLabelFor(filePath);
  const actionId = `${targetLabel}%compile`;
  return {
    version: 1,
    kind: "single-file-package",
    language,
    packageName: sourceLabel.slice(2, sourceLabel.indexOf(":")),
    label: sourceLabel,
    filePath,
    sourceFile: sourceLabel,
    rules: [
      {
        name: `${language}_piece_function`,
        language,
        targetKind: "function",
        actionKind: "compile",
        implementation: `${language}.function.compile`
      }
    ],
    targets: [
      {
        id: `${filePath}#function:${targetName}`,
        label: targetLabel,
        name: targetName,
        kind: "function",
        rule: `${language}_piece_function`,
        source: sourceLabel,
        deps: [],
        runtimeDeps: [],
        typeDeps: [],
        externalDeps: [],
        actions: [actionId],
        artifacts: [output],
        visibility: ["//visibility:private"]
      }
    ],
    actions: [
      {
        id: actionId,
        target: targetLabel,
        kind: "compile",
        mnemonic: "PieceCompile",
        inputs: [sourceLabel],
        outputs: [output]
      }
    ],
    artifacts: [
      {
        id: output,
        target: targetLabel,
        kind: "piece-compile",
        path: output,
        cacheKey: `${output}:cache-key`
      }
    ]
  };
}

function assertSuccess(result, label) {
  if (result.status !== "success") {
    const diagnostics = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    throw new Error(`${label} compile failed:\n${diagnostics}`);
  }
}

const goActionPackage = compileActionPackage({
  language: "go",
  filePath: "/repo/src/Pricing.go",
  targetName: "RenderGreeting",
  targetLabel: "//repo/src:pricing_go_render_greeting",
  output: "go-render-greeting.compile.json"
});
const goResult = await compileGoPieceFile({
  filePath: "/repo/src/Pricing.go",
  source: goSource,
  actionPackage: goActionPackage,
  pieceTarget: "RenderGreeting"
});
assertSuccess(goResult, "Go");
if (JSON.stringify(goResult.pieceAction) !== JSON.stringify({
  targetLabel: "//repo/src:pricing_go_render_greeting",
  actionId: "//repo/src:pricing_go_render_greeting%compile",
  artifactId: "go-render-greeting.compile.json",
  kind: "compile"
})) {
  throw new Error(`Go compile did not resolve Piece action identity from actionPackage: ${JSON.stringify(goResult.pieceAction)}`);
}
const goActionCacheRoot = await mkdtemp(join(tmpdir(), "piece-go-action-cache-"));
const goActionCacheStorePath = join(goActionCacheRoot, "action-cache.json");
try {
  const goAppStatus = await compilePieceApp({
    filePath: "/repo/src/Pricing.go",
    source: goSource,
    target: "RenderGreeting",
    compileAction: true,
    actionPackage: goActionPackage,
    actionCacheStorePath: goActionCacheStorePath
  });
  assertSuccess(goAppStatus.compileAction, "Go app-level Piece action");
  if (
    goAppStatus.compileAction.actionCache?.status !== "miss" ||
    !goAppStatus.compileAction.actionCache.record?.key ||
    goAppStatus.compileAction.actionCache.execution?.skipped !== false ||
    goAppStatus.compileAction.actionCache.persistence?.status !== "stored" ||
    goAppStatus.compileActionSelection?.actionCache?.record?.key !== goAppStatus.compileAction.actionCache.record.key ||
    goAppStatus.compileActionSelection.actionCache.persistence?.status !== "stored"
  ) {
    throw new Error(`compilePieceApp did not expose persisted status-only action cache metadata: ${JSON.stringify({
      compileActionCache: goAppStatus.compileAction.actionCache,
      selectionActionCache: goAppStatus.compileActionSelection?.actionCache
    })}`);
  }
  const goActionCacheStore = JSON.parse(await readFile(goActionCacheStorePath, "utf8"));
  const storedRecord = goActionCacheStore.records?.[goAppStatus.compileAction.actionCache.record.key];
  if (
    storedRecord?.kind !== "piece-action-cache-record" ||
    storedRecord.result?.status !== "success" ||
    !storedRecord.result.outputFiles?.every((file) => file.path.includes("/artifacts/") && file.contentHash)
  ) {
    throw new Error(`compilePieceApp did not persist a usable action-cache record: ${JSON.stringify(goActionCacheStore)}`);
  }
  if (JSON.stringify(goAppStatus.compileAction?.pieceAction) !== JSON.stringify(goResult.pieceAction)) {
    throw new Error(`compilePieceApp did not retain app-level Piece action identity: ${JSON.stringify(goAppStatus.compileAction?.pieceAction)}`);
  }
  if (
    goAppStatus.compileActionSelection?.actionPackageSource !== "explicit" ||
    goAppStatus.compileActionSelection.feedbackScope.fallbackRequired !== false
  ) {
    throw new Error(`compilePieceApp did not expose app-level compile selection metadata: ${JSON.stringify(goAppStatus.compileActionSelection)}`);
  }
  const badGoAppStatus = await compilePieceApp({
    filePath: "/repo/src/Pricing.go",
    source: goSource,
    target: "RenderGreeting",
    compileAction: true,
    actionPackage: goActionPackage,
    pieceTarget: "MissingTarget"
  });
  if (badGoAppStatus.compileAction) {
    throw new Error(`compilePieceApp should not attach a compile action for an invalid target: ${JSON.stringify(badGoAppStatus.compileAction)}`);
  }
  if (badGoAppStatus.compileActionDiagnostics?.[0]?.code !== "piece-compile-action-dispatch-failed") {
    throw new Error(`compilePieceApp did not return a structured compile-action diagnostic: ${JSON.stringify(badGoAppStatus.compileActionDiagnostics)}`);
  }
  if (badGoAppStatus.compileActionSelection?.actionPackageSource !== "explicit") {
    throw new Error(`compilePieceApp did not retain selection metadata on dispatch failure: ${JSON.stringify(badGoAppStatus.compileActionSelection)}`);
  }
  if ((badGoAppStatus.diagnostics?.issueCount ?? 0) <= (goAppStatus.diagnostics?.issueCount ?? 0)) {
    throw new Error(`compilePieceApp did not count the compile-action diagnostic: ${JSON.stringify(badGoAppStatus.diagnostics)}`);
  }
  const goActionCacheHit = await compilePieceAction({
    filePath: "/repo/src/Pricing.go",
    source: goSource,
    analysis: goAppStatus.analysis,
    actionPackage: goActionPackage,
    actionCacheStorePath: goActionCacheStorePath
  });
  assertSuccess(goActionCacheHit, "Go status-only action-cache hit");
  if (
    goActionCacheHit.actionCache?.status !== "hit" ||
    goActionCacheHit.actionCache.matchedRecordKey !== goAppStatus.compileAction.actionCache.record.key ||
    goActionCacheHit.actionCache.execution?.skipped !== false ||
    goActionCacheHit.actionCache.persistence?.status !== "stored" ||
    goActionCacheHit.commands.length === 0
  ) {
    throw new Error(`compilePieceAction did not report a non-skipping persisted local cache hit: ${JSON.stringify(goActionCacheHit.actionCache)}`);
  }
  const goActionCacheReuse = await compilePieceAction({
    filePath: "/repo/src/Pricing.go",
    source: goSource,
    analysis: goAppStatus.analysis,
    actionPackage: goActionPackage,
    actionCacheStorePath: goActionCacheStorePath,
    actionCacheMode: "reuse-local"
  });
  assertSuccess(goActionCacheReuse, "Go reused local action-cache hit");
  if (
    goActionCacheReuse.actionCache?.status !== "hit" ||
    goActionCacheReuse.actionCache.execution?.skipped !== true ||
    goActionCacheReuse.actionCache.execution.reason !== "cached-artifact-reuse" ||
    goActionCacheReuse.actionCache.reuse?.status !== "reused" ||
    goActionCacheReuse.commands.length !== 0 ||
    goActionCacheReuse.outputFiles.length === 0 ||
    !goActionCacheReuse.outputFiles.every((file) => file.path.includes("/artifacts/"))
  ) {
    throw new Error(`compilePieceAction did not reuse a trusted local cache hit: ${JSON.stringify({
      actionCache: goActionCacheReuse.actionCache,
      commands: goActionCacheReuse.commands,
      outputFiles: goActionCacheReuse.outputFiles
    })}`);
  }
} finally {
  await rm(goActionCacheRoot, { recursive: true, force: true });
}
if (!goResult.commands.some((command) => command.command === "go" && command.args.join(" ") === "list -json ./...")) {
  throw new Error(`Go compile did not run go list before build/test: ${JSON.stringify(goResult.commands)}`);
}
if (goResult.goList?.status !== "success" || !goResult.goList.packageHash) {
  throw new Error(`Go list did not return stable package metadata: ${JSON.stringify(goResult.goList)}`);
}
const goPackage = goResult.goList.packages.find((pkg) => pkg.name === "main");
if (!goPackage) {
  throw new Error(`Go list did not report the main package: ${JSON.stringify(goResult.goList)}`);
}
if (goPackage.module?.path !== "piece.local/Pricing" || !goPackage.imports.includes("fmt") || !goPackage.goFiles.includes("Pricing.go")) {
  throw new Error(`Go list package metadata was incomplete: ${JSON.stringify(goPackage)}`);
}
if (!goResult.outputFiles.some((file) => file.path.endsWith("Pricing"))) {
  throw new Error("Go compile did not produce the expected main binary artifact.");
}

const tsActionPackage = compileActionPackage({
  language: "typescript",
  filePath: "/repo/src/Greeter.ts",
  targetName: "renderGreeting",
  targetLabel: "//repo/src:ts_render_greeting",
  output: "ts-render-greeting.compile.json"
});
const tsActionCacheRoot = await mkdtemp(join(tmpdir(), "piece-ts-action-cache-"));
const tsActionCacheStorePath = join(tsActionCacheRoot, "action-cache.json");
let tsAppStatus;
let tsActionCacheReuse;
try {
  tsAppStatus = await compilePieceApp({
    filePath: "/repo/src/Greeter.ts",
    source: tsSource,
    compileAction: true,
    actionPackage: tsActionPackage,
    pieceTarget: "renderGreeting",
    actionCacheStorePath: tsActionCacheStorePath
  });
  assertSuccess(tsAppStatus.compileAction, "TypeScript app-level Piece action");
  if (
    tsAppStatus.compileAction.language !== "typescript" ||
    tsAppStatus.compileAction.backend !== "esbuild" ||
    tsAppStatus.compileAction.actionCache?.status !== "miss" ||
    tsAppStatus.compileAction.actionCache.persistence?.status !== "stored" ||
    tsAppStatus.compileActionSelection?.actionPackageSource !== "explicit" ||
    tsAppStatus.compileActionSelection.actionCache?.record?.key !== tsAppStatus.compileAction.actionCache.record?.key
  ) {
    throw new Error(`compilePieceApp did not persist TypeScript action-cache metadata: ${JSON.stringify({
      compileAction: tsAppStatus.compileAction,
      selection: tsAppStatus.compileActionSelection
    })}`);
  }
  const tsActionCacheStore = JSON.parse(await readFile(tsActionCacheStorePath, "utf8"));
  const tsStoredRecord = tsActionCacheStore.records?.[tsAppStatus.compileAction.actionCache.record.key];
  if (
    tsStoredRecord?.kind !== "piece-action-cache-record" ||
    tsStoredRecord.result?.status !== "success" ||
    !tsStoredRecord.result.outputFiles?.every((file) => file.path.includes("/artifacts/") && file.contentHash)
  ) {
    throw new Error(`TypeScript compile did not promote action-cache artifacts: ${JSON.stringify(tsActionCacheStore)}`);
  }
  tsActionCacheReuse = await compilePieceAction({
    filePath: "/repo/src/Greeter.ts",
    source: tsSource,
    analysis: tsAppStatus.analysis,
    actionPackage: tsActionPackage,
    pieceTarget: "renderGreeting",
    actionCacheStorePath: tsActionCacheStorePath,
    actionCacheMode: "reuse-local"
  });
} finally {
  await rm(tsActionCacheRoot, { recursive: true, force: true });
}
assertSuccess(tsActionCacheReuse, "TypeScript reused local action-cache hit");
if (
  tsActionCacheReuse.language !== "typescript" ||
  tsActionCacheReuse.backend !== "esbuild" ||
  tsActionCacheReuse.actionCache?.status !== "hit" ||
  tsActionCacheReuse.actionCache.execution?.skipped !== true ||
  tsActionCacheReuse.actionCache.reuse?.status !== "reused" ||
  tsActionCacheReuse.commands.length !== 0 ||
  !tsActionCacheReuse.outputFiles.every((file) => file.path.includes("/artifacts/"))
) {
  throw new Error(`TypeScript compile did not reuse trusted local cache artifacts: ${JSON.stringify({
    actionCache: tsActionCacheReuse.actionCache,
    commands: tsActionCacheReuse.commands,
    outputFiles: tsActionCacheReuse.outputFiles
  })}`);
}

const goPackageScopeStatus = await compilePieceApp({
  filePath: "/repo/src/Pricing.go",
  source: goPricingSource,
  sourceFiles: [
    {
      filePath: "/repo/src/Discount.go",
      source: goPricingCompanionSource
    }
  ],
  target: "Greeting",
  compileAction: true
});
if (!goPackageScopeStatus.compileAction) {
  throw new Error(`compilePieceApp did not attach a Go package-scope compile action report: ${JSON.stringify(goPackageScopeStatus)}`);
}
assertSuccess(goPackageScopeStatus.compileAction, "Go package-scope companion compile action");
if (
  !goPackageScopeStatus.compileAction.goList.packages.some(
    (pkg) => pkg.goFiles.includes("Pricing.go") && pkg.goFiles.includes("Discount.go")
  )
) {
  throw new Error(`Go package-scope compile did not write companion source files: ${JSON.stringify(goPackageScopeStatus.compileAction.goList)}`);
}
if (
  goPackageScopeStatus.compileActionSelection?.packageScope?.status !== "candidate" ||
  goPackageScopeStatus.compileActionSelection.packageScope.appliedToPackageView !== false ||
  !goPackageScopeStatus.compileActionSelection.packageScope.reason?.includes("candidate")
) {
  throw new Error(`compilePieceApp did not expose package-scope selection metadata: ${JSON.stringify(goPackageScopeStatus.compileActionSelection)}`);
}
if (goPackageScopeStatus.analysis?.snapshot?.actionPackage) {
  throw new Error(`candidate package-scope compile should not write an action package snapshot: ${JSON.stringify(goPackageScopeStatus.analysis.snapshot.actionPackage)}`);
}
const selectedGoPackageScopeStatus = await compilePieceApp({
  filePath: "/repo/src/Pricing.go",
  source: goPricingSource,
  sourceFiles: [
    {
      filePath: "/repo/src/Discount.go",
      source: goPricingCompanionSource
    }
  ],
  target: "Discount",
  compileAction: true,
  packageScopeSelection: "safe"
});
assertSuccess(selectedGoPackageScopeStatus.compileAction, "Go selected package-view compile action");
if (
  selectedGoPackageScopeStatus.compileActionSelection?.actionPackageSource !== "selected-package-view" ||
  selectedGoPackageScopeStatus.compileActionSelection.packageScope?.status !== "selected" ||
  selectedGoPackageScopeStatus.compileAction?.pieceAction?.targetLabel !== "//repo/src:Discount.go__type_Discount"
) {
  throw new Error(`compilePieceApp did not use selected package-view action metadata: ${JSON.stringify({
    selection: selectedGoPackageScopeStatus.compileActionSelection,
    pieceAction: selectedGoPackageScopeStatus.compileAction?.pieceAction
  })}`);
}
if (
  selectedGoPackageScopeStatus.analysis?.actionPackage ||
  !selectedGoPackageScopeStatus.analysis?.snapshot?.actionPackage?.targets.some(
    (target) => target.label === "//repo/src:Discount.go__type_Discount"
  )
) {
  throw new Error(`selected package-view compile status did not retain an action package snapshot: ${JSON.stringify({
    analysisActionPackage: selectedGoPackageScopeStatus.analysis?.actionPackage,
    snapshotActionPackage: selectedGoPackageScopeStatus.analysis?.snapshot?.actionPackage
  })}`);
}

const kotlinSourceRoot = await mkdtemp(join(tmpdir(), "piece-kotlin-compile-source-root-"));
let kotlinResult;
try {
  await writeFile(join(kotlinSourceRoot, "Models.kt"), kotlinModelSource, "utf8");
  const kotlinAnalysis = await analyzePieceFile({
    filePath: "/repo/src/Pricing.kt",
    source: kotlinSource,
    sourceRoots: [kotlinSourceRoot],
    overrideFilePath: "/repo/src/Pricing.override.pic",
    overrideSource: kotlinOverrideSource,
    pieceDslOverrideMode: "action-snapshot"
  });
  if (!kotlinAnalysis.actionPackage?.targets.some((target) => target.label === "//repo/src:pricing_kotlin_render_greeting")) {
    throw new Error(`Kotlin analysis did not expose override actionPackage: ${JSON.stringify(kotlinAnalysis.actionPackage)}`);
  }
  kotlinResult = await compilePieceAction({
    analysis: kotlinAnalysis,
    sourceRoots: [kotlinSourceRoot],
    target: "all",
    pieceTarget: "renderGreeting"
  });
} finally {
  await rm(kotlinSourceRoot, { recursive: true, force: true });
}
assertSuccess(kotlinResult, "Kotlin");
if (kotlinResult.backend !== "kotlin-jvm") {
  throw new Error(`Expected Kotlin compile backend to be kotlin-jvm, got ${kotlinResult.backend}.`);
}
if (JSON.stringify(kotlinResult.pieceAction) !== JSON.stringify({
  targetLabel: "//repo/src:pricing_kotlin_render_greeting",
  actionId: "//repo/src:pricing_kotlin_render_greeting%compile",
  artifactId: "kotlin-render-greeting.compile.json",
  kind: "compile"
})) {
  throw new Error(`Kotlin compile did not resolve Piece action identity from actionPackage: ${JSON.stringify(kotlinResult.pieceAction)}`);
}
if (!kotlinResult.commands.some((command) => command.command === "gradle-tooling-api")) {
  throw new Error(`Kotlin compile did not use Gradle Tooling API: ${kotlinResult.commands.map((command) => command.command).join(", ")}`);
}
if (!kotlinResult.outputFiles.some((file) => file.path.endsWith(".jar"))) {
  throw new Error("Kotlin JVM compile did not produce a jar artifact.");
}
if (!kotlinResult.outputFiles.some((file) => file.path.endsWith(".wasm"))) {
  throw new Error("Kotlin/Wasm compile did not produce a wasm artifact.");
}
if (!kotlinResult.outputFiles.some((file) => file.path.endsWith(".js"))) {
  throw new Error("Kotlin/JS compile did not produce a JavaScript artifact.");
}

const simpleKotlinActionCacheRoot = await mkdtemp(join(tmpdir(), "piece-simple-kotlin-action-cache-"));
const simpleKotlinActionCacheStorePath = join(simpleKotlinActionCacheRoot, "action-cache.json");
let simpleKotlinResult;
let simpleKotlinActionCacheReuse;
try {
  const simpleKotlinAnalysis = await analyzePieceFile({
    filePath: "/repo/src/SimplePricing.kt",
    source: simpleKotlinSource,
    overrideFilePath: "/repo/src/SimplePricing.override.pic",
    overrideSource: simpleKotlinOverrideSource,
    pieceDslOverrideMode: "action-snapshot"
  });
  if (simpleKotlinAnalysis.feedbackScope?.fallbackRequired) {
    throw new Error(`Simple Kotlin action-cache smoke should not require fallback: ${JSON.stringify(simpleKotlinAnalysis.feedbackScope)}`);
  }
  simpleKotlinResult = await compilePieceAction({
    analysis: simpleKotlinAnalysis,
    target: "jvm",
    pieceTarget: "renderGreeting",
    actionCacheStorePath: simpleKotlinActionCacheStorePath
  });
  if (
    simpleKotlinResult.actionCache?.status !== "miss" ||
    simpleKotlinResult.actionCache.persistence?.status !== "stored" ||
    !simpleKotlinResult.actionCache.record?.key
  ) {
    throw new Error(`Simple Kotlin compile did not persist action-cache metadata: ${JSON.stringify(simpleKotlinResult.actionCache)}`);
  }
  const simpleKotlinActionCacheStore = JSON.parse(await readFile(simpleKotlinActionCacheStorePath, "utf8"));
  const simpleKotlinStoredRecord = simpleKotlinActionCacheStore.records?.[simpleKotlinResult.actionCache.record.key];
  if (
    simpleKotlinStoredRecord?.kind !== "piece-action-cache-record" ||
    simpleKotlinStoredRecord.result?.status !== "success" ||
    !simpleKotlinStoredRecord.result.outputFiles?.every((file) => file.path.includes("/artifacts/") && file.contentHash)
  ) {
    throw new Error(`Simple Kotlin compile did not promote action-cache artifacts: ${JSON.stringify(simpleKotlinActionCacheStore)}`);
  }
  simpleKotlinActionCacheReuse = await compilePieceAction({
    analysis: simpleKotlinAnalysis,
    target: "jvm",
    pieceTarget: "renderGreeting",
    actionCacheStorePath: simpleKotlinActionCacheStorePath,
    actionCacheMode: "reuse-local"
  });
} finally {
  await rm(simpleKotlinActionCacheRoot, { recursive: true, force: true });
}
assertSuccess(simpleKotlinResult, "Simple Kotlin cached compile");
assertSuccess(simpleKotlinActionCacheReuse, "Simple Kotlin reused local action-cache hit");
if (
  simpleKotlinActionCacheReuse.actionCache?.status !== "hit" ||
  simpleKotlinActionCacheReuse.actionCache.execution?.skipped !== true ||
  simpleKotlinActionCacheReuse.actionCache.reuse?.status !== "reused" ||
  simpleKotlinActionCacheReuse.commands.length !== 0 ||
  !simpleKotlinActionCacheReuse.outputFiles.every((file) => file.path.includes("/artifacts/"))
) {
  throw new Error(`Simple Kotlin compile did not reuse trusted local cache artifacts: ${JSON.stringify({
    actionCache: simpleKotlinActionCacheReuse.actionCache,
    commands: simpleKotlinActionCacheReuse.commands,
    outputFiles: simpleKotlinActionCacheReuse.outputFiles
  })}`);
}

console.log("Language compiler smoke passed");
