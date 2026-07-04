import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGoPieceFile, compileKotlinPieceFile } from "../src/node.js";

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

function assertSuccess(result, label) {
  if (result.status !== "success") {
    const diagnostics = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    throw new Error(`${label} compile failed:\n${diagnostics}`);
  }
}

const goResult = await compileGoPieceFile({
  filePath: "/repo/src/Pricing.go",
  source: goSource
});
assertSuccess(goResult, "Go");
if (!goResult.outputFiles.some((file) => file.path.endsWith("Pricing"))) {
  throw new Error("Go compile did not produce the expected main binary artifact.");
}

const kotlinSourceRoot = await mkdtemp(join(tmpdir(), "piece-kotlin-compile-source-root-"));
let kotlinResult;
try {
  await writeFile(join(kotlinSourceRoot, "Models.kt"), kotlinModelSource, "utf8");
  kotlinResult = await compileKotlinPieceFile({
    filePath: "/repo/src/Pricing.kt",
    source: kotlinSource,
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
  targetLabel: "//repo/src:Pricing.kt__function_renderGreeting",
  actionId: "//repo/src:Pricing.kt__function_renderGreeting%compile",
  artifactId: "//repo/src:Pricing.kt__function_renderGreeting.compile.json",
  kind: "compile"
})) {
  throw new Error(`Kotlin compile did not preserve Piece action identity: ${JSON.stringify(kotlinResult.pieceAction)}`);
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
