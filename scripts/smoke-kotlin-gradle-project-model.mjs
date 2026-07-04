import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  analyzeKotlinPieceFile,
  analyzePieceFile,
  compileKotlinPieceFile,
  compilePieceApp,
  createNodeKotlinPsiDeclarationExtractor,
  piecePackageToPicDsl
} from "../src/node.js";

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
    val orphanMain by creating

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
  const orphanDir = join(projectRoot, "app", "src", "orphanMain", "kotlin", "demo", "orphan");
  const unusedDir = join(projectRoot, "unused", "src", "jvmMain", "kotlin", "demo", "unused");
  await mkdir(modelDir, { recursive: true });
  await mkdir(appDir, { recursive: true });
  await mkdir(orphanDir, { recursive: true });
  await mkdir(unusedDir, { recursive: true });
  const modelPath = join(modelDir, "User.kt");
  const renderPath = join(appDir, "Render.kt");
  const orphanPath = join(orphanDir, "Orphan.kt");
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
  await writeFile(
    orphanPath,
    `package demo.orphan

fun orphan(): String = "orphan"
`,
    "utf8"
  );

  return { moduleCoordinates, projectJar, modelPath, orphanPath, renderPath };
}

const workspace = await realpath(await mkdtemp(join(tmpdir(), "piece-kotlin-gradle-project-model-")));

