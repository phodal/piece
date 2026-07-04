export const PIECE_COMPILER_NAME: "piece-compiler";
export const PIECE_COMPILER_VERSION: 1;
export const PIECE_PREVIEW_PROTOCOL_VERSION: 1;
export const PIECE_PREVIEW_PROTOCOLS: readonly ["PreviewBuild", "PreviewUpdate"];

export type PieceBuildMode = "pure-slice" | "wrapper" | "whole-file" | (string & {});

export interface VirtualFileSystem {
  readonly kind?: string;
  readonly cwd?: string;
  toAbsolutePath?(path: string): string;
  relativePath?(path: string): string;
  readText(path: string): Promise<string> | string;
  writeText?(path: string, contents: string): Promise<void> | void;
  collectSourceFiles?(sourceRoots: readonly string[]): Promise<readonly string[]> | readonly string[];
}

export interface PieceBuildOutputFile {
  readonly path: string;
  readonly text?: string;
  readonly contents?: Uint8Array;
}

export interface PieceBuildEngine {
  readonly name?: string;
  build(options: Record<string, unknown>): Promise<{
    readonly outputFiles?: readonly PieceBuildOutputFile[];
    readonly metafile?: unknown;
  }>;
  transform?(source: string, options: Record<string, unknown>): Promise<{ readonly code?: string; readonly map?: string }>;
}

export interface PiecePreviewTarget {
  readonly id: string;
  readonly name?: string;
  readonly sourcePath?: string;
  readonly exportName?: string;
  readonly kind?: string;
  readonly props?: Record<string, unknown>;
}

export interface PiecePreviewOptions {
  readonly target?: string | PiecePreviewTarget;
  readonly targets?: readonly (string | PiecePreviewTarget)[];
  readonly props?: Record<string, unknown>;
}

export interface PieceCompileOptions {
  readonly id?: string;
  readonly name?: string;
  readonly mode?: string;
  readonly buildMode?: PieceBuildMode;
  readonly target?: string | PiecePreviewTarget;
  readonly targets?: readonly (string | PiecePreviewTarget)[];
  readonly props?: Record<string, unknown>;
  readonly preview?: PiecePreviewOptions;
  readonly metadata?: Record<string, unknown>;
}

export interface CompilePieceAppOptions {
  readonly name?: string;
  readonly cwd?: string;
  readonly entry?: string;
  readonly filePath?: string;
  readonly source?: string;
  readonly sourceRoots?: readonly string[];
  readonly sourceFiles?: readonly string[];
  readonly fileSystem?: VirtualFileSystem;
  readonly previousTree?: unknown;
  readonly declarationExtractor?: PieceDeclarationExtractor;
  readonly globals?: readonly string[];
  readonly buildEngine?: PieceBuildEngine;
  readonly compileStrategy?: "build" | "transform";
  readonly target?: string;
  readonly cursorByte?: number;
  readonly targetEnvironment?: string;
  readonly external?: readonly string[];
  readonly plugins?: readonly unknown[];
  readonly piece?: PieceCompileOptions;
  readonly preview?: PiecePreviewOptions;
}

export type PieceCompilerOptions = Partial<CompilePieceAppOptions>;

export interface NormalizedPieceAppInput {
  readonly version: 1;
  readonly compiler: "piece-compiler";
  readonly name: string;
  readonly cwd: string;
  readonly entry: string;
  readonly filePath: string;
  readonly source: string;
  readonly sourceRoots: readonly string[];
  readonly sourceFiles: readonly string[];
  readonly sourceFileCount: number;
  readonly fileSystem?: VirtualFileSystem;
}

export interface PieceStatus {
  readonly version: 1;
  readonly previewProtocolVersion: 1;
  readonly protocols: readonly ["PreviewBuild", "PreviewUpdate"];
  readonly mode: string;
  readonly buildMode: PieceBuildMode;
  readonly target: PiecePreviewTarget | null;
  readonly targets: readonly PiecePreviewTarget[];
  readonly props?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly sourceRoots: readonly string[];
  readonly sourceFileCount: number;
  readonly changedPieces: readonly string[];
  readonly affectedTargets: readonly string[];
  readonly diagnostics: {
    readonly issueCount: number;
  };
}

