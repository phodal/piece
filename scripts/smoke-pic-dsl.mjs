import { parsePieceDslFile } from "../src/node.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = `package "//repo/src:Pricing.kt" {
  language kotlin
  source "/repo/src/Pricing.kt"

  target class "User" {}
  target class "Greeting" {}
  target value "prefix" {}
  target function "renderGreeting" {
    deps ":User", ":Greeting", ":prefix"
    action compile {
      mnemonic "PieceCompile"
      output "Pricing.kt__function_renderGreeting.compile.json"
    }
  }
}
`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const result = await parsePieceDslFile({
  filePath: "/repo/src/Pricing.pic",
  source
});

assert(result.parser === "antlr-pic-parser", `Unexpected .pic parser: ${result.parser}`);
assert(result.diagnostics.length === 0, `Unexpected .pic diagnostics: ${JSON.stringify(result.diagnostics)}`);
assert(result.piecePackage, "Expected .pic parser to return a PiecePackage.");
assert(result.piecePackage.label === "//repo/src:Pricing.kt", `Unexpected package label: ${result.piecePackage.label}`);
assert(result.piecePackage.language === "kotlin", `Unexpected language: ${result.piecePackage.language}`);
assert(
  JSON.stringify(result.piecePackage.targets.map((target) => [target.kind, target.name])) ===
    JSON.stringify([
      ["class", "User"],
      ["class", "Greeting"],
      ["value", "prefix"],
      ["function", "renderGreeting"]
    ]),
  `Unexpected .pic targets: ${JSON.stringify(result.piecePackage.targets)}`
);
assert(
  result.piecePackage.actions.some(
    (action) =>
      action.id === "//repo/src:Pricing.kt__function_renderGreeting%compile" &&
      action.kind === "compile" &&
      action.mnemonic === "PieceCompile" &&
      action.outputs.includes("Pricing.kt__function_renderGreeting.compile.json")
  ),
  `Expected .pic compile action was not returned: ${JSON.stringify(result.piecePackage.actions)}`
);

const broken = await parsePieceDslFile({
  filePath: "/repo/src/Broken.pic",
  source: `package "//repo/src:Broken.kt" {
    language kotlin
    source "/repo/src/Broken.kt"
    target function "broken" {
  }`
});

assert(
  broken.diagnostics.some((diagnostic) => diagnostic.code === "pic-syntax-error" && diagnostic.severity === "error"),
  `Expected .pic syntax diagnostics: ${JSON.stringify(broken.diagnostics)}`
);

const workspace = await mkdtemp(join(tmpdir(), "piece-pic-file-"));
try {
  await writeFile(join(workspace, "package.pic"), source, "utf8");
  const fromFile = await parsePieceDslFile({ cwd: workspace });
  assert(fromFile.piecePackage?.label === "//repo/src:Pricing.kt", `Unexpected file-backed .pic package: ${JSON.stringify(fromFile)}`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

console.log(".pic DSL smoke passed");
