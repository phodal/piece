package piece.pic

data class PicDocument(
    val packageLabel: String,
    val language: String,
    val source: String,
    val targets: List<PicTarget>,
)

data class PicTarget(
    val kind: PicTargetKind,
    val name: String,
    val deps: List<String> = emptyList(),
    val runtimeDeps: List<String> = emptyList(),
    val typeDeps: List<String> = emptyList(),
    val externalDeps: List<String> = emptyList(),
    val actions: List<PicAction> = emptyList(),
)

data class PicAction(
    val kind: PicActionKind,
    val mnemonic: String? = null,
    val output: String? = null,
    val path: String? = null,
)

enum class PicTargetKind {
    Type,
    Class,
    Function,
    Value,
    Effect,
    Header,
}

enum class PicActionKind {
    Feedback,
    Compile,
    Preview,
    Test,
    Typecheck,
    Documentation,
}

data class PicDiagnostic(
    val code: String,
    val severity: String,
    val message: String,
    val line: Int? = null,
    val column: Int? = null,
)

data class PicParseResult(
    val document: PicDocument?,
    val piecePackage: piece.model.PiecePackage?,
    val diagnostics: List<PicDiagnostic> = emptyList(),
)
