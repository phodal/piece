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

/** A configuration or containment failure raised before workspace analysis starts. */
export class PieceWorkspaceError extends Error {
  readonly code: string;
}

export type PieceWorkspaceLanguage = "auto" | "javascript" | "typescript" | "go" | "kotlin" | (string & {});

/** Deliberately opaque until a caller turns the workspace plan into a strict fallback policy. */
export type PieceWorkspaceFallbackConfig = Readonly<Record<string, unknown>>;

export interface PieceWorkspaceProjectOptions {
  readonly id: string;
  readonly root?: string;
  readonly sourceRoots?: readonly string[];
  readonly files?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly fallback?: PieceWorkspaceFallbackConfig;
  /** Per-project fields forwarded to the selected file analyzer. */
  readonly analysisOptions?: Readonly<Record<string, unknown>>;
  readonly language?: PieceWorkspaceLanguage;
}

export interface PieceWorkspaceAnalyzeFileOptions {
  readonly cwd: string;
  readonly filePath: string;
  readonly source: string;
  readonly sourceFiles?: readonly string[];
  readonly sourceRoots?: readonly string[];
  readonly [key: string]: unknown;
}

export type PieceWorkspaceAnalyzeFile = (options: PieceWorkspaceAnalyzeFileOptions) => Promise<PieceFileAnalysis>;

export interface AnalyzePieceWorkspaceOptions {
  readonly workspaceRoot: string;
  readonly cwd?: string;
  readonly projects: readonly PieceWorkspaceProjectOptions[];
  readonly analyzeFile?: PieceWorkspaceAnalyzeFile;
}

export interface PieceWorkspaceReason {
  readonly code: string;
  readonly severity: "warning" | "error" | (string & {});
  readonly message: string;
  readonly filePath?: string;
  readonly target?: string;
  readonly [key: string]: unknown;
}

export interface PieceWorkspaceAnalyzedFile {
  readonly filePath: string;
  readonly language: Exclude<PieceWorkspaceLanguage, "auto">;
  readonly status: "analyzed";
  readonly analysis: PieceFileAnalysis;
  readonly diagnostics: readonly [];
}

export interface PieceWorkspaceFailedFile {
  readonly filePath: string;
  readonly language: Exclude<PieceWorkspaceLanguage, "auto">;
  readonly status: "error";
  readonly diagnostics: readonly PieceWorkspaceReason[];
}

export type PieceWorkspaceFile = PieceWorkspaceAnalyzedFile | PieceWorkspaceFailedFile;

export interface PieceWorkspaceProject {
  readonly id: string;
  /** Canonical, workspace-contained project root chosen by analysis. */
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly sourceFiles: readonly string[];
  readonly language: PieceWorkspaceLanguage;
  readonly dependsOn: readonly string[];
  readonly fallback?: PieceWorkspaceFallbackConfig;
  readonly files: readonly PieceWorkspaceFile[];
  readonly fallbackReasons: readonly PieceWorkspaceReason[];
  readonly metrics: {
    readonly sourceFileCount: number;
    readonly analyzedFileCount: number;
    readonly analysisErrorCount: number;
    readonly sliceCount: number;
  };
}

export interface PieceWorkspaceProjectGraphNode {
  readonly id: string;
  readonly root: string;
  readonly language: PieceWorkspaceLanguage;
}

export interface PieceWorkspaceProjectGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "declared" | "resolved-source" | (string & {});
  readonly sourceFile?: string;
  readonly targetFile?: string;
  readonly symbols?: readonly string[];
}

export interface PieceWorkspaceProjectGraph {
  readonly version: 1;
  readonly kind: "piece-workspace-project-graph";
  readonly nodes: readonly PieceWorkspaceProjectGraphNode[];
  readonly edges: readonly PieceWorkspaceProjectGraphEdge[];
  readonly sourceOwners: readonly { readonly filePath: string; readonly projectId: string }[];
  readonly fallbackReasons: Readonly<Record<string, readonly PieceWorkspaceReason[]>>;
}

