export * from "./index.js";
export * from "./node-language-compilers.js";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as esbuild from "esbuild";
import { mergePieceCompilerOptions } from "./core/options.js";
import {
  analyzePieceFile as analyzeCorePieceFile,
  applyPieceEdit as applyCorePieceEdit,
  buildPiecePreview as buildCorePiecePreview,
  compilePieceApp as compileCorePieceApp,
  createPieceSnapshot as createCorePieceSnapshot,
  normalizePieceAppInput,
  rebuildAffectedPiecePreviews as rebuildCoreAffectedPiecePreviews,
  selectPiecePreviewTarget
} from "./index.js";
import {
  compilePieceAction,
  createNodeGoDeclarationExtractor,
  createNodeKotlinPsiDeclarationExtractor,
  mergePieceDslFiles
} from "./node-language-compilers.js";

const SOURCE_FILE_PATTERN = /\.(tsx?|jsx?|kts?|go)$/;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

function withNodeDeclarationExtractor(options = {}) {
  if (!options.declarationExtractor && /\.go$/.test(options.filePath ?? "")) {
    return {
      ...options,
      declarationExtractor: createNodeGoDeclarationExtractor({
        goCommand: options.goCommand,
        modulePath: options.goModulePath ?? options.modulePath,
        goList: options.goList,
        goAnalyzer: options.goAnalyzer,
        backend: options.goAnalysisBackend,
        sourceFiles: options.sourceFiles,
        sourceRoots: options.sourceRoots,
        cwd: options.cwd ?? options.fileSystem?.cwd,
        env: options.env
      })
    };
  }
  if (!options.declarationExtractor && /\.(?:kt|kts)$/.test(options.filePath ?? "")) {
    return {
      ...options,
      declarationExtractor: createNodeKotlinPsiDeclarationExtractor({
        sourceFiles: options.sourceFiles,
        sourceRoots: options.sourceRoots,
        classpath: options.classpath,
        projectRoot: options.projectRoot,
        gradleProjectRoot: options.gradleProjectRoot,
        gradleCommand: options.gradleCommand,
        gradleVersion: options.gradleVersion,
        cwd: options.cwd ?? options.fileSystem?.cwd,
        backend: options.kotlinAnalysisBackend,
        analysisApiEnabled: options.kotlinAnalysisApiEnabled === true || options.analysisApiEnabled === true,
        analysisApiVersion: options.kotlinAnalysisApiVersion ?? options.analysisApiVersion,
        semanticDiagnostics: options.semanticDiagnostics === true,
        semanticSymbols: options.semanticSymbols === true,
        env: options.env
      })
    };
  }
  return options;
}

function hasPieceDslOverride(options = {}) {
  return options.overrideSource !== undefined || options.overrideFilePath !== undefined;
}

function needsNodeAnalysisForActionPackage(options = {}) {
  return !options.analysis && (hasPieceDslOverride(options) || options.pieceDslOverrideMode !== undefined);
}

function compileActionOptionsForStatus(options = {}, status) {
  const compileOptions = {
    ...options,
    filePath: status.filePath,
    analysis: status.analysis,
    pieceTarget: options.pieceTarget ?? options.target ?? status.piece?.target?.name ?? status.piece?.target?.id,
    pieceActionName: options.pieceActionName
  };
  delete compileOptions.compileAction;
  delete compileOptions.target;
  if (options.languageTarget ?? options.kotlinTarget) {
    compileOptions.target = options.languageTarget ?? options.kotlinTarget;
  }
  return compileOptions;
}

function compileActionDiagnostic(error) {
  return {
    code: "piece-compile-action-dispatch-failed",
    severity: "error",
    message: error?.message ?? String(error ?? "Piece compile action dispatch failed.")
  };
}

function actionPackageSource(options = {}, analysis) {
  if (options.actionPackage) return "explicit";
  if (analysis?.actionPackage) return "analysis-action-package";
  if (analysis?.snapshot?.actionPackage) return "snapshot-action-package";
  if (analysis?.packageScope?.status === "selected" && analysis.packageScope.packageView) return "selected-package-view";
  if (analysis?.sourceSetScope?.status === "selected" && analysis.sourceSetScope.packageView) return "selected-source-set-view";
  if (analysis?.piecePackage) return "analysis-piece-package";
  return "missing";
}

function nonInfoReasons(reasons = []) {
  return reasons.filter((reason) => reason?.severity !== "info");
}