export interface CompilePieceAppStatus {
  readonly version: 1;
  readonly compiler: "piece-compiler";
  readonly name: string;
  readonly cwd: string;
  readonly entry: string;
  readonly filePath: string;
  readonly sourceRoots: readonly string[];
  readonly sourceFiles: readonly string[];
  readonly sourceFileCount: number;
  readonly diagnostics: {
    readonly issueCount: number;
  };
  readonly piece: PieceStatus;
  readonly analysis?: PieceFileAnalysis;
  readonly preview?: PiecePreviewBuild;
}

export interface PieceCompiler {
  normalize(options: CompilePieceAppOptions): Promise<NormalizedPieceAppInput>;
  compile(options: CompilePieceAppOptions): Promise<CompilePieceAppStatus>;
  analyzeFile(options: AnalyzePieceFileOptions): Promise<PieceFileAnalysis>;
  selectPreviewTarget(analysis: PieceFileAnalysis, options?: SelectPiecePreviewTargetOptions): string | undefined;
  buildPreview(options: BuildPiecePreviewOptions): Promise<PiecePreviewBuild>;
  applyEdit(options: ApplyPieceEditOptions): Promise<PieceEditResult>;
  rebuildAffectedPreviews(options: RebuildAffectedPiecePreviewsOptions): Promise<PiecePreviewUpdateResult>;
}

export type PieceSliceKind = "type" | "class" | "function" | "value" | "effect" | "header";
export type PieceEdgeKind = "runtime" | "type" | "external" | "unknown";
export type PieceFallbackMode = "none" | "include-effect-segment" | "whole-file";

export interface PieceRule {
  readonly name: string;
  readonly language: string;
  readonly targetKind: PieceSliceKind;
  readonly actionKind: string;
  readonly implementation: string;
}

export interface PieceAction {
  readonly id: string;
  readonly target: string;
  readonly kind: string;
  readonly mnemonic: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

export interface PieceArtifact {
  readonly id: string;
  readonly target: string;
  readonly kind: string;
  readonly path: string;
}

export interface PiecePackageTarget {
  readonly id: string;
  readonly label: string;
  readonly name?: string;
  readonly kind: PieceSliceKind;
  readonly rule: string;
  readonly source: string;
  readonly deps: readonly string[];
  readonly runtimeDeps: readonly string[];
  readonly typeDeps: readonly string[];
  readonly externalDeps: readonly string[];
  readonly actions: readonly string[];
  readonly artifacts: readonly string[];
  readonly visibility: readonly string[];
}

export interface SingleFilePiecePackage {
  readonly version: 1;
  readonly kind: "single-file-package";
  readonly language: string;
  readonly packageName: string;
  readonly label: string;
  readonly filePath: string;
  readonly sourceFile: string;
  readonly rules: readonly PieceRule[];
  readonly targets: readonly PiecePackageTarget[];
  readonly actions: readonly PieceAction[];
  readonly artifacts: readonly PieceArtifact[];
}

export interface PieceGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: PieceEdgeKind;
  readonly symbols: readonly string[];
}

export interface PieceGraph {
  readonly packageLabel: string;
  readonly targets: readonly PiecePackageTarget[];
  readonly edges: readonly PieceGraphEdge[];
}

export interface KotlinCoreBridgeTargetSpec {
  readonly kind: PieceSliceKind;
  readonly name: string;
  readonly deps?: readonly string[];
  readonly action?: string;
  readonly actionKind?: "feedback" | "compile" | "preview" | "test" | "typecheck" | "documentation";
}

