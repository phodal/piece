import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { analyzeKotlinPieceFile, analyzePieceFile, createNodeKotlinPsiDeclarationExtractor } from "../src/node.js";

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
  await mkdir(modelDir, { recursive: true });
  await mkdir(appDir, { recursive: true });
  const modelPath = join(modelDir, "User.kt");
  const renderPath = join(appDir, "Render.kt");
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
} finally {
  await rm(workspace, { recursive: true, force: true });
}
