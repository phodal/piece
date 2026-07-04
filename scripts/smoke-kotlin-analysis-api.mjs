import { analyzeKotlinPieceFile, analyzePieceFile, createNodeKotlinPsiDeclarationExtractor } from "../src/node.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const source = `package demo.symbols

class User

fun <User> render(value: User): User = value
`;

const manifest = await analyzeKotlinPieceFile({
  filePath: "/repo/src/Symbols.kt",
  source,
  backend: "analysis-api",
  analysisApiEnabled: true
});
const render = manifest.slices.find((slice) => slice.name === "render");

assert(render, `Kotlin Analysis API manifest did not include render: ${JSON.stringify(manifest.slices)}`);
assert(
  manifest.analysisBackend?.requested === "analysis-api" &&
    manifest.analysisBackend?.actual === "analysis-api" &&
    manifest.analysisBackend?.symbols === "analysis-api" &&
    manifest.analysisBackend?.status === "ready" &&
    manifest.analysisBackend?.analysisApiEnabled === true &&
    manifest.analysisBackend?.analysisApiAvailable === true,
  `Kotlin Analysis API backend was not used: ${JSON.stringify(manifest.analysisBackend)}`
);
assert(
  JSON.stringify(render.symbols.references) === JSON.stringify([]) &&
    JSON.stringify(render.symbols.typeReferences) === JSON.stringify([]),
  `Kotlin Analysis API did not remove type-parameter shadowed User references: ${JSON.stringify(render.symbols)}`
);
assert(
  !manifest.diagnostics.some((diagnostic) => diagnostic.code === "kotlin-analysis-backend-fallback"),
  `Kotlin Analysis API should not emit fallback diagnostics when the gate and runtime are available: ${JSON.stringify(manifest.diagnostics)}`
);

const crossFileSource = `package demo.symbols

fun render(user: User): String = user.name
`;
const crossFileCompanions = [
  {
    filePath: "/repo/src/Models.kt",
    source: `package demo.symbols

data class User(val name: String)
`
  }
];
const crossFileManifest = await analyzeKotlinPieceFile({
  filePath: "/repo/src/Render.kt",
  source: crossFileSource,
  sourceFiles: crossFileCompanions,
  backend: "analysis-api",
  analysisApiEnabled: true
});
const crossFileRender = crossFileManifest.slices.find((slice) => slice.name === "render");
assert(crossFileRender, `Kotlin Analysis API cross-file manifest did not include render: ${JSON.stringify(crossFileManifest.slices)}`);
assert(
  crossFileManifest.analysisBackend?.actual === "analysis-api" &&
    crossFileManifest.analysisBackend?.symbols === "analysis-api",
  `Kotlin Analysis API cross-file backend was not used: ${JSON.stringify(crossFileManifest.analysisBackend)}`
);
assert(
  JSON.stringify(crossFileManifest.importBindings) ===
    JSON.stringify([{ local: "User", imported: "User", source: "/repo/src/Models.kt", kind: "named", isTypeOnly: false }]),
  `Kotlin Analysis API companion source-set binding was not returned: ${JSON.stringify(crossFileManifest.importBindings)}`
);
assert(
  crossFileRender.symbols.typeReferences.includes("User"),
  `Kotlin Analysis API companion source-set type reference was not retained for graph binding: ${JSON.stringify(crossFileRender.symbols)}`
);

const crossFileAnalysis = await analyzePieceFile({
  filePath: "/repo/src/Render.kt",
  source: crossFileSource,
  declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
    sourceFiles: crossFileCompanions,
    backend: "analysis-api",
    analysisApiEnabled: true
  })
});
assert(
  crossFileAnalysis.graph.edges.some(
    (edge) => edge.kind === "external" && edge.to === "/repo/src/Models.kt#User" && edge.symbols.includes("User")
  ),
  `Kotlin Analysis API companion binding did not become an external graph edge: ${JSON.stringify(crossFileAnalysis.graph.edges)}`
);

console.log("Kotlin Analysis API smoke passed");
