import { mergePieceCompilerOptions, splitPieceCompilerOptions } from "./options.js";
import { createPieceCompileStatus } from "./status.js";
import {
  analyzePieceFile,
  applyPieceEdit,
  buildPiecePreview,
  rebuildAffectedPiecePreviews,
  selectPiecePreviewTarget
} from "./piece-pipeline.js";

const DEFAULT_CWD = "/workspace";
const DEFAULT_FILE_PATH = "/workspace/App.tsx";

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function dirnameFor(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return ".";
  }
  return normalized.slice(0, index);
}

function sourceRootsFor(options, filePath) {
  if (Array.isArray(options.sourceRoots) && options.sourceRoots.length > 0) {
    return options.sourceRoots;
  }
  return [dirnameFor(filePath)];
}

async function readSource(fileSystem, filePath) {
  if (!fileSystem || typeof fileSystem.readText !== "function") {
    throw new TypeError("normalizePieceAppInput() requires source text or a fileSystem.readText() implementation.");
  }
  return fileSystem.readText(filePath);
}

async function collectSourceFiles(fileSystem, sourceRoots, filePath) {
  if (fileSystem && typeof fileSystem.collectSourceFiles === "function") {
    return uniqueStrings(await fileSystem.collectSourceFiles(sourceRoots));
  }
  return [filePath];
}

export async function normalizePieceAppInput(options = {}, fileSystem) {
  const activeFileSystem = fileSystem ?? options.fileSystem;
  const entry = options.entry ?? options.filePath ?? DEFAULT_FILE_PATH;
  const filePath = options.filePath ?? entry;
  const source = options.source ?? (await readSource(activeFileSystem, filePath));
  const sourceRoots = sourceRootsFor(options, filePath);
  const sourceFiles = await collectSourceFiles(activeFileSystem, sourceRoots, filePath);

  return {
    version: 1,
    compiler: "piece-compiler",
    name: options.name ?? filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "piece-preview",
    cwd: options.cwd ?? activeFileSystem?.cwd ?? DEFAULT_CWD,
    entry,
    filePath,
    source,
    sourceRoots,
    sourceFiles,
    sourceFileCount: sourceFiles.length,
    fileSystem: activeFileSystem
  };
}

export async function compilePieceApp(options = {}) {
  const normalized = await normalizePieceAppInput(options);
  const { piece } = splitPieceCompilerOptions(options);
  const analysis = await analyzePieceFile({
    filePath: normalized.filePath,
    source: normalized.source,
    previousTree: options.previousTree,
    declarationExtractor: options.declarationExtractor,
    globals: options.globals
  });
  const target = selectPiecePreviewTarget(analysis, {
    target: options.target ?? piece.target?.id,
    cursorByte: options.cursorByte
  });
  const preview = target
    ? await buildPiecePreview({
        ...options,
        filePath: normalized.filePath,
        source: normalized.source,
        analysis,
        target
      })
    : undefined;

  return createPieceCompileStatus(normalized, { piece, analysis, preview });
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
