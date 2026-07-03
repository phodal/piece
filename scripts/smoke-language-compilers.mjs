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

data class User(val name: String)
data class Greeting(val message: String)

fun renderGreeting(user: User): Greeting {
    return Greeting("Hello, " + user.name)
}
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

const kotlinResult = await compileKotlinPieceFile({
  filePath: "/repo/src/Pricing.kt",
  source: kotlinSource,
  target: "all"
});
assertSuccess(kotlinResult, "Kotlin");
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