export interface KotlinCoreBridge {
  createPackageFromTargets(options: {
    readonly filePath: string;
    readonly language?: string;
    readonly targets: readonly KotlinCoreBridgeTargetSpec[];
  }): SingleFilePiecePackage;
  createGraphFromTargets(options: {
    readonly filePath: string;
    readonly language?: string;
    readonly targets: readonly KotlinCoreBridgeTargetSpec[];
  }): PieceGraph;
  sampleKotlinPackage(options?: { readonly filePath?: string }): SingleFilePiecePackage;
}

export function createKotlinCoreBridge(kotlinCoreModule: unknown): KotlinCoreBridge;

export interface PieceSourceRange {
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine: number;
  readonly endLine: number;
}

export interface PieceSlice {
  readonly id: string;
  readonly filePath: string;
  readonly kind: PieceSliceKind;
  readonly name?: string;
  readonly exportName?: string;
  readonly isDefaultExport?: boolean;
  readonly range: PieceSourceRange;
  readonly source: string;
  readonly symbols: {
    readonly defines: readonly string[];
    readonly references: readonly string[];
    readonly typeReferences: readonly string[];
    readonly jsxReferences: readonly string[];
  };
  readonly preview: {
    readonly previewable: boolean;
    readonly reason?: string;
  };
  readonly hashes: {
    readonly bodyHash: string;
    readonly signatureHash: string;
    readonly typeHash?: string;
  };
  readonly safety: {
    readonly hasTopLevelSideEffect: boolean;
    readonly hasDynamicImport: boolean;
    readonly hasUnknownGlobal: boolean;
    readonly fallbackRequired: boolean;
  };
}

export interface PieceImportBinding {
  readonly local: string;
  readonly imported: string;
  readonly source: string;
  readonly kind: "default" | "namespace" | "named";
  readonly isTypeOnly: boolean;
}

export interface PieceHeaderSegment {
  readonly id: string;
  readonly filePath: string;
  readonly kind: "header";
  readonly range: PieceSourceRange;
  readonly source: string;
  readonly importBindings: readonly PieceImportBinding[];
}

export interface PieceEffectSegment {
  readonly id: string;
  readonly filePath: string;
  readonly kind: "effect";
  readonly range: PieceSourceRange;
  readonly source: string;
  readonly hashes: {
    readonly bodyHash: string;
  };
  readonly safety: PieceSlice["safety"];
}

export interface PieceDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly [key: string]: unknown;
}

export interface PieceFileManifest {
  readonly version: 1;
  readonly filePath: string;
  readonly source: string;
  readonly parser: string;
  readonly slices: readonly PieceSlice[];
  readonly headers: readonly PieceHeaderSegment[];
  readonly effects: readonly PieceEffectSegment[];
  readonly importBindings: readonly PieceImportBinding[];
  readonly hasTopLevelEffect: boolean;
  readonly diagnostics: readonly PieceDiagnostic[];
}

export interface PieceSliceEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: PieceEdgeKind;
  readonly symbols: readonly string[];
  readonly import?: PieceImportBinding;
}

export interface PieceSliceGraph {
  readonly version: 1;
  readonly filePath: string;
  readonly slices: readonly PieceSlice[];
  readonly edges: readonly PieceSliceEdge[];
  readonly symbolTable: {
    readonly local: Record<string, string>;
    readonly imports: Record<string, PieceImportBinding>;
    readonly exports: Record<string, string>;
    readonly defaultExport?: string;
  };
  readonly diagnostics: readonly PieceDiagnostic[];
}

export interface PieceClosure {
  readonly version: 1;
  readonly target: string;
  readonly targetName: string;
  readonly runtimeSlices: readonly string[];
  readonly typeSlices: readonly string[];
  readonly valueSlices: readonly string[];
  readonly externalImports: readonly PieceImportBinding[];
  readonly diagnostics: readonly PieceDiagnostic[];
  readonly fallbackMode: PieceFallbackMode;
  readonly hashes: {
    readonly runtimeClosureHash: string;
    readonly typeClosureHash: string;
    readonly fixtureHash: string;
  };
}

export interface PieceVirtualModules {
  readonly version: 1;
  readonly entryPath: string;
  readonly closurePath: string;
  readonly files: Record<string, string>;
}

