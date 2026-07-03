package piece.bridge

import kotlin.js.ExperimentalJsExport
import kotlin.js.JsExport
import piece.dsl.pieceFile

fun main() = Unit

@OptIn(ExperimentalJsExport::class)
@JsExport
fun sampleWasmPackageLabel(filePath: String = "/repo/src/Pricing.kt"): String {
    return pieceFile(filePath) {
        language = kotlin()
        target("renderGreeting") {
            rule = function()
            deps(":User", ":Greeting", ":prefix")
            action(feedback("analysis"))
        }
    }.label
}
