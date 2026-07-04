export * from "./index.js";
import type { PieceBuildEngine, PieceDeclarationExtractor, PieceFileManifest, VirtualFileSystem } from "./index.js";
export function createNodeEsbuildBuildEngine(options?: {
  readonly name?: string;
  readonly buildOptions?: Record<string, unknown>;
  readonly transformOptions?: Record<string, unknown>;
}): PieceBuildEngine;
export function createNodeVirtualFileSystem(options?: { readonly cwd?: string }): VirtualFileSystem;

export interface PieceCompilerCommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
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
  readonly language: "go" | "kotlin";
  readonly backend?: string;
  readonly filePath: string;
  readonly target: string;
  readonly status: "success" | "error";
  readonly workspace?: string;
  readonly pieceAction?: PieceCompileActionReference;
  readonly outputFiles: readonly PieceCompilerOutputFile[];
  readonly commands: readonly PieceCompilerCommandResult[];
  readonly diagnostics: readonly PieceLanguageCompileDiagnostic[];
}

export interface CompileGoPieceFileOptions {
  readonly filePath?: string;
  readonly source?: string;
  readonly workspace?: string;
  readonly outDir?: string;
  readonly keepWorkspace?: boolean;
  readonly goCommand?: string;
  readonly modulePath?: string;
  readonly runTests?: boolean;
  readonly env?: Record<string, string | undefined>;
}

export interface CompileKotlinPieceFileOptions {
  readonly filePath?: string;
  readonly source?: string;
  readonly target?: "jvm" | "js" | "wasmJs" | "all";
  readonly sourceSet?: "commonMain" | "jvmMain" | "jsMain" | "wasmJsMain" | (string & {});
  readonly workspace?: string;
  readonly keepWorkspace?: boolean;
  readonly gradleCommand?: string;
  readonly kotlinPluginVersion?: string;
  readonly tasks?: readonly string[];
  readonly sourceFiles?: readonly (KotlinAnalysisSourceFile | string)[];
  readonly sourceRoots?: readonly string[];
  readonly cwd?: string;
  readonly pieceAction?: PieceCompileActionReference;
  readonly pieceTarget?: string;
  readonly pieceActionName?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface AnalyzeKotlinPieceFileOptions {
  readonly filePath?: string;
  readonly source?: string;
  readonly sourceFiles?: readonly (KotlinAnalysisSourceFile | string)[];
  readonly sourceRoots?: readonly string[];
  readonly cwd?: string;
  readonly parserName?: string;
  readonly semanticDiagnostics?: boolean;
  readonly semanticSymbols?: boolean;
  readonly env?: Record<string, string | undefined>;
}

export interface KotlinAnalysisSourceFile {
  readonly filePath: string;
  readonly source: string;
}

export interface NodeKotlinPsiDeclarationExtractorOptions {
  readonly name?: string;
  readonly sourceFiles?: readonly (KotlinAnalysisSourceFile | string)[];
  readonly sourceRoots?: readonly string[];
  readonly cwd?: string;
  readonly semanticDiagnostics?: boolean;
  readonly semanticSymbols?: boolean;
  readonly env?: Record<string, string | undefined>;
}

export interface KotlinPieceCompileResult extends PieceLanguageCompileResult {
  readonly language: "kotlin";
  readonly backend: "kotlin-jvm";
  readonly target: "jvm" | "js" | "wasmJs" | "all";
  readonly sourceSet: string;
}

export interface GoPieceCompileResult extends PieceLanguageCompileResult {
  readonly language: "go";
  readonly target: "binary" | "package";
}

export function compileGoPieceFile(options?: CompileGoPieceFileOptions): Promise<GoPieceCompileResult>;
export function compileKotlinPieceFile(options?: CompileKotlinPieceFileOptions): Promise<KotlinPieceCompileResult>;
export function analyzeKotlinPieceFile(options?: AnalyzeKotlinPieceFileOptions): Promise<PieceFileManifest>;
export function createNodeKotlinPsiDeclarationExtractor(options?: NodeKotlinPsiDeclarationExtractorOptions): PieceDeclarationExtractor;
