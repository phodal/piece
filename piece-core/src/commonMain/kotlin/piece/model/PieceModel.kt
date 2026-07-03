package piece.model

data class PieceSourceRange(
    val startByte: Int,
    val endByte: Int,
    val startLine: Int,
    val endLine: Int,
)

enum class PieceTargetKind {
    Type,
    Class,
    Function,
    Value,
    Effect,
    Header,
}

enum class PieceEdgeKind {
    Runtime,
    Type,
    External,
    Unknown,
}

enum class PieceActionKind {
    Feedback,
    Compile,
    Preview,
    Test,
    Typecheck,
    Documentation,
}

data class PieceRule(
    val name: String,
    val language: String,
    val targetKind: PieceTargetKind,
    val actionKind: PieceActionKind = PieceActionKind.Feedback,
    val implementation: String = "$language.${targetKind.name.lowercase()}.feedback",
)

data class PieceAction(
    val id: String,
    val target: String,
    val kind: PieceActionKind,
    val mnemonic: String = "Piece${kind.name.lowercase().replaceFirstChar { it.uppercase() }}",
    val inputs: List<String> = emptyList(),
    val outputs: List<String> = emptyList(),
)

data class PieceArtifact(
    val id: String,
    val target: String,
    val kind: String,
    val path: String,
    val cacheKey: String? = null,
)

data class PieceTarget(
    val id: String,
    val label: String,
    val name: String,
    val kind: PieceTargetKind,
    val rule: String,
    val source: String,
    val deps: List<String> = emptyList(),
    val runtimeDeps: List<String> = emptyList(),
    val typeDeps: List<String> = emptyList(),
    val externalDeps: List<String> = emptyList(),
    val actions: List<String> = emptyList(),
    val artifacts: List<String> = emptyList(),
    val visibility: List<String> = listOf("//visibility:private"),
)

data class PiecePackage(
    val version: Int = 1,
    val kind: String = "single-file-package",
    val language: String,
    val packageName: String,
    val label: String,
    val filePath: String,
    val sourceFile: String = label,
    val rules: List<PieceRule> = emptyList(),
    val targets: List<PieceTarget> = emptyList(),
    val actions: List<PieceAction> = emptyList(),
    val artifacts: List<PieceArtifact> = emptyList(),
)

data class PieceGraphEdge(
    val from: String,
    val to: String,
    val kind: PieceEdgeKind,
    val symbols: List<String> = emptyList(),
)

data class PieceGraph(
    val packageLabel: String,
    val targets: List<PieceTarget>,
    val edges: List<PieceGraphEdge>,
)

data class PieceSnapshotTarget(
    val label: String,
    val rule: String,
    val depsHash: String,
    val publicShapeHash: String,
    val implementationHash: String,
)

data class PieceSnapshot(
    val packageLabel: String,
    val sourceHash: String,
    val targets: Map<String, PieceSnapshotTarget>,
    val artifacts: Map<String, PieceArtifact> = emptyMap(),
)

data class PieceReconcileResult(
    val changedTargets: List<String>,
    val dirtyTargets: List<String>,
    val reusedArtifacts: List<String>,
    val invalidatedArtifacts: List<String>,
)