function compileActionSourceSetSelection(analysis) {
  const feedbackSourceSet = analysis?.feedbackScope?.sourceSet;
  const projectSourceSet = analysis?.manifest?.projectModel?.analysisScope;
  const sourceSet = feedbackSourceSet ?? projectSourceSet;
  if (!sourceSet) {
    return undefined;
  }
  const sourceRoots = sourceSet.sourceRoots ?? [];
  const classpath = sourceSet.classpath ?? [];
  const dependencyCoordinates = sourceSet.dependencyCoordinates ?? [];
  const projectDependencies = sourceSet.projectDependencies ?? [];
  const targetVariants = sourceSet.targetVariants ?? [];
  return {
    status: projectSourceSet?.status ?? (feedbackSourceSet ? "selected" : undefined),
    projectPath: sourceSet.projectPath,
    projectPaths: sourceSet.projectPaths,
    sourceSet: sourceSet.sourceSet,
    requiredSourceSets: sourceSet.requiredSourceSets,
    fallbackReason: projectSourceSet?.fallbackReason,
    scopeHash: sourceSet.hashes?.scopeHash,
    sourceRootCount: sourceRoots.length,
    classpathCount: classpath.length,
    dependencyCoordinateCount: dependencyCoordinates.length,
    projectDependencyCount: projectDependencies.length,
    targetVariantCount: targetVariants.length
  };
}

function promotedPackageViewArtifactCacheMetadata(scope) {
  const packageView = scope?.packageView;
  const promotedTargets = new Set((scope?.promotedTargets ?? []).map((target) => target.label).filter(Boolean));
  if (!packageView || promotedTargets.size === 0) {
    return undefined;
  }
  const artifacts = (packageView.artifacts ?? [])
    .filter((artifact) => promotedTargets.has(artifact.target))
    .map((artifact) => ({
      id: artifact.id,
      target: artifact.target,
      kind: artifact.kind,
      ...(artifact.cacheKey ? { cacheKey: artifact.cacheKey } : {})
    }));
  if (artifacts.length === 0) {
    return undefined;
  }
  return {
    artifactCount: artifacts.length,
    cachedArtifactCount: artifacts.filter((artifact) => artifact.cacheKey).length,
    artifacts
  };
}

function compileActionSelectionForStatus(options = {}, status = {}) {
  const analysis = status.analysis;
  const packageScope = analysis?.packageScope;
  const packagePromotion = packageScope?.promotion;
  const sourceSetScope = analysis?.sourceSetScope;
  const sourceSetPromotion = sourceSetScope?.promotion;
  const sourceSet = compileActionSourceSetSelection(analysis);
  const sourceSetPackageViewArtifactCache = promotedPackageViewArtifactCacheMetadata(sourceSetScope);
  return {
    actionPackageSource: actionPackageSource(options, analysis),
    ...(analysis?.actionPackageOrigin ? { actionPackageOrigin: analysis.actionPackageOrigin } : {}),
    feedbackScope: {
      level: analysis?.feedbackScope?.level ?? "unknown",
      fallbackRequired: analysis?.feedbackScope?.fallbackRequired === true,
      blockers: nonInfoReasons(analysis?.feedbackScope?.reasons ?? [])
    },
    ...(packageScope
      ? {
          packageScope: {
            status: packageScope.status,
            requested: packagePromotion?.requested,
            appliedToPackageView: packagePromotion?.appliedToPackageView === true,
            reason: packagePromotion?.reason,
            blockers: nonInfoReasons(packagePromotion?.blockedReasons ?? [])
          }
        }
      : {}),
    ...(sourceSetScope
      ? {
          sourceSetScope: {
            status: sourceSetScope.status,
            requested: sourceSetPromotion?.requested,
            appliedToPackageView: sourceSetPromotion?.appliedToPackageView === true,
            reason: sourceSetPromotion?.reason,
            blockers: nonInfoReasons(sourceSetPromotion?.blockedReasons ?? []),
            ...(sourceSetPackageViewArtifactCache ? { packageViewArtifactCache: sourceSetPackageViewArtifactCache } : {})
          }
        }
      : {}),
    ...(sourceSet
      ? {
          sourceSet
        }
      : {})
  };
}

function selectedPackageViewActionPackageForSnapshot(options = {}, analysis) {
  if (options.actionPackage || analysis?.actionPackage || analysis?.snapshot?.actionPackage) {
    return undefined;
  }
  if (analysis?.packageScope?.status === "selected" && analysis.packageScope.packageView) {
    return analysis.packageScope.packageView;
  }
  if (analysis?.sourceSetScope?.status === "selected" && analysis.sourceSetScope.packageView) {
    return analysis.sourceSetScope.packageView;
  }
  return undefined;
}