export interface PieceBundleResult {
  readonly version: 1;
  readonly buildEngine?: string;
  readonly compileStrategy?: "build" | "transform";
  readonly entryPath: string;
  readonly outputFiles: readonly unknown[];
  readonly code: string;
  readonly metafile?: unknown;
}

export interface PieceFileAnalysisMetrics {
  readonly totalMs: number;
  readonly phases: {
    readonly extractMs: number;
    readonly graphMs: number;
  };
  readonly sourceBytes: number;
  readonly sliceCount: number;
  readonly edgeCount: number;
  readonly previewTargetCount: number;
  readonly incremental?: boolean;
  readonly graphUpdate?: "full" | "incremental";
}

export interface PiecePreviewBuildMetrics {
  readonly totalMs: number;
  readonly phases: {
    readonly analyzeMs: number;
    readonly targetMs: number;
    readonly closureMs: number;
    readonly virtualModulesMs: number;
    readonly bundleMs: number;
  };
  readonly sourceBytes: number;
  readonly closureBytes: number;
  readonly entryBytes: number;
  readonly bundleBytes: number;
  readonly runtimeSliceCount: number;
  readonly typeSliceCount: number;
  readonly valueSliceCount: number;
  readonly externalImportCount: number;
  readonly cache: {
    readonly status: "hit" | "miss";
    readonly runtimeBundleReused: boolean;
    readonly previousRuntimeClosureHash?: string;
    readonly runtimeClosureHash: string;
  };
}

export interface PieceFileAnalysis {
  readonly version: 1;
  readonly filePath: string;
  readonly manifest: PieceFileManifest;
  readonly graph: PieceSliceGraph;
  readonly piecePackage: SingleFilePiecePackage;
  readonly previewTargets: readonly string[];
  readonly metrics: PieceFileAnalysisMetrics;
  readonly snapshot: PieceSnapshot;
}

export interface PieceDeclarationRecord {
  readonly id: string;
  readonly filePath: string;
  readonly kind: PieceSliceKind;
  readonly name?: string;
  readonly exportName?: string;
  readonly range: PieceSourceRange;
  readonly textHash: string;
  readonly publicShapeHash: string;
  readonly deps: readonly string[];
  readonly dependencyIds: readonly string[];
  readonly directRuntimeDependencyIds: readonly string[];
  readonly directTypeDependencyIds: readonly string[];
  readonly dependencyHash: string;
  readonly artifactCacheKey: string;
}

export interface PieceSnapshotArtifact {
  readonly version: 1;
  readonly id: string;
  readonly pieceId: string;
  readonly kind: string;
  readonly cacheKey: string;
  readonly metadata?: Record<string, unknown>;
}

export interface PieceSnapshot {
  readonly version: 1;
  readonly revision: number;
  readonly filePath: string;
  readonly sourceHash: string;
  readonly headerHash: string;
  readonly effectHash: string;
  readonly declarations: Record<string, PieceDeclarationRecord>;
  readonly graph: PieceSliceGraph;
  readonly previewTargets: readonly string[];
  readonly artifacts: Record<string, PieceSnapshotArtifact>;
}

export interface CreatePieceSnapshotOptions {
  readonly analysis: PieceFileAnalysis;
  readonly artifacts?: ReadonlyMap<string, PieceSnapshotArtifact> | Record<string, PieceSnapshotArtifact> | readonly PieceSnapshotArtifact[];
  readonly version?: number;
  readonly compilerOptionsHash?: string;
}

export interface ReconcilePieceSnapshotOptions {
  readonly previousSnapshot?: PieceSnapshot;
  readonly analysis: PieceFileAnalysis;
  readonly changedRanges?: readonly PieceSourceRange[];
  readonly artifacts?: ReadonlyMap<string, PieceSnapshotArtifact> | Record<string, PieceSnapshotArtifact> | readonly PieceSnapshotArtifact[];
  readonly compilerOptionsHash?: string;
}

