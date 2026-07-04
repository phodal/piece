import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const kotlinSource = `package demo.pricing

fun renderGreeting(user: User): Greeting {
    return Greeting("Hello, " + user.name)
}
`;

const kotlinModelSource = `package demo.pricing

data class User(val name: String)
data class Greeting(val message: String)
`;

const kotlinOverrideSource = `package "//repo/src:Pricing.kt" {
  language kotlin
  source "/repo/src/Pricing.kt"

  target function "renderGreeting" {
    label "//repo/src:pricing_kotlin_render_greeting"
    action compile {
      output "kotlin-render-greeting.compile.json"
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
        path: output
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
const goAppStatus = await compilePieceApp({
  filePath: "/repo/src/Pricing.go",
  source: goSource,
  target: "RenderGreeting",
  compileAction: true,
  actionPackage: goActionPackage
});
assertSuccess(goAppStatus.compileAction, "Go app-level Piece action");
if (JSON.stringify(goAppStatus.compileAction?.pieceAction) !== JSON.stringify(goResult.pieceAction)) {
  throw new Error(`compilePieceApp did not retain app-level Piece action identity: ${JSON.stringify(goAppStatus.compileAction?.pieceAction)}`);
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
if ((badGoAppStatus.diagnostics?.issueCount ?? 0) <= (goAppStatus.diagnostics?.issueCount ?? 0)) {
  throw new Error(`compilePieceApp did not count the compile-action diagnostic: ${JSON.stringify(badGoAppStatus.diagnostics)}`);
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

console.log("Language compiler smoke passed");
