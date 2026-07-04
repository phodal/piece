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

class ExternalUser(val name: String) {
  val displayName: String = "[$name]"
}

fun formatName(name: String): String = "External: $name"
fun String.decorate(): String = "[$this]"
fun parse(value: String): String = value
fun parse(value: Int): String = value.toString()
fun <T> box(value: T): T = value
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
  crossFileManifest.importBindings.some(
    (binding) => binding.local === "User" && binding.imported === "User" && binding.source === "/repo/src/Models.kt"
  ),
  `Kotlin Analysis API companion source-set class binding was not returned: ${JSON.stringify(crossFileManifest.importBindings)}`
);
assert(
  crossFileManifest.importBindings.some(
    (binding) => binding.local === "name" && binding.imported === "name" && binding.source === "/repo/src/Models.kt/User"
  ),
  `Kotlin Analysis API companion source-set member property binding was not returned: ${JSON.stringify(crossFileManifest.importBindings)}`
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

  const extensionFunctionSource = `package demo.externaluse

import demo.external.decorate

fun render(name: String): String = name.decorate()
`;
  const extensionFunctionManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/UseFormatterExtension.kt",
    source: extensionFunctionSource,
    backend: "analysis-api",
    analysisApiEnabled: true,
    classpath: [formatterJar]
  });
  assert(
    extensionFunctionManifest.analysisBackend?.actual === "analysis-api" &&
      extensionFunctionManifest.analysisBackend?.symbols === "analysis-api",
    `Kotlin Analysis API extension function backend was not used: ${JSON.stringify(extensionFunctionManifest.analysisBackend)}`
  );
  const extensionFunctionBinding = extensionFunctionManifest.importBindings.find(
    (binding) =>
      binding.local === "decorate" &&
      binding.imported === "decorate" &&
      binding.source === `classpath:${formatterJar}!demo/external`
  );
  assert(
    extensionFunctionBinding,
    `Kotlin Analysis API did not map the extension function to its jar-backed classpath binding: ${JSON.stringify(extensionFunctionManifest.importBindings)}`
  );

  const extensionFunctionAnalysis = await analyzePieceFile({
    filePath: "/repo/src/UseFormatterExtension.kt",
    source: extensionFunctionSource,
    declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
      backend: "analysis-api",
      analysisApiEnabled: true,
      classpath: [formatterJar]
    })
  });
  assert(
    extensionFunctionAnalysis.graph.edges.some(
      (edge) =>
        edge.kind === "external" &&
        edge.to === `classpath:${formatterJar}!demo/external#decorate` &&
        edge.symbols.includes("decorate")
    ),
    `Kotlin Analysis API extension function binding did not become a jar-backed external graph edge: ${JSON.stringify(extensionFunctionAnalysis.graph.edges)}`
  );

  const constructorSource = `package demo.externaluse

import demo.external.ExternalUser

fun render(name: String): String = ExternalUser(name).name
`;
  const constructorManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/ConstructExternal.kt",
    source: constructorSource,
    backend: "analysis-api",
    analysisApiEnabled: true,
    classpath: [formatterJar]
  });
  assert(
    constructorManifest.importBindings.some(
      (binding) =>
        binding.local === "ExternalUser" &&
        binding.imported === "ExternalUser" &&
        binding.source === `classpath:${formatterJar}!demo/external`
    ),
    `Kotlin Analysis API did not map the constructor call to its jar-backed class binding: ${JSON.stringify(constructorManifest.importBindings)}`
  );
  assert(
    constructorManifest.importBindings.some(
      (binding) =>
        binding.local === "name" &&
        binding.imported === "name" &&
        binding.source === `classpath:${formatterJar}!demo/external/ExternalUser`
    ),
    `Kotlin Analysis API did not map the constructor result member property to its owner-qualified binding: ${JSON.stringify(constructorManifest.importBindings)}`
  );

  const constructorAnalysis = await analyzePieceFile({
    filePath: "/repo/src/ConstructExternal.kt",
    source: constructorSource,
    declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
      backend: "analysis-api",
      analysisApiEnabled: true,
      classpath: [formatterJar]
    })
  });
  assert(
    constructorAnalysis.graph.edges.some(
      (edge) =>
        edge.kind === "external" &&
        edge.to === `classpath:${formatterJar}!demo/external#ExternalUser` &&
        edge.symbols.includes("ExternalUser")
    ),
    `Kotlin Analysis API constructor call did not become a jar-backed class graph edge: ${JSON.stringify(constructorAnalysis.graph.edges)}`
  );
  assert(
    constructorAnalysis.graph.edges.some(
      (edge) =>
        edge.kind === "external" &&
        edge.to === `classpath:${formatterJar}!demo/external/ExternalUser#name` &&
        edge.symbols.includes("name")
    ),
    `Kotlin Analysis API constructor result member property did not become an owner-qualified graph edge: ${JSON.stringify(constructorAnalysis.graph.edges)}`
  );

  const memberPropertySource = `package demo.externaluse

import demo.external.ExternalUser

fun render(user: ExternalUser): String = user.displayName
`;
  const memberPropertyManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/UseExternalMember.kt",
    source: memberPropertySource,
    backend: "analysis-api",
    analysisApiEnabled: true,
    classpath: [formatterJar]
  });
  assert(
    memberPropertyManifest.importBindings.some(
      (binding) =>
        binding.local === "displayName" &&
        binding.imported === "displayName" &&
        binding.source === `classpath:${formatterJar}!demo/external/ExternalUser`
    ),
    `Kotlin Analysis API did not map the member property to its owner-qualified classpath binding: ${JSON.stringify(memberPropertyManifest.importBindings)}`
  );

  const memberPropertyAnalysis = await analyzePieceFile({
    filePath: "/repo/src/UseExternalMember.kt",
    source: memberPropertySource,
    declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
      backend: "analysis-api",
      analysisApiEnabled: true,
      classpath: [formatterJar]
    })
  });
  assert(
    memberPropertyAnalysis.graph.edges.some(
      (edge) =>
        edge.kind === "external" &&
        edge.to === `classpath:${formatterJar}!demo/external/ExternalUser#displayName` &&
        edge.symbols.includes("displayName")
    ),
    `Kotlin Analysis API member property binding did not become an owner-qualified external graph edge: ${JSON.stringify(memberPropertyAnalysis.graph.edges)}`
  );

  const stringOverloadSource = `package demo.externaluse

import demo.external.parse

fun render(): String = parse("x")
`;
  const stringOverloadManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/UseStringOverload.kt",
    source: stringOverloadSource,
    backend: "analysis-api",
    analysisApiEnabled: true,
    classpath: [formatterJar]
  });
  assert(
    stringOverloadManifest.importBindings.some(
      (binding) =>
        binding.local === "parse" &&
        binding.imported === "parse" &&
        binding.source === `classpath:${formatterJar}!demo/external` &&
        binding.signature === "(String)"
    ),
    `Kotlin Analysis API did not retain the selected String overload signature: ${JSON.stringify(stringOverloadManifest.importBindings)}`
  );

  const intOverloadSource = `package demo.externaluse

import demo.external.parse

fun render(): String = parse(1)
`;
  const intOverloadManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/UseIntOverload.kt",
    source: intOverloadSource,
    backend: "analysis-api",
    analysisApiEnabled: true,
    classpath: [formatterJar]
  });
  assert(
    intOverloadManifest.importBindings.some(
      (binding) =>
        binding.local === "parse" &&
        binding.imported === "parse" &&
        binding.source === `classpath:${formatterJar}!demo/external` &&
        binding.signature === "(Int)"
    ),
    `Kotlin Analysis API did not retain the selected Int overload signature: ${JSON.stringify(intOverloadManifest.importBindings)}`
  );

  const multiOverloadSource = `package demo.externaluse

import demo.external.parse

fun render(): String = parse("x") + parse(1)
`;
  const multiOverloadManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/UseMultiOverload.kt",
    source: multiOverloadSource,
    backend: "analysis-api",
    analysisApiEnabled: true,
    classpath: [formatterJar]
  });
  const multiOverloadRender = multiOverloadManifest.slices.find((slice) => slice.name === "render");
  assert(
    multiOverloadRender?.importBindings?.some((binding) => binding.local === "parse" && binding.signature === "(String)") &&
      multiOverloadRender?.importBindings?.some((binding) => binding.local === "parse" && binding.signature === "(Int)"),
    `Kotlin Analysis API did not retain declaration-local overload bindings: ${JSON.stringify(multiOverloadRender)}`
  );

  const multiOverloadAnalysis = await analyzePieceFile({
    filePath: "/repo/src/UseMultiOverload.kt",
    source: multiOverloadSource,
    declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
      backend: "analysis-api",
      analysisApiEnabled: true,
      classpath: [formatterJar]
    })
  });
  const multiOverloadEdges = multiOverloadAnalysis.graph.edges.filter(
    (edge) =>
      edge.kind === "external" &&
      edge.to === `classpath:${formatterJar}!demo/external#parse` &&
      edge.symbols.includes("parse")
  );
  assert(
    multiOverloadEdges.some((edge) => edge.import?.signature === "(String)") &&
      multiOverloadEdges.some((edge) => edge.import?.signature === "(Int)"),
    `Kotlin Analysis API graph did not retain both overload edges: ${JSON.stringify(multiOverloadAnalysis.graph.edges)}`
  );
  const multiOverloadTarget = multiOverloadAnalysis.piecePackage.targets.find((target) => target.name === "render");
  assert(
    multiOverloadTarget?.externalDeps.includes(`classpath:${formatterJar}!demo/external#parse(String)`) &&
      multiOverloadTarget?.externalDeps.includes(`classpath:${formatterJar}!demo/external#parse(Int)`),
    `Kotlin Analysis API package did not retain signature-qualified overload deps: ${JSON.stringify(multiOverloadAnalysis.piecePackage.targets)}`
  );

  const genericFunctionSource = `package demo.externaluse

import demo.external.box

fun render(): String = box("x")
`;
  const genericFunctionManifest = await analyzeKotlinPieceFile({
    filePath: "/repo/src/UseGenericFunction.kt",
    source: genericFunctionSource,
    backend: "analysis-api",
    analysisApiEnabled: true,
    classpath: [formatterJar]
  });
  assert(
    genericFunctionManifest.importBindings.some(
      (binding) =>
        binding.local === "box" &&
        binding.imported === "box" &&
        binding.source === `classpath:${formatterJar}!demo/external` &&
        binding.signature === "(T)"
    ),
    `Kotlin Analysis API did not retain the generic callable signature: ${JSON.stringify(genericFunctionManifest.importBindings)}`
  );
} finally {
  await rm(classpathWorkspace, { recursive: true, force: true });
}

console.log("Kotlin Analysis API smoke passed");