export interface PieceReconcileResult {
  readonly version: 1;
  readonly previousRevision: number;
  readonly nextRevision: number;
  readonly snapshot: PieceSnapshot;
  readonly touchedPieces: readonly string[];
  readonly changedPieces: readonly string[];
  readonly publicShapeChangedPieces: readonly string[];
  readonly dirtyPieces: readonly string[];
  readonly affectedTargets: readonly string[];
  readonly reusedArtifactIds: readonly string[];
  readonly invalidatedArtifactIds: readonly string[];
  readonly changedHeaders: boolean;
  readonly changedEffects: boolean;
}

export interface PieceDeclarationExtractor {
  readonly name: string;
  extract(options: { readonly filePath: string; readonly source: string; readonly previousTree?: unknown }): Promise<PieceFileManifest> | PieceFileManifest;
}

export interface AnalyzePieceFileOptions {
  readonly filePath: string;
  readonly source: string;
  readonly previousTree?: unknown;
  readonly declarationExtractor?: PieceDeclarationExtractor;
  readonly globals?: readonly string[];
}

export interface SelectPiecePreviewTargetOptions {
  readonly target?: string;
  readonly cursorByte?: number;
}

export interface BuildPiecePreviewOptions extends AnalyzePieceFileOptions, SelectPiecePreviewTargetOptions {
  readonly analysis?: PieceFileAnalysis;
  readonly buildEngine?: PieceBuildEngine;
  readonly compileStrategy?: "build" | "transform";
  readonly targetEnvironment?: string;
  readonly external?: readonly string[];
  readonly plugins?: readonly unknown[];
  readonly previousPreview?: PiecePreviewBuild;
  readonly reuseRuntimeBundle?: boolean;
  readonly preview?: {
    readonly propsModulePath?: string;
    readonly rootElementId?: string;
    readonly virtualFiles?: Record<string, string>;
  };
}

export interface PiecePreviewBuild {
  readonly version: 1;
  readonly target: string;
  readonly analysis: PieceFileAnalysis;
  readonly closure: PieceClosure;
  readonly virtualModules: PieceVirtualModules;
  readonly bundle?: PieceBundleResult;
  readonly metrics: PiecePreviewBuildMetrics;
}

export interface ApplyPieceEditOptions extends AnalyzePieceFileOptions {
  readonly previousAnalysis?: PieceFileAnalysis;
  readonly changedRanges?: readonly PieceSourceRange[];
}

export interface PieceEditMetrics {
  readonly totalMs: number;
  readonly phases: {
    readonly analyzeMs: number;
    readonly diffMs: number;
    readonly affectedMs: number;
  };
  readonly changedSliceCount: number;
  readonly affectedTargetCount: number;
}

export interface PieceEditResult {
  readonly version: 1;
  readonly analysis: PieceFileAnalysis;
  readonly edit: {
    readonly changedRanges: readonly PieceSourceRange[];
    readonly changedSlices: readonly string[];
    readonly changedHeaders: boolean;
    readonly changedEffects: boolean;
  };
  readonly reconciliation: PieceReconcileResult;
  readonly affectedTargets: readonly string[];
  readonly metrics: PieceEditMetrics;
}

export interface RebuildAffectedPiecePreviewsOptions extends ApplyPieceEditOptions, Omit<BuildPiecePreviewOptions, "analysis"> {
  readonly editResult?: PieceEditResult;
  readonly previousPreviews?: ReadonlyMap<string, PiecePreviewBuild> | Record<string, PiecePreviewBuild> | readonly PiecePreviewBuild[];
}

export interface PiecePreviewUpdateMetrics {
  readonly totalMs: number;
  readonly affectedTargetCount: number;
  readonly builtCount: number;
  readonly skippedCount: number;
  readonly errorCount: number;
}

