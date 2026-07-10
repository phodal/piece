export * from "./index.js";
import type {
  AnalyzePieceFileOptions,
  BuildPiecePreviewOptions,
  CompilePieceAppOptions,
  CompilePieceAppStatus,
  KotlinAnalysisBackendKind,
  PieceAnalysisBackendMetadata,
  PieceCompileActionCacheRecord,
  PieceCompileActionCacheStatus,
  PieceBuildEngine,
  PieceDeclarationExtractor,
  PieceFileAnalysis,
  PieceFileManifest,
  PieceGoListMetadata,
  PiecePreviewBuild,
  SingleFilePiecePackage,
  VirtualFileSystem
} from "./index.js";
export function createNodeEsbuildBuildEngine(options?: {
  readonly name?: string;
  readonly buildOptions?: Record<string, unknown>;
  readonly transformOptions?: Record<string, unknown>;
}): PieceBuildEngine;
export function createNodeVirtualFileSystem(options?: { readonly cwd?: string }): VirtualFileSystem;

/** Policy applied to every external Go or JVM/Gradle action started by a Node host. */
export interface NodeActionRunnerOptions {
  /** Finite action timeout in milliseconds; defaults to 300000 (five minutes). */
  readonly timeoutMs?: number;
  /** Combined stdout/stderr capture limit in bytes; defaults to 4 MiB. */
  readonly maxOutputBytes?: number;
  /** Grace period between cooperative termination and force termination. */
  readonly killGraceMs?: number;
  /** Cancels the action and returns an ACTION_ABORTED command result. */
  readonly signal?: AbortSignal;
  /** Defaults to true for compatibility. Set false to avoid inheriting process.env. */
  readonly inheritProcessEnv?: boolean;
  /** Optional process.env names to inherit when using a controlled environment. */
  readonly envAllowlist?: readonly string[];
}

export interface NodeActionRunnerPolicyOptions {
  readonly actionRunner?: NodeActionRunnerOptions;
}

export interface PieceCompilerCommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly outputLimitExceeded?: boolean;
  readonly outputBytes?: {
    readonly stdout: number;
    readonly stderr: number;
    readonly total: number;
    readonly captured: number;
    readonly limit: number;
  };
  readonly durationMs: number;
}

export interface PieceCompilerOutputFile {
  readonly path: string;
  readonly sizeBytes: number;
}

export interface PieceCompileActionReference {
  readonly targetLabel: string;
  readonly actionId: string;
  readonly artifactId: string;
  readonly kind?: "compile" | (string & {});
}

export interface PieceLanguageCompileDiagnostic {
  readonly code: string;
  readonly severity: "error";
  readonly message: string;
  readonly command: string;
}

export interface PieceLanguageCompileResult {
  readonly version: 1;
  readonly language: "go" | "kotlin" | "javascript" | "typescript";
  readonly backend?: string;
  readonly filePath: string;
  readonly target: string;
  readonly status: "success" | "error";
  readonly workspace?: string;
  readonly projectRoot?: string;
  readonly pieceAction?: PieceCompileActionReference;
  readonly outputFiles: readonly PieceCompilerOutputFile[];
  readonly commands: readonly PieceCompilerCommandResult[];
  readonly diagnostics: readonly PieceLanguageCompileDiagnostic[];
  readonly actionCache?: PieceCompileActionCacheStatus;
}

export interface PieceDslParseDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly command?: string;
}

export interface PieceDslParseResult {
  readonly version: 1;
  readonly parser: "antlr-pic-parser";
  readonly filePath: string;
  readonly source: string;
  readonly piecePackage: SingleFilePiecePackage | null;
  readonly diagnostics: readonly PieceDslParseDiagnostic[];
}

export interface PieceDslMergeResult {
  readonly version: 1;
  readonly merger: "piece-dsl-merge";
  readonly generatedFilePath: string;
  readonly overrideFilePath: string;
  readonly pieceDsl: string;
  readonly piecePackage: SingleFilePiecePackage | null;
  readonly diagnostics: readonly PieceDslParseDiagnostic[];
}

