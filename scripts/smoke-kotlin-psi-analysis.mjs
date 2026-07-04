import { analyzeKotlinPieceFile, analyzePieceFile, createNodeKotlinPsiDeclarationExtractor } from "../src/node.js";

const filePath = "/repo/src/Pricing.kt";
const source = `package demo.pricing

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const manifest = await analyzeKotlinPieceFile({ filePath, source });
assert(manifest.parser === "kotlin-psi-declaration-extractor", `Unexpected Kotlin PSI parser: ${manifest.parser}`);
assert(manifest.diagnostics.length === 0, `Expected no Kotlin PSI diagnostics, got ${JSON.stringify(manifest.diagnostics)}`);
assert(
  JSON.stringify(manifest.importBindings) ===
    JSON.stringify([{ local: "FeatureFlag", imported: "FeatureFlag", source: "demo.flags", kind: "named", isTypeOnly: false }]),
  `Unexpected Kotlin PSI import bindings: ${JSON.stringify(manifest.importBindings)}`
);
assert(
  JSON.stringify(manifest.slices.map((slice) => [slice.kind, slice.name, slice.preview.previewable])) ===
    JSON.stringify([
      ["class", "User", true],
      ["class", "Greeting", true],
      ["value", "prefix", false],
      ["function", "renderGreeting", true],
      ["class", "Greeter", true]
    ]),
  `Unexpected Kotlin PSI slices: ${JSON.stringify(manifest.slices.map((slice) => [slice.kind, slice.name, slice.preview.previewable]))}`
);

const analysis = await analyzePieceFile({
  filePath,
  source,
  declarationExtractor: createNodeKotlinPsiDeclarationExtractor()
});
const defaultNodeAnalysis = await analyzePieceFile({ filePath, source });
const edgeTuples = analysis.graph.edges.map((edge) => [edge.from.split("#")[1], edge.kind, edge.to.split("#")[1] ?? edge.to, edge.symbols]);

assert(analysis.manifest.parser === "kotlin-psi-declaration-extractor", "Kotlin PSI extractor was not used by analyzePieceFile().");
assert(
  defaultNodeAnalysis.manifest.parser === "kotlin-psi-declaration-extractor",
  `piece-compiler/node did not default Kotlin analysis to PSI: ${defaultNodeAnalysis.manifest.parser}`
);
assert(analysis.piecePackage.language === "kotlin", `Unexpected piece package language: ${analysis.piecePackage.language}`);
assert(
  edgeTuples.some(
    ([from, kind, to, symbols]) => from === "function:renderGreeting" && kind === "runtime" && to === "value:prefix" && symbols.includes("prefix")
  ),
  `Kotlin PSI graph did not include renderGreeting -> prefix: ${JSON.stringify(edgeTuples)}`
);
assert(
  edgeTuples.some(
    ([from, kind, to, symbols]) => from === "class:Greeter" && kind === "runtime" && to === "function:renderGreeting" && symbols.includes("renderGreeting")
  ),
  `Kotlin PSI graph did not include Greeter -> renderGreeting: ${JSON.stringify(edgeTuples)}`
);

const semanticDiagnostics = await analyzeKotlinPieceFile({
  filePath: "/repo/src/Broken.kt",
  source: `package demo.broken

fun broken(): String = 42
`,
  semanticDiagnostics: true
});
assert(
  semanticDiagnostics.diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === "error" &&
      diagnostic.path === "/repo/src/Broken.kt" &&
      (diagnostic.message.includes("String") || diagnostic.message.includes("Int"))
  ),
  `Kotlin compiler semantic diagnostics were not returned: ${JSON.stringify(semanticDiagnostics.diagnostics)}`
);

const symbolSource = `package demo.symbols

class User

fun <User> render(value: User): User = value
`;
const semanticSymbols = await analyzeKotlinPieceFile({
  filePath: "/repo/src/Symbols.kt",
  source: symbolSource,
  semanticSymbols: true
});
const symbolRender = semanticSymbols.slices.find((slice) => slice.name === "render");
assert(symbolRender, `Kotlin semantic symbol manifest did not include render: ${JSON.stringify(semanticSymbols.slices)}`);
assert(
  JSON.stringify(symbolRender.symbols.references) === JSON.stringify([]) &&
    JSON.stringify(symbolRender.symbols.typeReferences) === JSON.stringify([]),
  `Kotlin semantic symbols did not remove type-parameter shadowed User references: ${JSON.stringify(symbolRender.symbols)}`
);

console.log("Kotlin PSI analysis smoke passed");
