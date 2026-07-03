package piece.kotlin

import piece.extract.DeclarationExtractor
import piece.extract.SourceFile
import piece.model.PiecePackage

class KotlinPsiDeclarationExtractor : DeclarationExtractor {
    override val name: String = "kotlin-psi-declaration-extractor"

    override fun extract(file: SourceFile): PiecePackage {
        throw UnsupportedOperationException(
            "Kotlin PSI extraction belongs in the JVM adapter and will use Kotlin PSI or Analysis API in the next implementation slice.",
        )
    }
}
