import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
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
  const sourceDir = join(workspace, "java-src", "demo", "external");
  const classesDir = join(workspace, "java-classes");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(classesDir, { recursive: true });
  const sourceFile = join(sourceDir, "ExternalUser.java");
  await writeFile(
    sourceFile,
    `package demo.external;

public class ExternalUser {
  private final String name;

  public ExternalUser(String name) {
    this.name = name;
  }

  public String getName() {
    return name;
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

async function createKmpFixture(projectRoot) {
  const externalJar = await createExternalUserJar(projectRoot);
  const libsDir = join(projectRoot, "libs");
  await mkdir(libsDir, { recursive: true });
  const projectJar = join(libsDir, "external-user.jar");
  await copyFile(externalJar, projectJar);

  await writeFile(
    join(projectRoot, "settings.gradle.kts"),
    `pluginManagement {
  repositories {
    gradlePluginPortal()
    mavenCentral()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    mavenCentral()
  }
}

rootProject.name = "piece-gradle-model-fixture"
`,
    "utf8"
  );
  await writeFile(
    join(projectRoot, "build.gradle.kts"),
    `plugins {
  kotlin("multiplatform") version "2.2.21"
}

kotlin {
  jvm()

  sourceSets {
    val unusedMain by creating

    val jvmMain by getting {
      dependencies {
        implementation(files("libs/external-user.jar"))
      }
    }
  }
}
`,
    "utf8"
  );

  const modelDir = join(projectRoot, "src", "commonMain", "kotlin", "demo", "model");
  const appDir = join(projectRoot, "src", "jvmMain", "kotlin", "demo", "app");
  const unusedDir = join(projectRoot, "src", "unusedMain", "kotlin", "demo", "unused");
  await mkdir(modelDir, { recursive: true });
  await mkdir(appDir, { recursive: true });
  await mkdir(unusedDir, { recursive: true });
  const modelPath = join(modelDir, "User.kt");
  const renderPath = join(appDir, "Render.kt");
  const unusedPath = join(unusedDir, "Unused.kt");
  await writeFile(
    modelPath,
    `package demo.model

data class User(val name: String)
`,
    "utf8"
  );
  await writeFile(
    renderPath,
    `package demo.app

import demo.external.ExternalUser
import demo.model.User

fun render(user: User, external: ExternalUser): String = user.name + ":" + external.name
`,
    "utf8"
  );
  await writeFile(
    unusedPath,
    `package demo.unused

class UnusedModel
`,
    "utf8"
  );

  return { projectJar, modelPath, renderPath };
}

const workspace = await realpath(await mkdtemp(join(tmpdir(), "piece-kotlin-gradle-project-model-")));

try {
  const { projectJar, modelPath, renderPath } = await createKmpFixture(workspace);
  const source = await readFile(renderPath, "utf8");
  const manifest = await analyzeKotlinPieceFile({
    filePath: renderPath,
    source,
    projectRoot: workspace,
    backend: "analysis-api",
    analysisApiEnabled: true
  });

  assert(manifest.projectModel?.status === "success", `Gradle project model discovery did not succeed: ${JSON.stringify(manifest.projectModel)}`);
  assert(
    manifest.projectModel.sourceRoots.some((root) => root.endsWith("/src/commonMain/kotlin")) &&
      manifest.projectModel.sourceRoots.some((root) => root.endsWith("/src/jvmMain/kotlin")),
    `Gradle project model did not discover KMP source roots: ${JSON.stringify(manifest.projectModel.sourceRoots)}`
  );
  assert(
    manifest.projectModel.classpath.includes(projectJar),
    `Gradle project model did not discover the jvmMain jar dependency: ${JSON.stringify(manifest.projectModel.classpath)}`
  );
  assert(
    manifest.projectModel.hashes?.modelHash &&
      manifest.projectModel.hashes?.sourceRootsHash &&
      manifest.projectModel.hashes?.classpathHash,
    `Gradle project model did not include stable hashes: ${JSON.stringify(manifest.projectModel)}`
  );
  assert(
    manifest.projectModel.sourceSets.some((sourceSet) => sourceSet.name === "unusedMain"),
    `Full Gradle project model did not retain the unused source set: ${JSON.stringify(manifest.projectModel.sourceSets)}`
  );
  assert(
    manifest.projectModel.analysisScope?.status === "selected" &&
      manifest.projectModel.analysisScope?.sourceSet === "jvmMain" &&
      JSON.stringify(manifest.projectModel.analysisScope?.requiredSourceSets) === JSON.stringify(["commonMain", "jvmMain"]),
    `Gradle project model did not select the jvmMain analysis scope: ${JSON.stringify(manifest.projectModel.analysisScope)}`
  );
  assert(
    manifest.projectModel.analysisScope.sourceRoots.some((root) => root.endsWith("/src/commonMain/kotlin")) &&
      manifest.projectModel.analysisScope.sourceRoots.some((root) => root.endsWith("/src/jvmMain/kotlin")) &&
      !manifest.projectModel.analysisScope.sourceRoots.some((root) => root.endsWith("/src/unusedMain/kotlin")),
    `Gradle project model analysis scope did not narrow source roots: ${JSON.stringify(manifest.projectModel.analysisScope.sourceRoots)}`
  );
  assert(
    manifest.projectModel.analysisScope.classpath.includes(projectJar),
    `Gradle project model analysis scope did not retain the jvmMain classpath: ${JSON.stringify(manifest.projectModel.analysisScope.classpath)}`
  );
  assert(
    manifest.projectModel.analysisScope.hashes?.scopeHash,
    `Gradle project model analysis scope did not include stable hashes: ${JSON.stringify(manifest.projectModel.analysisScope)}`
  );
  assert(
    manifest.importBindings.some((binding) => binding.local === "User" && binding.imported === "User" && binding.source === modelPath),
    `Gradle-discovered source root did not bind the commonMain companion source: ${JSON.stringify(manifest.importBindings)}`
  );
  assert(
    manifest.importBindings.some(
      (binding) =>
        binding.local === "ExternalUser" &&
        binding.imported === "ExternalUser" &&
        binding.source === `classpath:${projectJar}!demo/external`
    ),
    `Gradle-discovered classpath did not bind the external jar class: ${JSON.stringify(manifest.importBindings)}`
  );

  const analysis = await analyzePieceFile({
    filePath: renderPath,
    source,
    declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
      projectRoot: workspace,
      backend: "analysis-api",
      analysisApiEnabled: true
    })
  });
  assert(
    analysis.graph.edges.some((edge) => edge.kind === "external" && edge.to === `${modelPath}#User` && edge.symbols.includes("User")),
    `Gradle-discovered source root binding did not become an external graph edge: ${JSON.stringify(analysis.graph.edges)}`
  );
  assert(
    analysis.graph.edges.some(
      (edge) =>
        edge.kind === "external" &&
        edge.to === `classpath:${projectJar}!demo/external#ExternalUser` &&
        edge.symbols.includes("ExternalUser")
    ),
    `Gradle-discovered classpath binding did not become an external graph edge: ${JSON.stringify(analysis.graph.edges)}`
  );
  assert(
    analysis.snapshot.projectModelHash === analysis.manifest.projectModel.analysisScope.hashes.scopeHash,
    `Snapshot did not include the Gradle project model hash: ${JSON.stringify(analysis.snapshot)}`
  );
  assert(
    analysis.piecePackage.actions.every((action) => action.inputs.includes(`project-model:${analysis.manifest.projectModel.analysisScope.hashes.scopeHash}`)),
    `Piece actions did not include the Gradle project model hash input: ${JSON.stringify(analysis.piecePackage.actions)}`
  );
  assert(
    Object.values(analysis.snapshot.artifacts).every((artifact) => artifact.cacheKey),
    `Snapshot artifacts did not include cache keys: ${JSON.stringify(analysis.snapshot.artifacts)}`
  );

  const compileResult = await compileKotlinPieceFile({
    filePath: renderPath,
    source,
    projectRoot: workspace,
    target: "jvm",
    pieceTarget: "render"
  });
  assert(compileResult.status === "success", `Gradle project compile failed: ${JSON.stringify(compileResult.diagnostics)}`);
  assert(compileResult.projectRoot === workspace, `Gradle project compile did not report projectRoot: ${JSON.stringify(compileResult)}`);
  assert(compileResult.sourceSet === "jvmMain", `Gradle project compile did not infer jvmMain: ${JSON.stringify(compileResult)}`);
  assert(
    compileResult.commands.some(
      (command) => command.command === "gradle-tooling-api" && command.args.includes("compileKotlinJvm")
    ),
    `Gradle project compile did not run the jvmMain compile task through Tooling API: ${JSON.stringify(compileResult.commands)}`
  );
  assert(
    compileResult.outputFiles.some((file) => file.path.endsWith("RenderKt.class")),
    `Gradle project compile did not report compiled class output: ${JSON.stringify(compileResult.outputFiles)}`
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