export interface PieceWorkspaceAnalysis {
  readonly version: 1;
  readonly kind: "piece-workspace";
  readonly workspaceRoot: string;
  readonly workspaceRootAliases: readonly string[];
  readonly projects: readonly PieceWorkspaceProject[];
  readonly projectGraph: PieceWorkspaceProjectGraph;
  readonly metrics: {
    readonly projectCount: number;
    readonly sourceFileCount: number;
    readonly analyzedFileCount: number;
    readonly analysisErrorCount: number;
  };
}

export interface PlanPieceWorkspaceBuildOptions {
  readonly projectIds?: readonly string[];
  readonly changedFiles?: readonly string[];
}

export interface PieceWorkspaceBuildAction {
  readonly id: string;
  readonly kind: "project-fallback";
  readonly projectId: string;
  readonly projectRoot: string;
  readonly language: PieceWorkspaceLanguage;
  readonly dependsOn: readonly string[];
  readonly fallback?: PieceWorkspaceFallbackConfig;
  readonly cache: {
    readonly status: "bypass";
    readonly reason: "workspace-project-fallback-cache-not-enabled" | (string & {});
  };
  readonly reasons: readonly PieceWorkspaceReason[];
  readonly scheduling: "topological" | "cycle-fallback";
}

export interface PieceWorkspaceBuildBatch {
  readonly index: number;
  readonly kind: "topological" | "cycle-fallback";
  readonly parallelSafe: boolean;
  readonly actions: readonly PieceWorkspaceBuildAction[];
}

export interface PieceWorkspaceBuildPlan {
  readonly version: 1;
  readonly kind: "piece-workspace-build-plan";
  readonly workspaceRoot: string;
  readonly executionMode: "project-fallback";
  readonly status: "ready" | "fallback";
  readonly selectedProjects: readonly string[];
  readonly projectEdges: readonly PieceWorkspaceProjectGraphEdge[];
  readonly actions: readonly PieceWorkspaceBuildAction[];
  readonly batches: readonly PieceWorkspaceBuildBatch[];
  readonly diagnostics: readonly (PieceWorkspaceReason & { readonly projectId: string })[];
}

export type PieceWorkspaceCompilerDefaults = Omit<AnalyzePieceWorkspaceOptions, "workspaceRoot" | "projects"> &
  Partial<Pick<AnalyzePieceWorkspaceOptions, "workspaceRoot" | "projects">>;

export interface PieceWorkspaceCompiler {
  /** Runtime validation still requires workspaceRoot and projects after defaults are merged. */
  analyze(options?: PieceWorkspaceCompilerDefaults): Promise<PieceWorkspaceAnalysis>;
  plan(workspace: PieceWorkspaceAnalysis, options?: PlanPieceWorkspaceBuildOptions): PieceWorkspaceBuildPlan;
}

export function analyzePieceWorkspace(options: AnalyzePieceWorkspaceOptions): Promise<PieceWorkspaceAnalysis>;
export function planPieceWorkspaceBuild(workspace: PieceWorkspaceAnalysis, options?: PlanPieceWorkspaceBuildOptions): PieceWorkspaceBuildPlan;
export function createPieceWorkspaceCompiler(defaultOptions?: PieceWorkspaceCompilerDefaults): PieceWorkspaceCompiler;

export type PieceFallbackProfile = "go" | "gradle" | "typescript";
/** Distinct from the core PieceFallbackMode used by virtual preview closures. */
export type PieceFallbackExecutorMode = "plan" | "execute";
export type PieceFallbackLevel = "auto" | "project";

export interface PieceFallbackReason {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
}

export interface PieceFallbackAnalysisInput {
  readonly feedbackScope?: {
    readonly level?: string;
    readonly fallbackRequired?: boolean;
    readonly reasons?: readonly PieceFallbackReason[];
  };
}

