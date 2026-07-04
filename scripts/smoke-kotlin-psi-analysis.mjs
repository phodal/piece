import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { analyzeKotlinPieceFile, analyzePieceFile, createNodeKotlinPsiDeclarationExtractor } from "../src/node.js";

const execFileAsync = promisify(execFile);

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

async function createExternalUserJar(workspace) {
  const sourceDir = join(workspace, "src", "demo", "external");
  const classesDir = join(workspace, "classes");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(classesDir, { recursive: true });
  const sourceFile = join(sourceDir, "ExternalUser.java");
  await writeFile(
    sourceFile,
    `package demo.external;

public class ExternalUser {
  public String getName() {
    return "Ada";
  }
}
`,
    "utf8"
  );
  await execFileAsync("javac", ["-d", classesDir, sourceFile]);
  const jarPath = join(workspace, "external-user.jar");
  await execFileAsync("jar", ["cf", jarPath, "-C", classesDir, "."]);
  return jarPath;
}

const manifest = await analyzeKotlinPieceFile({ filePath, source });
assert(manifest.parser === "kotlin-psi-declaration-extractor", `Unexpected Kotlin PSI parser: ${manifest.parser}`);
assert(
  JSON.stringify(manifest.analysisBackend) ===
    JSON.stringify({
      requested: "psi",
      actual: "psi",
      declarations: "psi",
      symbols: "psi",
      diagnostics: "none",
      status: "ready"
    }),
  `Unexpected Kotlin default backend metadata: ${JSON.stringify(manifest.analysisBackend)}`
);
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
assert(
  defaultNodeAnalysis.manifest.analysisBackend?.actual === "psi",
  `piece-compiler/node did not expose default Kotlin backend metadata: ${JSON.stringify(defaultNodeAnalysis.manifest.analysisBackend)}`
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
  semanticDiagnostics.analysisBackend?.diagnostics === "kotlin-compiler-diagnostics",
  `Kotlin semantic diagnostics backend metadata was not returned: ${JSON.stringify(semanticDiagnostics.analysisBackend)}`
);
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
  backend: "fe10-binding-context"
});
const symbolRender = semanticSymbols.slices.find((slice) => slice.name === "render");
assert(symbolRender, `Kotlin semantic symbol manifest did not include render: ${JSON.stringify(semanticSymbols.slices)}`);
assert(
  semanticSymbols.analysisBackend?.requested === "fe10-binding-context" &&
    semanticSymbols.analysisBackend?.actual === "fe10-binding-context" &&
    semanticSymbols.analysisBackend?.symbols === "fe10-binding-context",
  `Kotlin FE10 backend metadata was not returned: ${JSON.stringify(semanticSymbols.analysisBackend)}`
);
assert(
  JSON.stringify(symbolRender.symbols.references) === JSON.stringify([]) &&
    JSON.stringify(symbolRender.symbols.typeReferences) === JSON.stringify([]),
  `Kotlin semantic symbols did not remove type-parameter shadowed User references: ${JSON.stringify(symbolRender.symbols)}`
);

const analysisApiFallback = await analyzeKotlinPieceFile({
  filePath: "/repo/src/Symbols.kt",
  source: symbolSource,
  backend: "analysis-api"
});
assert(
  analysisApiFallback.analysisBackend?.requested === "analysis-api" &&
    analysisApiFallback.analysisBackend?.actual === "fe10-binding-context" &&
    analysisApiFallback.analysisBackend?.status === "fallback",
  `Kotlin Analysis API fallback metadata was not returned: ${JSON.stringify(analysisApiFallback.analysisBackend)}`
);
assert(
  analysisApiFallback.diagnostics.some((diagnostic) => diagnostic.code === "kotlin-analysis-backend-fallback" && diagnostic.severity === "warning"),
  `Kotlin Analysis API fallback warning was not returned: ${JSON.stringify(analysisApiFallback.diagnostics)}`
);

const fe10NodeAnalysis = await analyzePieceFile({
  filePath: "/repo/src/Symbols.kt",
  source: symbolSource,
  kotlinAnalysisBackend: "fe10-binding-context"
});
assert(
  fe10NodeAnalysis.manifest.analysisBackend?.actual === "fe10-binding-context",
  `Default Node analyzePieceFile() did not pass Kotlin backend selector: ${JSON.stringify(fe10NodeAnalysis.manifest.analysisBackend)}`
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
  semanticSymbols: true
});
assert(
  JSON.stringify(crossFileManifest.importBindings) ===
    JSON.stringify([{ local: "User", imported: "User", source: "/repo/src/Models.kt", kind: "named", isTypeOnly: false }]),
  `Kotlin companion file binding was not returned: ${JSON.stringify(crossFileManifest.importBindings)}`
);
const crossFileAnalysis = await analyzePieceFile({
  filePath: "/repo/src/Render.kt",
  source: crossFileSource,
  declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
    semanticSymbols: true,
    sourceFiles: crossFileCompanions
  })
});
assert(
  crossFileAnalysis.graph.edges.some(
    (edge) => edge.kind === "external" && edge.to === "/repo/src/Models.kt#User" && edge.symbols.includes("User")
  ),
  `Kotlin companion file binding did not become an external graph edge: ${JSON.stringify(crossFileAnalysis.graph.edges)}`
);

