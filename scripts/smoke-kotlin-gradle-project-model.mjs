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
  const moduleCoordinates = "demo.external:external-user:1.0.0";
  const moduleDir = join(projectRoot, "repo", "demo", "external", "external-user", "1.0.0");
  await mkdir(moduleDir, { recursive: true });
  const projectJar = join(moduleDir, "external-user-1.0.0.jar");
  await copyFile(externalJar, projectJar);
  await writeFile(
    join(moduleDir, "external-user-1.0.0.pom"),
    `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>demo.external</groupId>
  <artifactId>external-user</artifactId>
  <version>1.0.0</version>
</project>
`,
    "utf8"
  );

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
    maven {
      url = uri("repo")
    }
    mavenCentral()
  }
}

rootProject.name = "piece-gradle-model-fixture"
include("app", "domain", "unused")
`,
    "utf8"
  );
  await writeFile(
    join(projectRoot, "build.gradle.kts"),
    `plugins {
  kotlin("multiplatform") version "2.2.21" apply false
}
`,
    "utf8"
  );
  await mkdir(join(projectRoot, "app"), { recursive: true });
  await mkdir(join(projectRoot, "domain"), { recursive: true });
  await mkdir(join(projectRoot, "unused"), { recursive: true });
  await writeFile(
    join(projectRoot, "app", "build.gradle.kts"),
    `plugins {
  kotlin("multiplatform")
}

kotlin {
  jvm()

  sourceSets {
    val jvmMain by getting {
      dependencies {
        implementation(project(":domain"))
        implementation("demo.external:external-user:1.0.0")
      }
    }
  }
}
`,
    "utf8"
  );
  await writeFile(
    join(projectRoot, "domain", "build.gradle.kts"),
    `plugins {
  kotlin("multiplatform")
}

kotlin {
  jvm()
}
`,
    "utf8"
  );
  await writeFile(
    join(projectRoot, "unused", "build.gradle.kts"),
    `plugins {
  kotlin("multiplatform")
}

