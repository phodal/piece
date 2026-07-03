package piece.bridge

import piece.dsl.pieceFile
import piece.model.PiecePackage

object NpmBridge {
    fun sampleKotlinPackage(filePath: String = "Pricing.kt"): PiecePackage {
        return pieceFile(filePath) {
            language = kotlin()
            target("renderGreeting") {
                rule = function()
                deps(":User", ":Greeting", ":prefix")
                action(feedback("analysis"))
            }
        }
    }
}
