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

const aliasSource = `package demo.app

import demo.symbols.User as DomainUser

fun render(user: DomainUser): String = user.name
`;
const aliasManifest = await analyzeKotlinPieceFile({
  filePath: "/repo/src/AliasRender.kt",
  source: aliasSource,
  sourceFiles: crossFileCompanions,
  backend: "analysis-api",
  analysisApiEnabled: true
});
const aliasBinding = aliasManifest.importBindings.find(
  (binding) => binding.local === "DomainUser" && binding.imported === "User" && binding.source === "/repo/src/Models.kt"
);
assert(
  aliasBinding,
  `Kotlin Analysis API did not map the imported alias to the companion source declaration: ${JSON.stringify(aliasManifest.importBindings)}`
);
const aliasAnalysis = await analyzePieceFile({
  filePath: "/repo/src/AliasRender.kt",
  source: aliasSource,
  declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
    sourceFiles: crossFileCompanions,
    backend: "analysis-api",
    analysisApiEnabled: true
  })
});
assert(
  aliasAnalysis.graph.edges.some(
    (edge) =>
      edge.kind === "external" &&
      edge.to === "/repo/src/Models.kt#User" &&
      edge.symbols.includes("DomainUser") &&
      edge.import?.local === "DomainUser"
  ),
  `Kotlin Analysis API imported alias did not prefer the companion source external edge: ${JSON.stringify(aliasAnalysis.graph.edges)}`
);
assert(
  !aliasAnalysis.graph.edges.some((edge) => edge.to === "demo.symbols#User"),
  `Kotlin Analysis API imported alias should override the PSI package-only edge: ${JSON.stringify(aliasAnalysis.graph.edges)}`
);

console.log("Kotlin Analysis API smoke passed");
