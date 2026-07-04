import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { analyzeKotlinPieceFile, analyzePieceFile, compileKotlinPieceFile, createNodeKotlinPsiDeclarationExtractor } from "../src/node.js";

const execFileAsync = promisify(execFile);

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

async function createExternalFormatterJar(workspace) {
  const result = await compileKotlinPieceFile({
    filePath: "/repo/lib/Formatters.kt",
    source: `package demo.external

fun formatName(name: String): String = "External: $name"
`,
    target: "jvm",
    workspace
  });
  if (result.status !== "success") {
    throw new Error(`Kotlin formatter fixture compile failed: ${JSON.stringify(result.diagnostics)}`);
  }
  const jarPath = result.outputFiles.find((file) => file.path.endsWith(".jar") && !file.path.endsWith("-sources.jar"))?.path;
  if (!jarPath) {
    throw new Error(`Kotlin formatter fixture did not produce a jar: ${JSON.stringify(result.outputFiles)}`);
  }
  return jarPath;
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

const classpathWorkspace = await mkdtemp(join(tmpdir(), "piece-kotlin-analysis-api-classpath-"));
try {
  const externalJar = await createExternalUserJar(classpathWorkspace);
  const externalClasspathSource = `package demo.externaluse

import demo.external.ExternalUser

fun render(user: ExternalUser): String = user.name
`;
  const classpathManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/ExternalRender.kt",
    source: externalClasspathSource,
    backend: "analysis-api",
    analysisApiEnabled: true,
    classpath: [externalJar]
  });
  assert(
    classpathManifest.analysisBackend?.actual === "analysis-api" &&
      classpathManifest.analysisBackend?.symbols === "analysis-api",
    `Kotlin Analysis API classpath backend was not used: ${JSON.stringify(classpathManifest.analysisBackend)}`
  );
  const classpathBinding = classpathManifest.importBindings.find(
    (binding) =>
      binding.local === "ExternalUser" &&
      binding.imported === "ExternalUser" &&
      binding.source === `classpath:${externalJar}!demo/external`
  );
  assert(
    classpathBinding,
    `Kotlin Analysis API did not map the external class to its jar-backed classpath binding: ${JSON.stringify(classpathManifest.importBindings)}`
  );
  assert(
    !classpathManifest.importBindings.some((binding) => binding.local === "String" || binding.imported === "String"),
    `Kotlin Analysis API should not surface implicit Kotlin runtime types as classpath bindings: ${JSON.stringify(classpathManifest.importBindings)}`
  );

  const classpathAnalysis = await analyzePieceFile({
    filePath: "/repo/src/ExternalRender.kt",
    source: externalClasspathSource,
    declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
      backend: "analysis-api",
      analysisApiEnabled: true,
      classpath: [externalJar]
    })
  });
  assert(
    classpathAnalysis.graph.edges.some(
      (edge) =>
        edge.kind === "external" &&
        edge.to === `classpath:${externalJar}!demo/external#ExternalUser` &&
        edge.symbols.includes("ExternalUser")
    ),
    `Kotlin Analysis API classpath binding did not become a jar-backed external graph edge: ${JSON.stringify(classpathAnalysis.graph.edges)}`
  );

  const formatterJar = await createExternalFormatterJar(join(classpathWorkspace, "formatter-lib"));
  const topLevelFunctionSource = `package demo.externaluse

import demo.external.formatName

fun render(name: String): String = formatName(name)
`;
  const topLevelFunctionManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/UseFormatter.kt",
    source: topLevelFunctionSource,
    backend: "analysis-api",
    analysisApiEnabled: true,
    classpath: [formatterJar]
  });
  assert(
    topLevelFunctionManifest.analysisBackend?.actual === "analysis-api" &&
      topLevelFunctionManifest.analysisBackend?.symbols === "analysis-api",
    `Kotlin Analysis API top-level function backend was not used: ${JSON.stringify(topLevelFunctionManifest.analysisBackend)}`
  );
  const topLevelFunctionBinding = topLevelFunctionManifest.importBindings.find(
    (binding) =>
      binding.local === "formatName" &&
      binding.imported === "formatName" &&
      binding.source === `classpath:${formatterJar}!demo/external`
  );
  assert(
    topLevelFunctionBinding,
    `Kotlin Analysis API did not map the top-level function to its jar-backed classpath binding: ${JSON.stringify(topLevelFunctionManifest.importBindings)}`
  );

  const topLevelFunctionAnalysis = await analyzePieceFile({
    filePath: "/repo/src/UseFormatter.kt",
    source: topLevelFunctionSource,
    declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
      backend: "analysis-api",
      analysisApiEnabled: true,
      classpath: [formatterJar]
    })
  });
  assert(
    topLevelFunctionAnalysis.graph.edges.some(
      (edge) =>
        edge.kind === "external" &&
        edge.to === `classpath:${formatterJar}!demo/external#formatName` &&
        edge.symbols.includes("formatName")
    ),
    `Kotlin Analysis API top-level function binding did not become a jar-backed external graph edge: ${JSON.stringify(topLevelFunctionAnalysis.graph.edges)}`
  );
} finally {
  await rm(classpathWorkspace, { recursive: true, force: true });
}

console.log("Kotlin Analysis API smoke passed");
