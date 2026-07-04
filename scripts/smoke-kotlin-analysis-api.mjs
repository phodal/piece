import { analyzeKotlinPieceFile } from "../src/node.js";

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

console.log("Kotlin Analysis API smoke passed");