export interface PiecePreviewUpdateResult {
  readonly version: 1;
  readonly editResult: PieceEditResult;
  readonly updates: readonly Array<
    | {
        readonly version: 1;
        readonly target: string;
        readonly status: "built";
        readonly preview: PiecePreviewBuild;
      }
    | {
        readonly version: 1;
        readonly target: string;
        readonly status: "runtime-skipped";
        readonly reason: "runtime-closure-cache-hit";
        readonly preview: PiecePreviewBuild;
      }
    | {
        readonly version: 1;
        readonly target: string;
        readonly status: "error";
        readonly keepLastGood: true;
        readonly diagnostics: readonly PieceDiagnostic[];
      }
  >;
  readonly metrics: PiecePreviewUpdateMetrics;
}

export function mergePieceCompilerOptions(defaultOptions?: PieceCompilerOptions, options?: PieceCompilerOptions): PieceCompilerOptions;
export function normalizePieceTarget(value: string | PiecePreviewTarget | undefined, fallbackId?: string): PiecePreviewTarget | null;
export function splitPieceCompilerOptions(options?: PieceCompilerOptions): {
  readonly compileOptions: CompilePieceAppOptions;
  readonly piece: PieceCompileOptions & {
    readonly target: PiecePreviewTarget | null;
    readonly targets: readonly PiecePreviewTarget[];
  };
};
export function createPieceCompileStatus(
  input: NormalizedPieceAppInput,
  context?: {
    readonly piece?: PieceCompileOptions;
    readonly analysis?: PieceFileAnalysis;
    readonly preview?: PiecePreviewBuild;
  }
): CompilePieceAppStatus;
export function createPieceStatus(
  input: NormalizedPieceAppInput,
  piece?: PieceCompileOptions,
  analysis?: PieceFileAnalysis,
  preview?: PiecePreviewBuild
): PieceStatus;
export function normalizePieceAppInput(options: CompilePieceAppOptions, fileSystem?: VirtualFileSystem): Promise<NormalizedPieceAppInput>;
export function compilePieceApp(options: CompilePieceAppOptions): Promise<CompilePieceAppStatus>;
export function createPieceCompiler(defaultOptions?: PieceCompilerOptions): PieceCompiler;
export function setDefaultDeclarationExtractorResolver(resolver: (filePath: string) => PieceDeclarationExtractor | Promise<PieceDeclarationExtractor>): void;
export function resolveDefaultDeclarationExtractor(filePath: string): Promise<PieceDeclarationExtractor>;
export function createDefaultDeclarationExtractorForFile(filePath: string): Promise<PieceDeclarationExtractor>;
export function createSingleFilePiecePackage(options: {
  readonly filePath: string;
  readonly manifest: PieceFileManifest;
  readonly graph: PieceSliceGraph;
}): SingleFilePiecePackage;
export function createTreeSitterDeclarationExtractor(options?: { readonly name?: string; readonly parser?: unknown; readonly tree?: unknown }): PieceDeclarationExtractor;
export function createFallbackDeclarationExtractor(): PieceDeclarationExtractor;
export function createGoDeclarationExtractor(options?: { readonly name?: string }): PieceDeclarationExtractor;
export function createKotlinDeclarationExtractor(options?: { readonly name?: string }): PieceDeclarationExtractor;
export function createTypeScriptDeclarationExtractor(options?: { readonly name?: string }): Promise<PieceDeclarationExtractor>;
export function analyzePieceFile(options: AnalyzePieceFileOptions): Promise<PieceFileAnalysis>;
export function createPieceSnapshot(options: CreatePieceSnapshotOptions): PieceSnapshot;
export function reconcilePieceSnapshot(options: ReconcilePieceSnapshotOptions): PieceReconcileResult;
export function selectPiecePreviewTarget(analysis: PieceFileAnalysis, options?: SelectPiecePreviewTargetOptions): string | undefined;
export function buildPiecePreview(options: BuildPiecePreviewOptions): Promise<PiecePreviewBuild>;
export function applyPieceEdit(options: ApplyPieceEditOptions): Promise<PieceEditResult>;
export function rebuildAffectedPiecePreviews(options: RebuildAffectedPiecePreviewsOptions): Promise<PiecePreviewUpdateResult>;