function statusWithCompileActionSnapshot(status, actionPackage) {
  const analysis = status.analysis;
  if (!analysis?.snapshot || !actionPackage) {
    return status;
  }
  const nextAnalysis = {
    ...analysis,
    snapshot: {
      ...analysis.snapshot,
      actionPackage
    }
  };
  return {
    ...status,
    analysis: nextAnalysis,
    ...(status.preview ? { preview: { ...status.preview, analysis: nextAnalysis } } : {})
  };
}

function statusWithCompileActionDiagnostic(status, diagnostic, selection) {
  return {
    ...status,
    diagnostics: {
      ...status.diagnostics,
      issueCount: (status.diagnostics?.issueCount ?? 0) + 1
    },
    ...(selection ? { compileActionSelection: selection } : {}),
    compileActionDiagnostics: [diagnostic]
  };
}

function pieceDslOverrideBase(options = {}) {
  return options.pieceDslOverrideBase ?? "primary";
}

function primaryGeneratedPackageForAnalysis(analysis, options = {}) {
  const overrideBase = pieceDslOverrideBase(options);
  if (overrideBase === "source-set-package-view" && analysis.sourceSetScope?.packageView) {
    return analysis.sourceSetScope.packageView;
  }
  if (overrideBase === "selected-package-view" && analysis.packageScope?.packageView) {
    return analysis.packageScope.packageView;
  }
  if (overrideBase === "current-file") {
    return analysis.piecePackage;
  }
  if (analysis.pieceDslSource === "selected-package-view" && analysis.packageScope?.packageView) {
    return analysis.packageScope.packageView;
  }
  return analysis.piecePackage;
}

function overridePieceDslSource(source, options = {}) {
  const overrideBase = pieceDslOverrideBase(options);
  if (overrideBase === "source-set-package-view") return "source-set-package-view-override";
  if (overrideBase === "selected-package-view") return "selected-package-view-override";
  if (overrideBase === "current-file") return "current-file-override";
  return source === "selected-package-view" ? "selected-package-view-override" : "current-file-override";
}

function pieceDslOverrideMode(options = {}) {
  return options.pieceDslOverrideMode ?? "metadata-only";
}

function actionPackageOriginForOverride(options = {}, analysis, merged) {
  return {
    kind: "piece-dsl-override",
    mode: pieceDslOverrideMode(options),
    base: pieceDslOverrideBase(options),
    pieceDslSource: analysis.pieceDslSource,
    generatedFilePath: merged.generatedFilePath,
    overrideFilePath: merged.overrideFilePath
  };
}

async function applyPieceDslOverride(analysis, options = {}) {
  if (!hasPieceDslOverride(options)) {
    return analysis;
  }
  const merged = await mergePieceDslFiles({
    generatedFilePath: options.generatedFilePath ?? options.filePath?.replace(/\.[^.]+$/, ".generated.pic"),
    generatedPackage: primaryGeneratedPackageForAnalysis(analysis, options),
    overrideFilePath: options.overrideFilePath,
    overrideSource: options.overrideSource,
    cwd: options.cwd ?? options.fileSystem?.cwd,
    env: options.env
  });
  if (!merged.piecePackage) {
    return {
      ...analysis,
      pieceDslMerge: merged
    };
  }
  const nextAnalysis = {
    ...analysis,
    pieceDsl: merged.pieceDsl,
    pieceDslSource: overridePieceDslSource(analysis.pieceDslSource, options),
    pieceDslMerge: merged
  };
  if (pieceDslOverrideMode(options) !== "action-snapshot") {
    return nextAnalysis;
  }
  const actionAnalysis = {
    ...nextAnalysis,
    actionPackage: merged.piecePackage,
    actionPackageOrigin: actionPackageOriginForOverride(options, nextAnalysis, merged)
  };
  return {
    ...actionAnalysis,
    snapshot: createCorePieceSnapshot({ analysis: actionAnalysis })
  };
}

export async function analyzePieceFile(options = {}) {
  const analysis = await analyzeCorePieceFile(withNodeDeclarationExtractor(options));
  return applyPieceDslOverride(analysis, options);
}