kotlin {
  jvm()
}
`,
    "utf8"
  );

  const modelDir = join(projectRoot, "domain", "src", "commonMain", "kotlin", "demo", "model");
  const appDir = join(projectRoot, "app", "src", "jvmMain", "kotlin", "demo", "app");
  const unusedDir = join(projectRoot, "unused", "src", "jvmMain", "kotlin", "demo", "unused");
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

  return { moduleCoordinates, projectJar, modelPath, renderPath };
}

const workspace = await realpath(await mkdtemp(join(tmpdir(), "piece-kotlin-gradle-project-model-")));

try {
  const { moduleCoordinates, modelPath, renderPath } = await createKmpFixture(workspace);
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
    manifest.projectModel.sourceRoots.some((root) => root.endsWith("/domain/src/commonMain/kotlin")) &&
      manifest.projectModel.sourceRoots.some((root) => root.endsWith("/app/src/jvmMain/kotlin")) &&
      manifest.projectModel.sourceRoots.some((root) => root.endsWith("/unused/src/jvmMain/kotlin")),
    `Gradle project model did not discover KMP source roots: ${JSON.stringify(manifest.projectModel.sourceRoots)}`
  );
  const projectJar = manifest.projectModel.classpath.find((file) => file.endsWith("external-user-1.0.0.jar"));
  assert(projectJar, `Gradle project model did not discover the jvmMain jar dependency: ${JSON.stringify(manifest.projectModel.classpath)}`);
  assert(
    manifest.projectModel.dependencies.some(
      (dependency) =>
        dependency.configuration === "jvmCompileClasspath" &&
        dependency.coordinates === moduleCoordinates
    ),
    `Gradle project model did not expose dependency coordinates: ${JSON.stringify(manifest.projectModel.dependencies)}`
  );
  assert(
    manifest.projectModel.projectDependencies.some(
      (dependency) =>
        dependency.projectPath === ":app" &&
        dependency.configuration === "jvmCompileClasspath" &&
        dependency.dependencyProjectPath === ":domain" &&
        dependency.dependencyProjectDir.endsWith("/domain")
    ),
    `Gradle project model did not expose project dependencies: ${JSON.stringify({
      projectDependencies: manifest.projectModel.projectDependencies,
      diagnostics: manifest.diagnostics
    })}`
  );
  assert(
    manifest.projectModel.targetVariants.some(
      (variant) =>
        variant.projectPath === ":app" &&
        variant.sourceSet === "jvmMain" &&
        variant.targetName === "jvm" &&
        variant.compileTask === "compileKotlinJvm" &&
        variant.classpathConfiguration === "jvmCompileClasspath"
    ),
    `Gradle project model did not expose the jvmMain target variant: ${JSON.stringify(manifest.projectModel.targetVariants)}`
  );
  assert(
    manifest.projectModel.hashes?.modelHash &&
      manifest.projectModel.hashes?.sourceRootsHash &&
      manifest.projectModel.hashes?.classpathHash,
    `Gradle project model did not include stable hashes: ${JSON.stringify(manifest.projectModel)}`
  );
  assert(
    manifest.projectModel.sourceSets.some((sourceSet) => sourceSet.projectPath === ":unused" && sourceSet.name === "jvmMain"),
    `Full Gradle project model did not retain the unused project source set: ${JSON.stringify(manifest.projectModel.sourceSets)}`
  );
  assert(
    manifest.projectModel.analysisScope?.status === "selected" &&
      manifest.projectModel.analysisScope?.projectPath === ":app" &&
      JSON.stringify(manifest.projectModel.analysisScope?.projectPaths) === JSON.stringify([":app", ":domain"]) &&
      manifest.projectModel.analysisScope?.sourceSet === "jvmMain" &&
      JSON.stringify(manifest.projectModel.analysisScope?.requiredSourceSets) === JSON.stringify(["commonMain", "jvmMain"]),
    `Gradle project model did not select the jvmMain analysis scope: ${JSON.stringify(manifest.projectModel.analysisScope)}`
  );
  assert(
    manifest.projectModel.analysisScope.sourceRoots.some((root) => root.endsWith("/domain/src/commonMain/kotlin")) &&
      manifest.projectModel.analysisScope.sourceRoots.some((root) => root.endsWith("/app/src/jvmMain/kotlin")) &&
      !manifest.projectModel.analysisScope.sourceRoots.some((root) => root.endsWith("/unused/src/jvmMain/kotlin")),
    `Gradle project model analysis scope did not narrow source roots: ${JSON.stringify(manifest.projectModel.analysisScope.sourceRoots)}`
  );
  assert(
    manifest.projectModel.analysisScope.classpath.includes(projectJar),
    `Gradle project model analysis scope did not retain the jvmMain classpath: ${JSON.stringify(manifest.projectModel.analysisScope.classpath)}`
  );
  assert(
    manifest.projectModel.analysisScope.dependencyCoordinates.includes(moduleCoordinates),
    `Gradle project model analysis scope did not retain dependency coordinates: ${JSON.stringify(manifest.projectModel.analysisScope.dependencyCoordinates)}`
  );
  assert(
    manifest.projectModel.analysisScope.projectDependencies.some(
      (dependency) => dependency.projectPath === ":app" && dependency.dependencyProjectPath === ":domain"
    ),
    `Gradle project model analysis scope did not retain project dependencies: ${JSON.stringify(manifest.projectModel.analysisScope.projectDependencies)}`
  );
  assert(
    manifest.projectModel.analysisScope.targetVariants.some((variant) => variant.projectPath === ":app" && variant.compileTask === "compileKotlinJvm") &&
      manifest.projectModel.analysisScope.targetVariants.some((variant) => variant.projectPath === ":domain" && variant.compileTask === "compileKotlinJvm"),
    `Gradle project model analysis scope did not retain target variants: ${JSON.stringify(manifest.projectModel.analysisScope.targetVariants)}`
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