try {
  const { moduleCoordinates, modelPath, orphanPath, renderPath } = await createKmpFixture(workspace);
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
      manifest.projectModel.sourceRoots.some((root) => root.endsWith("/app/src/orphanMain/kotlin")) &&
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
    manifest.projectModel.analysisScope.diagnostics.length === 0,
    `Gradle project model emitted unexpected selected-scope diagnostics: ${JSON.stringify(manifest.projectModel.analysisScope.diagnostics)}`
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

  const detachedDir = join(workspace, "scratch");
  await mkdir(detachedDir, { recursive: true });
  const detachedPath = join(detachedDir, "Detached.kt");
  const detachedSource = `package demo.detached

fun detached(): String = "detached"
`;
  await writeFile(detachedPath, detachedSource, "utf8");
  const detachedManifest = await analyzeKotlinPieceFile({
    filePath: detachedPath,
    source: detachedSource,
    projectRoot: workspace,
    backend: "analysis-api",
    analysisApiEnabled: true
  });
  assert(
    detachedManifest.projectModel?.status === "success" &&
      detachedManifest.projectModel.analysisScope?.status === "fallback" &&
      detachedManifest.projectModel.analysisScope?.fallbackReason?.includes("source set"),
    `Gradle project model did not explain unmatched source-set fallback: ${JSON.stringify(detachedManifest.projectModel)}`
  );
  assert(
    detachedManifest.projectModel.analysisScope.sourceRoots.length === 0 &&
      detachedManifest.projectModel.analysisScope.classpath.length === 0,
    `Gradle project model fallback reused unsafe full-project inputs: ${JSON.stringify(detachedManifest.projectModel.analysisScope)}`
  );
  assert(
    detachedManifest.projectModel.analysisScope.diagnostics.some(
      (diagnostic) => diagnostic.code === "kotlin-project-model-source-set-unmatched"
    ) &&
      detachedManifest.diagnostics.some((diagnostic) => diagnostic.code === "kotlin-project-model-source-set-unmatched"),
    `Gradle project model fallback diagnostics were not exposed on the scope and manifest: ${JSON.stringify({
      scope: detachedManifest.projectModel.analysisScope.diagnostics,
      manifest: detachedManifest.diagnostics
    })}`
  );

  const orphanSource = await readFile(orphanPath, "utf8");
  const orphanManifest = await analyzeKotlinPieceFile({
    filePath: orphanPath,
    source: orphanSource,
    projectRoot: workspace,
    backend: "analysis-api",
    analysisApiEnabled: true
  });
  assert(
    orphanManifest.projectModel?.status === "success" &&
      orphanManifest.projectModel.analysisScope?.status === "fallback" &&
      orphanManifest.projectModel.analysisScope?.sourceSet === "orphanMain",
    `Gradle project model did not keep orphanMain as a fallback scope: ${JSON.stringify(orphanManifest.projectModel)}`
  );
  assert(
    orphanManifest.projectModel.analysisScope.sourceRoots.some((root) => root.endsWith("/app/src/orphanMain/kotlin")) &&
      orphanManifest.projectModel.analysisScope.classpath.length === 0,
    `Gradle project model orphan fallback did not retain only safe source roots: ${JSON.stringify(orphanManifest.projectModel.analysisScope)}`
  );
  assert(
    orphanManifest.projectModel.analysisScope.diagnostics.some(
      (diagnostic) => diagnostic.code === "kotlin-project-model-classpath-unmatched"
    ) &&
      orphanManifest.diagnostics.some((diagnostic) => diagnostic.code === "kotlin-project-model-classpath-unmatched"),
    `Gradle project model orphan fallback diagnostics were not exposed on the scope and manifest: ${JSON.stringify({
      scope: orphanManifest.projectModel.analysisScope.diagnostics,
      manifest: orphanManifest.diagnostics
    })}`
  );

  const manifestExtractor = (name, fixedManifest) => ({
    name,
    extract() {
      return fixedManifest;
    }
  });
  const detachedAnalysis = await analyzePieceFile({
    filePath: detachedPath,
    source: detachedSource,
    declarationExtractor: manifestExtractor("detached-gradle-fallback-manifest", detachedManifest)
  });
  const detachedAppStatus = await compilePieceApp({
    filePath: detachedPath,
    source: detachedSource,
    analysis: detachedAnalysis,
    target: "__no_preview__",
    compileAction: true,
    pieceTarget: "__missing_piece_target__"
  });
  assert(
    detachedAppStatus.compileActionSelection?.sourceSet?.status === "fallback" &&
      detachedAppStatus.compileActionSelection.sourceSet.fallbackReason?.includes("source set") &&
      detachedAppStatus.compileActionSelection.sourceSetScope === undefined,
    `App-level selection did not expose detached Gradle source-set fallback metadata: ${JSON.stringify(detachedAppStatus.compileActionSelection)}`
  );
  const orphanAnalysis = await analyzePieceFile({
    filePath: orphanPath,
    source: orphanSource,
    declarationExtractor: manifestExtractor("orphan-gradle-fallback-manifest", orphanManifest)
  });
  const orphanAppStatus = await compilePieceApp({
    filePath: orphanPath,
    source: orphanSource,
    analysis: orphanAnalysis,
    target: "__no_preview__",
    compileAction: true,
    pieceTarget: "__missing_piece_target__"
  });
  assert(
    orphanAppStatus.compileActionSelection?.sourceSet?.status === "fallback" &&
      orphanAppStatus.compileActionSelection.sourceSet.sourceSet === "orphanMain" &&
      orphanAppStatus.compileActionSelection.sourceSet.fallbackReason?.includes("classpath") &&
      orphanAppStatus.compileActionSelection.sourceSetScope === undefined,
    `App-level selection did not expose orphan Gradle source-set fallback metadata: ${JSON.stringify(orphanAppStatus.compileActionSelection)}`
  );

  const analysis = await analyzePieceFile({
    filePath: renderPath,
    source,
    declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
      projectRoot: workspace,
      backend: "analysis-api",
      analysisApiEnabled: true
    }),
    sourceSetScopeSelection: "safe"
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
    analysis.feedbackScope.level === "source-set" &&
      analysis.feedbackScope.sourceSet?.projectPath === ":app" &&
      analysis.feedbackScope.sourceSet?.sourceSet === "jvmMain" &&
      JSON.stringify(analysis.feedbackScope.sourceSet?.projectPaths) === JSON.stringify([":app", ":domain"]) &&
      analysis.feedbackScope.sourceSet?.sourceRoots.some((root) => root.endsWith("/domain/src/commonMain/kotlin")) &&
      !analysis.feedbackScope.sourceSet?.sourceRoots.some((root) => root.endsWith("/unused/src/jvmMain/kotlin")) &&
      analysis.feedbackScope.sourceSet?.hashes?.scopeHash === analysis.manifest.projectModel.analysisScope.hashes.scopeHash,
    `Feedback scope did not expose the selected Kotlin source-set boundary: ${JSON.stringify(analysis.feedbackScope)}`
  );
  assert(
    analysis.snapshot.feedbackScope.sourceSet?.hashes?.scopeHash === analysis.manifest.projectModel.analysisScope.hashes.scopeHash,
    `Snapshot feedback scope did not retain source-set scope metadata: ${JSON.stringify(analysis.snapshot.feedbackScope)}`
  );
  const promotedUserTarget = analysis.sourceSetScope?.promotedTargets.find(
    (target) => target.sourceFile === modelPath && target.name === "User"
  );
  assert(
    analysis.sourceSetScope?.kind === "source-set-scope-target-model" &&
      analysis.sourceSetScope.status === "selected" &&
      analysis.sourceSetScope.promotion.requested === "safe" &&
      analysis.sourceSetScope.promotion.appliedToPackageView === true &&
      analysis.sourceSetScope.sourceSetScopeHash === analysis.manifest.projectModel.analysisScope.hashes.scopeHash &&
      promotedUserTarget,
    `Source-set scope did not expose a selected companion package view model: ${JSON.stringify(analysis.sourceSetScope)}`
  );
  assert(
    analysis.pieceDslSource === "current-file" && analysis.pieceDsl === piecePackageToPicDsl(analysis.piecePackage),
    `Source-set package view selection should not replace the primary current-file .pic output: ${analysis.pieceDslSource}`
  );
  assert(
    analysis.sourceSetScope.packageView?.targets.some(
      (target) => target.label === promotedUserTarget.label && target.source === promotedUserTarget.source
    ),
    `Source-set package view did not include the promoted User target: ${JSON.stringify(analysis.sourceSetScope.packageView?.targets)}`
  );
  const renderPackageViewTarget = analysis.sourceSetScope.packageView?.targets.find((target) => target.name === "render");
  assert(
    renderPackageViewTarget?.deps.includes(promotedUserTarget.label) &&
      !renderPackageViewTarget.externalDeps.includes(`${modelPath}#User`),
    `Source-set package view did not replace the User external dep with a promoted target dep: ${JSON.stringify(renderPackageViewTarget)}`
  );
  assert(
    !analysis.sourceSetScope.packageView?.targets.some((target) => String(target.sourceFile ?? "").startsWith("classpath:")),
    `Source-set package view should not promote classpath dependencies: ${JSON.stringify(analysis.sourceSetScope.packageView?.targets)}`
  );
  assert(
    analysis.sourceSetScope.packageView?.actions
      .find((action) => action.id === `${promotedUserTarget.label}%compile`)
      ?.inputs.includes(`source-set:${analysis.manifest.projectModel.analysisScope.hashes.scopeHash}`),
    `Promoted source-set compile action did not include source-set scope input: ${JSON.stringify(analysis.sourceSetScope.packageView?.actions)}`
  );
  const sourceSetOverride = `package ${JSON.stringify(analysis.sourceSetScope.packageView.label)} {
  language kotlin
  source ${JSON.stringify(renderPath)}

  target ${promotedUserTarget.kind} "User" {
    source ${JSON.stringify(promotedUserTarget.source)}
    visibility "//visibility:public"
    action compile {
      mnemonic "UserFixture"
      inputs "fixtures/user.json"
      path "artifacts/user.fixture.json"
    }
  }
}
`;
  const sourceSetOverrideAnalysis = await analyzePieceFile({
    filePath: renderPath,
    source,
    declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
      projectRoot: workspace,
      backend: "analysis-api",
      analysisApiEnabled: true
    }),
    sourceSetScopeSelection: "safe",
    overrideFilePath: join(workspace, "Render.source-set.override.pic"),
    overrideSource: sourceSetOverride,
    pieceDslOverrideBase: "source-set-package-view"
  });
  assert(
    sourceSetOverrideAnalysis.pieceDslSource === "source-set-package-view-override" &&
      sourceSetOverrideAnalysis.pieceDslMerge?.piecePackage?.targets.some(
        (target) => target.label === promotedUserTarget.label && target.visibility.includes("//visibility:public")
      ) &&
      sourceSetOverrideAnalysis.pieceDsl.includes('"fixtures/user.json"'),
    `Source-set package view override did not merge against the selected source-set package view: ${JSON.stringify({
      pieceDslSource: sourceSetOverrideAnalysis.pieceDslSource,
      pieceDslMerge: sourceSetOverrideAnalysis.pieceDslMerge
    })}`
  );
  assert(
    sourceSetOverrideAnalysis.actionPackage === undefined &&
      sourceSetOverrideAnalysis.snapshot.actionPackage === undefined,
    `Source-set package view override should stay metadata-only by default: ${JSON.stringify({
      actionPackage: sourceSetOverrideAnalysis.actionPackage,
      snapshotActionPackage: sourceSetOverrideAnalysis.snapshot.actionPackage
    })}`
  );
  const sourceSetActionSnapshotOverrideAnalysis = await analyzePieceFile({
    filePath: renderPath,
    source,
    declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
      projectRoot: workspace,
      backend: "analysis-api",
      analysisApiEnabled: true
    }),
    sourceSetScopeSelection: "safe",
    overrideFilePath: join(workspace, "Render.source-set.override.pic"),
    overrideSource: sourceSetOverride,
    pieceDslOverrideBase: "source-set-package-view",
    pieceDslOverrideMode: "action-snapshot"
  });
  assert(
    sourceSetActionSnapshotOverrideAnalysis.actionPackage?.targets.some(
      (target) => target.label === promotedUserTarget.label && target.visibility.includes("//visibility:public")
    ),
    `Source-set action-snapshot override did not expose the merged action package: ${JSON.stringify(sourceSetActionSnapshotOverrideAnalysis.actionPackage)}`
  );
  assert(
    JSON.stringify(sourceSetActionSnapshotOverrideAnalysis.snapshot.actionPackage) ===
      JSON.stringify(sourceSetActionSnapshotOverrideAnalysis.actionPackage),
    `Source-set action-snapshot override did not retain the merged snapshot action package: ${JSON.stringify({
      actionPackage: sourceSetActionSnapshotOverrideAnalysis.actionPackage,
      snapshotActionPackage: sourceSetActionSnapshotOverrideAnalysis.snapshot.actionPackage
    })}`
  );
  assert(
    sourceSetActionSnapshotOverrideAnalysis.actionPackageOrigin?.kind === "piece-dsl-override" &&
      sourceSetActionSnapshotOverrideAnalysis.actionPackageOrigin.base === "source-set-package-view" &&
      sourceSetActionSnapshotOverrideAnalysis.actionPackageOrigin.mode === "action-snapshot" &&
      sourceSetActionSnapshotOverrideAnalysis.actionPackageOrigin.pieceDslSource === "source-set-package-view-override",
    `Source-set action-snapshot override did not expose action package origin metadata: ${JSON.stringify(sourceSetActionSnapshotOverrideAnalysis.actionPackageOrigin)}`
  );
  const actionSnapshotAppStatus = await compilePieceApp({
    filePath: renderPath,
    source,
    projectRoot: workspace,
    analysis: sourceSetActionSnapshotOverrideAnalysis,
    target: "render",
    compileAction: true,
    pieceTarget: promotedUserTarget.label
  });
  assert(
    actionSnapshotAppStatus.compileAction?.status === "success" &&
      actionSnapshotAppStatus.compileActionSelection?.actionPackageSource === "analysis-action-package" &&
      actionSnapshotAppStatus.compileActionSelection.actionPackageOrigin?.base === "source-set-package-view" &&
      actionSnapshotAppStatus.compileAction.pieceAction?.targetLabel === promotedUserTarget.label,
    `App-level compile action did not dispatch through the source-set action-snapshot override package: ${JSON.stringify({
      selection: actionSnapshotAppStatus.compileActionSelection,
      compileAction: actionSnapshotAppStatus.compileAction,
      diagnostics: actionSnapshotAppStatus.compileActionDiagnostics
    })}`
  );
  assert(
    actionSnapshotAppStatus.preview?.target === sourceSetActionSnapshotOverrideAnalysis.previewTargets[0] &&
      actionSnapshotAppStatus.piece.targets.some((target) => target.name === "render") &&
      !actionSnapshotAppStatus.piece.targets.some((target) => target.name === promotedUserTarget.name),
    `App-level source-set action dispatch changed preview/current-file target selection: ${JSON.stringify({
      preview: actionSnapshotAppStatus.preview,
      piece: actionSnapshotAppStatus.piece,
      promotedUserTarget
    })}`
  );
  assert(
    analysis.piecePackage.actions.every((action) => action.inputs.includes(`project-model:${analysis.manifest.projectModel.analysisScope.hashes.scopeHash}`)),
    `Piece actions did not include the Gradle project model hash input: ${JSON.stringify(analysis.piecePackage.actions)}`
  );
  assert(
    analysis.piecePackage.actions.every((action) => action.inputs.includes(`source-set:${analysis.manifest.projectModel.analysisScope.hashes.scopeHash}`)),
    `Piece actions did not include the source-set feedback scope input: ${JSON.stringify(analysis.piecePackage.actions)}`
  );
  const appStatus = await compilePieceApp({
    filePath: renderPath,
    source,
    analysis,
    target: "__no_preview__",
    compileAction: true,
    pieceTarget: "__missing_piece_target__"
  });
  assert(
    appStatus.compileActionDiagnostics?.[0]?.code === "piece-compile-action-dispatch-failed",
    `Expected app-level compile action dispatch to return diagnostics for missing target: ${JSON.stringify(appStatus)}`
  );
  assert(
    appStatus.compileActionSelection?.actionPackageSource === "selected-source-set-view",
    `Expected app-level compile action selection to use the selected source-set package view: ${JSON.stringify(appStatus.compileActionSelection)}`
  );
  assert(
    appStatus.compileActionSelection?.sourceSet?.status === "selected" &&
      appStatus.compileActionSelection.sourceSet.projectPath === ":app" &&
      JSON.stringify(appStatus.compileActionSelection.sourceSet.projectPaths) === JSON.stringify([":app", ":domain"]) &&
      appStatus.compileActionSelection.sourceSet.sourceSet === "jvmMain" &&
      JSON.stringify(appStatus.compileActionSelection.sourceSet.requiredSourceSets) === JSON.stringify(["commonMain", "jvmMain"]) &&
      appStatus.compileActionSelection.sourceSet.scopeHash === analysis.manifest.projectModel.analysisScope.hashes.scopeHash &&
      appStatus.compileActionSelection.sourceSet.sourceRootCount >= 2 &&
      appStatus.compileActionSelection.sourceSet.classpathCount >= 1 &&
      appStatus.compileActionSelection.sourceSet.dependencyCoordinateCount >= 1 &&
      appStatus.compileActionSelection.sourceSet.projectDependencyCount >= 1 &&
      appStatus.compileActionSelection.sourceSet.targetVariantCount >= 2,
    `App-level compile action selection did not expose source-set proof metadata: ${JSON.stringify(appStatus.compileActionSelection)}`
  );
  assert(
    appStatus.compileActionSelection?.sourceSetScope?.packageViewArtifactCache?.artifacts.some(
      (artifact) => artifact.target === promotedUserTarget.label && artifact.kind === "piece-compile" && artifact.cacheKey
    ),
    `App-level compile action selection did not expose promoted source-set artifact cache metadata: ${JSON.stringify(
      appStatus.compileActionSelection?.sourceSetScope
    )}`
  );
  assert(
    !appStatus.analysis?.actionPackage &&
      appStatus.analysis?.snapshot?.actionPackage?.targets.some((target) => target.label === promotedUserTarget.label),
    `App-level compile status did not retain the selected source-set package view snapshot: ${JSON.stringify({
      actionPackage: appStatus.analysis?.actionPackage,
      snapshotActionPackage: appStatus.analysis?.snapshot?.actionPackage
    })}`
  );
  assert(
    appStatus.analysis?.snapshot?.actionPackage?.artifacts.some(
      (artifact) => artifact.target === promotedUserTarget.label && artifact.kind === "piece-compile" && artifact.cacheKey
    ),
    `App-level compile status did not retain source-set artifact cache keys in the action snapshot: ${JSON.stringify(
      appStatus.analysis?.snapshot?.actionPackage?.artifacts
    )}`
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