export interface PieceFallbackRequest {
  readonly mode?: PieceFallbackExecutorMode;
  /** `project` explicitly requests the native project action even when Piece is locally safe. */
  readonly level?: PieceFallbackLevel;
  readonly profile: PieceFallbackProfile;
  readonly action?: "test" | "build";
  readonly task?: string;
  readonly script?: string;
}

export interface GoPieceFallbackProfilePolicy {
  readonly root: string;
  readonly allowActions: readonly ("test" | "build")[];
  readonly command?: "go";
}

export interface GradlePieceFallbackProfilePolicy {
  readonly root: string;
  readonly allowTasks: readonly string[];
  readonly command?: "./gradlew" | "./gradlew.bat";
}

export interface TypeScriptPieceFallbackProfilePolicy {
  readonly root: string;
  readonly allowScripts: readonly string[];
  readonly packageManager?: "npm" | "pnpm" | "yarn";
}

export interface PieceFallbackPolicy {
  readonly profiles: {
    readonly go?: GoPieceFallbackProfilePolicy;
    readonly gradle?: GradlePieceFallbackProfilePolicy;
    readonly typescript?: TypeScriptPieceFallbackProfilePolicy;
  };
  readonly envAllowlist?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
}

export interface PieceFallbackExecutorOptions {
  readonly workspaceRoot: string;
  readonly analysis?: PieceFallbackAnalysisInput;
  readonly request: PieceFallbackRequest;
  readonly policy: PieceFallbackPolicy;
  readonly signal?: AbortSignal;
}

export interface PieceFallbackScope {
  readonly level: string;
  readonly fallbackRequired: boolean;
  readonly reasons: readonly PieceFallbackReason[];
}

export interface PieceFallbackDiagnostic {
  readonly code: string;
  readonly severity: "error";
  readonly message: string;
  readonly [key: string]: unknown;
}

export interface PieceFallbackPlan {
  readonly profile: PieceFallbackProfile;
  readonly level: PieceFallbackLevel;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly markers: readonly string[];
  readonly environment: {
    readonly inheritProcessEnv: false;
    readonly envAllowlist: readonly string[];
  };
}

export interface PieceFallbackBlockedResult {
  readonly version: 1;
  readonly status: "blocked";
  readonly mode: PieceFallbackExecutorMode;
  readonly profile?: PieceFallbackProfile;
  readonly scope: PieceFallbackScope;
  readonly diagnostics: readonly PieceFallbackDiagnostic[];
}

export interface PieceFallbackPlannedResult {
  readonly version: 1;
  readonly status: "planned";
  readonly mode: PieceFallbackExecutorMode;
  readonly profile: PieceFallbackProfile;
  readonly scope: PieceFallbackScope;
  readonly plan: PieceFallbackPlan;
  readonly diagnostics: readonly [];
}

export interface PieceFallbackExecutionResult {
  readonly version: 1;
  readonly status: "success" | "error";
  readonly mode: "execute";
  readonly profile: PieceFallbackProfile;
  readonly scope: PieceFallbackScope;
  readonly plan: PieceFallbackPlan;
  readonly command: PieceCompilerCommandResult;
  readonly diagnostics: readonly PieceFallbackDiagnostic[];
}

export type PieceFallbackResult = PieceFallbackBlockedResult | PieceFallbackPlannedResult | PieceFallbackExecutionResult;

export const PIECE_FALLBACK_EXECUTOR_VERSION: 1;
export const PIECE_FALLBACK_PROFILES: readonly PieceFallbackProfile[];
export const PIECE_FALLBACK_MODES: readonly PieceFallbackExecutorMode[];

export function planPieceFallback(options: PieceFallbackExecutorOptions): Promise<PieceFallbackResult>;
export function executePieceFallback(options: PieceFallbackExecutorOptions): Promise<PieceFallbackResult>;
