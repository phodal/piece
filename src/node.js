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
  if (analysis?.piecePackage) return "analysis-piece-package";
  return "missing";
}

function nonInfoReasons(reasons = []) {
  return reasons.filter((reason) => reason?.severity !== "info");
}

function compileActionSelectionForStatus(options = {}, status = {}) {
  const analysis = status.analysis;
  const packageScope = analysis?.packageScope;
  const packagePromotion = packageScope?.promotion;
  const sourceSet = analysis?.feedbackScope?.sourceSet ?? analysis?.manifest?.projectModel?.analysisScope;
  return {
    actionPackageSource: actionPackageSource(options, analysis),
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
    ...(sourceSet
      ? {
          sourceSet: {
            status: sourceSet.status,
            projectPath: sourceSet.projectPath,
            sourceSet: sourceSet.sourceSet,
            fallbackReason: sourceSet.fallbackReason
          }
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

function primaryGeneratedPackageForAnalysis(analysis) {
  if (analysis.pieceDslSource === "selected-package-view" && analysis.packageScope?.packageView) {
    return analysis.packageScope.packageView;
  }
  return analysis.piecePackage;
}

function overridePieceDslSource(source) {
  return source === "selected-package-view" ? "selected-package-view-override" : "current-file-override";
}

function pieceDslOverrideMode(options = {}) {
  return options.pieceDslOverrideMode ?? "metadata-only";
}

async function applyPieceDslOverride(analysis, options = {}) {
  if (!hasPieceDslOverride(options)) {
    return analysis;
  }
  const merged = await mergePieceDslFiles({
    generatedFilePath: options.generatedFilePath ?? options.filePath?.replace(/\.[^.]+$/, ".generated.pic"),
    generatedPackage: primaryGeneratedPackageForAnalysis(analysis),
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
    pieceDslSource: overridePieceDslSource(analysis.pieceDslSource),
    pieceDslMerge: merged
  };
  if (pieceDslOverrideMode(options) !== "action-snapshot") {
    return nextAnalysis;
  }
  const actionAnalysis = {
    ...nextAnalysis,
    actionPackage: merged.piecePackage
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
      compileActionSelection,
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
