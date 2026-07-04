export * from "./index.js";
import type { PieceBuildEngine, VirtualFileSystem } from "./index.js";
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