const crossFileDiagnosticsManifest = await analyzeKotlinPieceFile({
  filePath: "/repo/src/Render.kt",
  source: crossFileSource,
  sourceFiles: crossFileCompanions,
  semanticDiagnostics: true
});
assert(
  !crossFileDiagnosticsManifest.diagnostics.some(
    (diagnostic) => diagnostic.severity === "error" && diagnostic.message.includes("User")
  ),
  `Kotlin companion source-set files were not visible to semantic diagnostics: ${JSON.stringify(crossFileDiagnosticsManifest.diagnostics)}`
);

const classpathWorkspace = await mkdtemp(join(tmpdir(), "piece-kotlin-classpath-"));
try {
  const externalJar = await createExternalUserJar(classpathWorkspace);
  const externalClasspathSource = `package demo.externaluse

import demo.external.ExternalUser

fun render(user: ExternalUser): String = user.name
`;
  const unresolvedExternalManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/ExternalRender.kt",
    source: externalClasspathSource,
    semanticDiagnostics: true
  });
  assert(
    unresolvedExternalManifest.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    `Expected Kotlin diagnostics to fail without external classpath: ${JSON.stringify(unresolvedExternalManifest.diagnostics)}`
  );

  const classpathManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/ExternalRender.kt",
    source: externalClasspathSource,
    semanticDiagnostics: true,
    classpath: [externalJar]
  });
  assert(
    !classpathManifest.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    `Kotlin external classpath was not visible to semantic diagnostics: ${JSON.stringify(classpathManifest.diagnostics)}`
  );

  const classpathAnalysis = await analyzePieceFile({
    filePath: "/repo/src/ExternalRender.kt",
    source: externalClasspathSource,
    semanticDiagnostics: true,
    classpath: [externalJar]
  });
  assert(
    !classpathAnalysis.manifest.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    `Default Node Kotlin analysis did not pass classpath to JVM backend: ${JSON.stringify(classpathAnalysis.manifest.diagnostics)}`
  );
} finally {
  await rm(classpathWorkspace, { recursive: true, force: true });
}

const sourceRoot = await mkdtemp(join(tmpdir(), "piece-kotlin-source-root-"));
try {
  const sourceRootModelPath = join(sourceRoot, "Models.kt");
  const sourceRootRenderPath = join(sourceRoot, "Render.kt");
  await writeFile(
    sourceRootModelPath,
    `package demo.symbols

data class User(val name: String)
`,
    "utf8"
  );
  await writeFile(sourceRootRenderPath, crossFileSource, "utf8");

  const sourceRootManifest = await analyzeKotlinPieceFile({
    filePath: sourceRootRenderPath,
    source: crossFileSource,
    sourceRoots: [sourceRoot],
    semanticSymbols: true
  });
  assert(
    JSON.stringify(sourceRootManifest.importBindings) ===
      JSON.stringify([{ local: "User", imported: "User", source: sourceRootModelPath, kind: "named", isTypeOnly: false }]),
    `Kotlin sourceRoot binding was not returned: ${JSON.stringify(sourceRootManifest.importBindings)}`
  );

  const sourcePathManifest = await analyzeKotlinPieceFile({
    filePath: sourceRootRenderPath,
    source: crossFileSource,
    sourceFiles: [sourceRootModelPath],
    semanticSymbols: true
  });
  assert(
    JSON.stringify(sourcePathManifest.importBindings) ===
      JSON.stringify([{ local: "User", imported: "User", source: sourceRootModelPath, kind: "named", isTypeOnly: false }]),
    `Kotlin sourceFiles path binding was not returned: ${JSON.stringify(sourcePathManifest.importBindings)}`
  );

  const relativeSourceRootManifest = await analyzeKotlinPieceFile({
    filePath: "Render.kt",
    source: crossFileSource,
    sourceRoots: ["."],
    cwd: sourceRoot,
    semanticSymbols: true
  });
  assert(
    JSON.stringify(relativeSourceRootManifest.importBindings) ===
      JSON.stringify([{ local: "User", imported: "User", source: "Models.kt", kind: "named", isTypeOnly: false }]),
    `Kotlin relative sourceRoot binding was not returned: ${JSON.stringify(relativeSourceRootManifest.importBindings)}`
  );

  const sourceRootAnalysis = await analyzePieceFile({
    filePath: sourceRootRenderPath,
    source: crossFileSource,
    sourceRoots: [sourceRoot],
    semanticSymbols: true
  });
  assert(
    sourceRootAnalysis.graph.edges.some(
      (edge) => edge.kind === "external" && edge.to === `${sourceRootModelPath}#User` && edge.symbols.includes("User")
    ),
    `Kotlin sourceRoot binding did not become a default Node external graph edge: ${JSON.stringify(sourceRootAnalysis.graph.edges)}`
  );
} finally {
  await rm(sourceRoot, { recursive: true, force: true });
}

console.log("Kotlin PSI analysis smoke passed");
