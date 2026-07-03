package piece.extract

import piece.model.PiecePackage
import piece.model.PieceSourceRange

data class SourceFile(
    val filePath: String,
    val source: String,
)

data class DeclarationSymbol(
    val name: String,
    val range: PieceSourceRange,
    val references: List<String> = emptyList(),
    val typeReferences: List<String> = emptyList(),
)

interface DeclarationExtractor {
    val name: String

    fun extract(file: SourceFile): PiecePackage
}