export async function compilePieceApp(options = {}) {
  if (!options.compileAction && !needsNodeAnalysisForActionPackage(options)) {
    return compileCorePieceApp(withNodeDeclarationExtractor(options));
  }
  const analysis = needsNodeAnalysisForActionPackage(options) ? await analyzePieceFile(options) : options.analysis;
  const compileOptions = analysis ? { ...options, analysis } : options;
  const status = await compileCorePieceApp(withNodeDeclarationExtractor(compileOptions));
  if (!options.compileAction) {
    return status;
  }
  const compileActionSelection = compileActionSelectionForStatus(options, status);
  const actionPackageSnapshot = selectedPackageViewActionPackageForSnapshot(options, status.analysis);
  const statusForCompileAction = statusWithCompileActionSnapshot(status, actionPackageSnapshot);
  try {
    const compileAction = await compilePieceAction(compileActionOptionsForStatus(options, statusForCompileAction));
    return {
      ...statusForCompileAction,
      compileActionSelection: {
        ...compileActionSelection,
        ...(compileAction.actionCache ? { actionCache: compileAction.actionCache } : {})
      },
      compileAction
    };
  } catch (error) {
    return statusWithCompileActionDiagnostic(statusForCompileAction, compileActionDiagnostic(error), compileActionSelection);
  }
}

export async function buildPiecePreview(options = {}) {
  if (!needsNodeAnalysisForActionPackage(options)) {
    return buildCorePiecePreview(withNodeDeclarationExtractor(options));
  }
  const analysis = await analyzePieceFile(options);
  return buildCorePiecePreview(withNodeDeclarationExtractor({ ...options, analysis }));
}

export function applyPieceEdit(options = {}) {
  return applyCorePieceEdit(withNodeDeclarationExtractor(options));
}

export function rebuildAffectedPiecePreviews(options = {}) {
  return rebuildCoreAffectedPiecePreviews(withNodeDeclarationExtractor(options));
}

export function createPieceCompiler(defaultOptions = {}) {
  return {
    normalize(options) {
      return normalizePieceAppInput(mergePieceCompilerOptions(defaultOptions, options));
    },
    compile(options) {
      return compilePieceApp(mergePieceCompilerOptions(defaultOptions, options));
    },
    analyzeFile(options) {
      return analyzePieceFile(mergePieceCompilerOptions(defaultOptions, options));
    },
    selectPreviewTarget(analysis, options = {}) {
      return selectPiecePreviewTarget(analysis, options);
    },
    buildPreview(options) {
      return buildPiecePreview(mergePieceCompilerOptions(defaultOptions, options));
    },
    applyEdit(options) {
      return applyPieceEdit(mergePieceCompilerOptions(defaultOptions, options));
    },
    rebuildAffectedPreviews(options) {
      return rebuildAffectedPiecePreviews(mergePieceCompilerOptions(defaultOptions, options));
    }
  };
}

export function createNodeEsbuildBuildEngine(options = {}) {
  return {
    name: options.name ?? "node-esbuild",
    build(buildOptions) {
      return esbuild.build({
        ...options.buildOptions,
        ...buildOptions
      });
    },
    transform(source, transformOptions = {}) {
      return esbuild.transform(source, {
        ...options.transformOptions,
        ...transformOptions
      });
    }
  };
}

async function collectSourceFilesFromDirectory(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(join(directory, entry.name));
        }
        continue;
      }
      if (entry.isFile() && SOURCE_FILE_PATTERN.test(entry.name)) {
        files.push(join(directory, entry.name));
      }
    }
  }
  await visit(root);
  return files;
}

export function createNodeVirtualFileSystem(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());

  return {
    kind: "node",
    cwd,
    toAbsolutePath(path) {
      return isAbsolute(path) ? path : resolve(cwd, path);
    },
    relativePath(path) {
      return relative(cwd, this.toAbsolutePath(path)) || ".";
    },
    async readText(path) {
      return readFile(this.toAbsolutePath(path), "utf8");
    },
    async writeText(path, contents) {
      const absolutePath = this.toAbsolutePath(path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, "utf8");
    },
    async collectSourceFiles(sourceRoots) {
      const roots = sourceRoots.length > 0 ? sourceRoots : ["."];
      const files = [];
      for (const sourceRoot of roots) {
        files.push(...(await collectSourceFilesFromDirectory(this.toAbsolutePath(sourceRoot))));
      }
      return [...new Set(files.map((file) => this.relativePath(file)))].sort();
    },
    dirname(path) {
      return dirname(this.toAbsolutePath(path));
    }
  };
}