export interface ParsePieceDslFileOptions extends NodeActionRunnerPolicyOptions {
  readonly filePath?: string;
  readonly source?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface MergePieceDslFilesOptions extends NodeActionRunnerPolicyOptions {
  readonly generatedFilePath?: string;
  readonly overrideFilePath?: string;
  readonly generatedPackage?: SingleFilePiecePackage;
  readonly generatedSource?: string;
  readonly overrideSource?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}

export type PieceDslOverrideMode = "metadata-only" | "action-snapshot" | (string & {});
export type PieceDslOverrideBase = "primary" | "current-file" | "selected-package-view" | "source-set-package-view" | (string & {});

export interface NodeAnalyzePieceFileOptions extends AnalyzePieceFileOptions, NodeActionRunnerPolicyOptions {
  readonly generatedFilePath?: string;
  readonly overrideFilePath?: string;
  readonly overrideSource?: string;
  readonly pieceDslOverrideBase?: PieceDslOverrideBase;
  readonly pieceDslOverrideMode?: PieceDslOverrideMode;
  readonly env?: Record<string, string | undefined>;
}

export interface NodeCompilePieceAppOptions extends CompilePieceAppOptions, NodeActionRunnerPolicyOptions {
  readonly generatedFilePath?: string;
  readonly overrideFilePath?: string;
  readonly overrideSource?: string;
  readonly pieceDslOverrideBase?: PieceDslOverrideBase;
  readonly pieceDslOverrideMode?: PieceDslOverrideMode;
  readonly compileAction?: boolean;
  readonly pieceTarget?: string;
  readonly pieceActionName?: string;
  readonly languageTarget?: "jvm" | "js" | "wasmJs" | "all" | (string & {});
  readonly kotlinTarget?: "jvm" | "js" | "wasmJs" | "all" | (string & {});
  readonly workspace?: string;
  readonly outDir?: string;
  readonly keepWorkspace?: boolean;
  readonly modulePath?: string;
  readonly runTests?: boolean;
  readonly actionPackage?: SingleFilePiecePackage;
  readonly actionCacheRecords?:
    | false
    | ReadonlyMap<string, PieceCompileActionCacheRecord>
    | Record<string, PieceCompileActionCacheRecord>
    | readonly PieceCompileActionCacheRecord[];
  readonly actionCacheMode?: "status-only" | "bypass" | "reuse-local" | (string & {});
  readonly actionCacheStorePath?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface NodeBuildPiecePreviewOptions extends BuildPiecePreviewOptions, NodeActionRunnerPolicyOptions {
  readonly generatedFilePath?: string;
  readonly overrideFilePath?: string;
  readonly overrideSource?: string;
  readonly pieceDslOverrideBase?: PieceDslOverrideBase;
  readonly pieceDslOverrideMode?: PieceDslOverrideMode;
  readonly env?: Record<string, string | undefined>;
}

export interface NodeActionPackageOrigin {
  readonly kind: "piece-dsl-override" | (string & {});
  readonly mode?: PieceDslOverrideMode;
  readonly base?: PieceDslOverrideBase;
  readonly pieceDslSource?: string;
  readonly generatedFilePath?: string;
  readonly overrideFilePath?: string;
}

export interface NodePieceFileAnalysis extends PieceFileAnalysis {
  readonly pieceDslMerge?: PieceDslMergeResult;
  readonly actionPackageOrigin?: NodeActionPackageOrigin;
}

export interface NodeCompileActionDiagnostic {
  readonly code: "piece-compile-action-dispatch-failed" | (string & {});
  readonly severity: "error";
  readonly message: string;
}

export interface NodeCompileActionSelectionReason {
  readonly code: string;
  readonly severity: "warning" | "error" | (string & {});
  readonly message: string;
  readonly [key: string]: unknown;
}

export interface NodeCompileActionArtifactCacheEntry {
  readonly id: string;
  readonly target: string;
  readonly kind: string;
  readonly cacheKey?: string;
}

export interface NodeCompileActionArtifactCacheMetadata {
  readonly artifactCount: number;
  readonly cachedArtifactCount: number;
  readonly artifacts: readonly NodeCompileActionArtifactCacheEntry[];
}

export interface NodeCompileActionSelection {
  readonly actionPackageSource:
    | "explicit"
    | "analysis-action-package"
    | "snapshot-action-package"
    | "selected-package-view"
    | "selected-source-set-view"
    | "analysis-piece-package"
    | "missing"
    | (string & {});
  readonly actionPackageOrigin?: NodeActionPackageOrigin;
  readonly actionCache?: PieceCompileActionCacheStatus;
  readonly feedbackScope: {
    readonly level: string;
    readonly fallbackRequired: boolean;
    readonly blockers: readonly NodeCompileActionSelectionReason[];
  };
  readonly packageScope?: {
    readonly status?: string;
    readonly requested?: string;
    readonly appliedToPackageView: boolean;
    readonly reason?: string;
    readonly blockers: readonly NodeCompileActionSelectionReason[];
  };
  readonly sourceSetScope?: {
    readonly status?: string;
    readonly requested?: string;
    readonly appliedToPackageView: boolean;
    readonly reason?: string;
    readonly blockers: readonly NodeCompileActionSelectionReason[];
    readonly packageViewArtifactCache?: NodeCompileActionArtifactCacheMetadata;
  };
  readonly sourceSet?: {
    readonly status?: string;
    readonly projectPath?: string;
    readonly projectPaths?: readonly string[];
    readonly sourceSet?: string;
    readonly requiredSourceSets?: readonly string[];
    readonly fallbackReason?: string;
    readonly scopeHash?: string;
    readonly sourceRootCount?: number;
    readonly classpathCount?: number;
    readonly dependencyCoordinateCount?: number;
    readonly projectDependencyCount?: number;
    readonly targetVariantCount?: number;
  };
}

export interface NodeCompilePieceAppStatus extends CompilePieceAppStatus {
  readonly compileAction?: GoPieceCompileResult | KotlinPieceCompileResult | JavaScriptPieceCompileResult;
  readonly compileActionSelection?: NodeCompileActionSelection;
  readonly compileActionDiagnostics?: readonly NodeCompileActionDiagnostic[];
}

export interface KotlinPieceDslGenerationResult {
  readonly version: 1;
  readonly generator: "kotlin-psi-pic-generator";
  readonly filePath: string;
  readonly source: string;
  readonly pic: string;
  readonly piecePackage: SingleFilePiecePackage | null;
  readonly analysisBackend: PieceAnalysisBackendMetadata;
  readonly diagnostics: readonly PieceDslParseDiagnostic[];
}

export interface GenerateKotlinPieceDslFileOptions extends NodeActionRunnerPolicyOptions {
  readonly filePath?: string;
  readonly source?: string;
  readonly backend?: KotlinAnalysisBackendKind;
  readonly kotlinAnalysisApiEnabled?: boolean;
  readonly kotlinAnalysisApiVersion?: string;
  readonly analysisApiEnabled?: boolean;
  readonly analysisApiVersion?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface CompileGoPieceFileOptions extends NodeActionRunnerPolicyOptions {
  readonly filePath?: string;
  readonly source?: string;
  readonly workspace?: string;
  readonly outDir?: string;
  readonly keepWorkspace?: boolean;
  readonly goCommand?: string;
  readonly modulePath?: string;
  readonly runTests?: boolean;
  readonly pieceAction?: PieceCompileActionReference;
  readonly pieceTarget?: string;
  readonly pieceActionName?: string;
  readonly actionPackage?: SingleFilePiecePackage;
  readonly env?: Record<string, string | undefined>;
}

export interface CompileKotlinPieceFileOptions extends NodeActionRunnerPolicyOptions {
  readonly filePath?: string;
  readonly source?: string;
  readonly target?: "jvm" | "js" | "wasmJs" | "all" | (string & {});
  readonly sourceSet?: "commonMain" | "jvmMain" | "jsMain" | "wasmJsMain" | (string & {});
  readonly workspace?: string;
  readonly keepWorkspace?: boolean;
  readonly projectRoot?: string;
  readonly gradleProjectRoot?: string;
  readonly gradleCommand?: string;
  readonly gradleVersion?: string;
  readonly kotlinPluginVersion?: string;
  readonly tasks?: readonly string[];
  readonly sourceFiles?: readonly (KotlinAnalysisSourceFile | string)[];
  readonly sourceRoots?: readonly string[];
  readonly cwd?: string;
  readonly pieceAction?: PieceCompileActionReference;
  readonly pieceTarget?: string;
  readonly pieceActionName?: string;
  readonly actionPackage?: SingleFilePiecePackage;
  readonly env?: Record<string, string | undefined>;
}

export interface CompileJavaScriptPieceFileOptions extends NodeActionRunnerPolicyOptions {
  readonly filePath?: string;
  readonly source?: string;
  readonly target?: "esm" | "browser" | "node" | (string & {});
  readonly platform?: "browser" | "node" | "neutral" | (string & {});
  readonly format?: "esm" | "cjs" | "iife" | (string & {});
  readonly bundle?: boolean;
  readonly sourcemap?: boolean;
  readonly workspace?: string;
  readonly outDir?: string;
  readonly keepWorkspace?: boolean;
  readonly cwd?: string;
  readonly pieceAction?: PieceCompileActionReference;
  readonly pieceTarget?: string;
  readonly pieceActionName?: string;
  readonly actionPackage?: SingleFilePiecePackage;
  readonly env?: Record<string, string | undefined>;
}

export interface CompilePieceActionOptions extends CompileKotlinPieceFileOptions {
  readonly language?: "go" | "kotlin" | "javascript" | "typescript" | (string & {});
  readonly analysis?: PieceFileAnalysis;
  readonly outDir?: string;
  readonly goCommand?: string;
  readonly modulePath?: string;
  readonly runTests?: boolean;
  readonly platform?: "browser" | "node" | "neutral" | (string & {});
  readonly format?: "esm" | "cjs" | "iife" | (string & {});
  readonly bundle?: boolean;
  readonly sourcemap?: boolean;
  readonly actionCacheRecords?:
    | false
    | ReadonlyMap<string, PieceCompileActionCacheRecord>
    | Record<string, PieceCompileActionCacheRecord>
    | readonly PieceCompileActionCacheRecord[];
  readonly actionCacheMode?: "status-only" | "bypass" | "reuse-local" | (string & {});
  readonly actionCacheStorePath?: string;
}

export interface AnalyzeKotlinPieceFileOptions extends NodeActionRunnerPolicyOptions {
  readonly filePath?: string;
  readonly source?: string;
  readonly sourceFiles?: readonly (KotlinAnalysisSourceFile | string)[];
  readonly sourceRoots?: readonly string[];
  readonly classpath?: readonly string[];
  readonly projectRoot?: string;
  readonly gradleProjectRoot?: string;
  readonly gradleCommand?: string;
  readonly gradleVersion?: string;
  readonly cwd?: string;
  readonly parserName?: string;
  readonly backend?: KotlinAnalysisBackendKind;
  readonly kotlinAnalysisApiEnabled?: boolean;
  readonly kotlinAnalysisApiVersion?: string;
  readonly analysisApiEnabled?: boolean;
  readonly analysisApiVersion?: string;
  readonly semanticDiagnostics?: boolean;
  readonly semanticSymbols?: boolean;
  readonly env?: Record<string, string | undefined>;
}

export interface KotlinAnalysisSourceFile {
  readonly filePath: string;
  readonly source: string;
}

export interface NodeKotlinPsiDeclarationExtractorOptions extends NodeActionRunnerPolicyOptions {
  readonly name?: string;
  readonly sourceFiles?: readonly (KotlinAnalysisSourceFile | string)[];
  readonly sourceRoots?: readonly string[];
  readonly classpath?: readonly string[];
  readonly projectRoot?: string;
  readonly gradleProjectRoot?: string;
  readonly gradleCommand?: string;
  readonly gradleVersion?: string;
  readonly cwd?: string;
  readonly backend?: KotlinAnalysisBackendKind;
  readonly kotlinAnalysisApiEnabled?: boolean;
  readonly kotlinAnalysisApiVersion?: string;
  readonly analysisApiEnabled?: boolean;
  readonly analysisApiVersion?: string;
  readonly semanticDiagnostics?: boolean;
  readonly semanticSymbols?: boolean;
  readonly env?: Record<string, string | undefined>;
}

export interface NodeGoDeclarationExtractorOptions extends NodeActionRunnerPolicyOptions {
  readonly name?: string;
  readonly goCommand?: string;
  readonly modulePath?: string;
  readonly goModulePath?: string;
  readonly goList?: boolean;
  readonly goAnalyzer?: boolean;
  readonly backend?: "go-ast" | "javascript" | (string & {});
  readonly sourceFiles?: readonly (string | { readonly filePath: string; readonly source: string })[];
  readonly sourceRoots?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly declarationExtractor?: PieceDeclarationExtractor;
}

export interface KotlinPieceCompileResult extends PieceLanguageCompileResult {
  readonly language: "kotlin";
  readonly backend: "kotlin-jvm";
  readonly target: "jvm" | "js" | "wasmJs" | "all";
  readonly sourceSet: string;
}

export interface JavaScriptPieceCompileResult extends PieceLanguageCompileResult {
  readonly language: "javascript" | "typescript";
  readonly backend: "esbuild";
}

export interface GoPieceCompileResult extends PieceLanguageCompileResult {
  readonly language: "go";
  readonly target: "binary" | "package";
  readonly goList: PieceGoListMetadata;
}

export function compilePieceAction(options?: CompilePieceActionOptions): Promise<GoPieceCompileResult | KotlinPieceCompileResult | JavaScriptPieceCompileResult>;
export function compileGoPieceFile(options?: CompileGoPieceFileOptions): Promise<GoPieceCompileResult>;
export function compileKotlinPieceFile(options?: CompileKotlinPieceFileOptions): Promise<KotlinPieceCompileResult>;
export function compileJavaScriptPieceFile(options?: CompileJavaScriptPieceFileOptions): Promise<JavaScriptPieceCompileResult>;
export function analyzePieceFile(options?: NodeAnalyzePieceFileOptions): Promise<NodePieceFileAnalysis>;
export function compilePieceApp(options?: NodeCompilePieceAppOptions): Promise<NodeCompilePieceAppStatus>;
export function buildPiecePreview(options?: NodeBuildPiecePreviewOptions): Promise<PiecePreviewBuild>;
export function analyzeKotlinPieceFile(options?: AnalyzeKotlinPieceFileOptions): Promise<PieceFileManifest>;
export function parsePieceDslFile(options?: ParsePieceDslFileOptions): Promise<PieceDslParseResult>;
export function mergePieceDslFiles(options?: MergePieceDslFilesOptions): Promise<PieceDslMergeResult>;
export function generateKotlinPieceDslFile(options?: GenerateKotlinPieceDslFileOptions): Promise<KotlinPieceDslGenerationResult>;
export function createNodeGoDeclarationExtractor(options?: NodeGoDeclarationExtractorOptions): PieceDeclarationExtractor;
export function createNodeKotlinPsiDeclarationExtractor(options?: NodeKotlinPsiDeclarationExtractorOptions): PieceDeclarationExtractor;
