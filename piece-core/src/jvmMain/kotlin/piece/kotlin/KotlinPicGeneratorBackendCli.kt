package piece.kotlin

import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.system.exitProcess
import piece.extract.SourceFile
import piece.model.PieceAction
import piece.model.PieceArtifact
import piece.model.PiecePackage
import piece.model.PieceRule
import piece.model.PieceTarget
import piece.pic.piecePackageToPicDsl

fun main(args: Array<String>) {
    val options = args.mapNotNull { arg ->
        if (!arg.startsWith("--")) return@mapNotNull null
        val index = arg.indexOf('=')
        if (index < 0) return@mapNotNull arg.drop(2) to ""
        arg.substring(2, index) to arg.substring(index + 1)
    }.toMap()

    val sourceFile = options.required("sourceFile")
    val outputReport = Path.of(options.required("outputReport"))
    val filePath = options["filePath"]?.takeIf { it.isNotBlank() } ?: "Main.kt"
    val source = Path.of(sourceFile).readText()
    val requestedBackend = options["backend"]
        ?.takeIf { it.isNotBlank() }
        ?.let(KotlinAnalysisBackendKind::fromWireName)
        ?: KotlinAnalysisBackendKind.Psi
    val analysisBackend = kotlinPsiGenerationBackendMetadata(requestedBackend)
    val backendDiagnostics = if (analysisBackend.status == "fallback") {
        listOf(
            PicGenerationDiagnostic(
                code = "kotlin-pic-backend-fallback",
                severity = "warning",
                message = analysisBackend.fallbackReason ?: "Kotlin .pic generation backend fallback was used.",
            ),
        )
    } else {
        emptyList()
    }

    var hasErrors = false
    val report = try {
        val piecePackage = KotlinPsiDeclarationExtractor().extract(SourceFile(filePath = filePath, source = source))
        picGenerationReport(
            filePath = filePath,
            source = source,
            piecePackage = piecePackage,
            pic = piecePackageToPicDsl(piecePackage),
            diagnostics = backendDiagnostics,
            analysisBackend = analysisBackend,
        )
    } catch (error: Throwable) {
        hasErrors = true
        picGenerationReport(
            filePath = filePath,
            source = source,
            piecePackage = null,
            pic = "",
            diagnostics = backendDiagnostics + listOf(
                PicGenerationDiagnostic(
                    code = "kotlin-pic-generation-error",
                    severity = "error",
                    message = error.message ?: error::class.java.name,
                ),
            ),
            analysisBackend = analysisBackend,
        )
    }

    outputReport.parent?.createDirectories()
    outputReport.writeText(report + "\n")
    if (hasErrors) {
        exitProcess(1)
    }
}

private data class PicGenerationDiagnostic(
    val code: String,
    val severity: String,
    val message: String,
)

private fun Map<String, String>.required(name: String): String {
    return this[name]?.takeIf { it.isNotBlank() } ?: error("Missing --$name=<value>")
}

private fun picGenerationReport(
    filePath: String,
    source: String,
    piecePackage: PiecePackage?,
    pic: String,
    diagnostics: List<PicGenerationDiagnostic>,
    analysisBackend: KotlinAnalysisBackendMetadata,
): String = buildPicJsonObject {
    field("version", 1)
    field("generator", "kotlin-psi-pic-generator")
    field("filePath", filePath)
    field("source", source)
    field("pic", pic)
    rawField("piecePackage", piecePackage?.toJson() ?: "null")
    field("diagnostics", diagnostics) { it.toJson() }
    rawField("analysisBackend", analysisBackend.toJson())
}

private fun PiecePackage.toJson(): String = buildPicJsonObject {
    field("version", version)
    field("kind", kind)
    field("language", language)
    field("packageName", packageName)
    field("label", label)
    field("filePath", filePath)
    field("sourceFile", sourceFile)
    field("rules", rules) { it.toJson() }
    field("targets", targets) { it.toJson() }
    field("actions", actions) { it.toJson() }
    field("artifacts", artifacts) { it.toJson() }
}

private fun PieceRule.toJson(): String = buildPicJsonObject {
    field("name", name)
    field("language", language)
    field("targetKind", targetKind.name.lowercase())
    field("actionKind", actionKind.name.lowercase())
    field("implementation", implementation)
}

private fun PieceTarget.toJson(): String = buildPicJsonObject {
    field("id", id)
    field("label", label)
    field("name", name)
    field("kind", kind.name.lowercase())
    field("rule", rule)
    field("source", source)
    field("deps", deps)
    field("runtimeDeps", runtimeDeps)
    field("typeDeps", typeDeps)
    field("externalDeps", externalDeps)
    field("actions", actions)
    field("artifacts", artifacts)
    field("visibility", visibility)
}

private fun PieceAction.toJson(): String = buildPicJsonObject {
    field("id", id)
    field("target", target)
    field("kind", kind.name.lowercase())
    field("mnemonic", mnemonic)
    field("inputs", inputs)
    field("outputs", outputs)
}

private fun PieceArtifact.toJson(): String = buildPicJsonObject {
    field("id", id)
    field("target", target)
    field("kind", kind)
    field("path", path)
    cacheKey?.let { field("cacheKey", it) }
}

private fun PicGenerationDiagnostic.toJson(): String = buildPicJsonObject {
    field("code", code)
    field("severity", severity)
    field("message", message)
}

private fun KotlinAnalysisBackendMetadata.toJson(): String = buildPicJsonObject {
    field("requested", requested)
    field("actual", actual)
    field("declarations", declarations)
    field("symbols", symbols)
    field("diagnostics", diagnostics)
    field("status", status)
    fallbackReason?.let { field("fallbackReason", it) }
}

private class PicJsonObjectBuilder {
    private val fields = mutableListOf<String>()

    fun field(name: String, value: String) {
        fields += "${name.picJsonString()}:${value.picJsonString()}"
    }

    fun field(name: String, value: Number) {
        fields += "${name.picJsonString()}:$value"
    }

    fun rawField(name: String, json: String) {
        fields += "${name.picJsonString()}:$json"
    }

    fun field(name: String, values: List<String>) {
        fields += "${name.picJsonString()}:${values.joinToString(prefix = "[", postfix = "]") { it.picJsonString() }}"
    }

    fun <T> field(name: String, values: List<T>, encode: (T) -> String) {
        fields += "${name.picJsonString()}:${values.joinToString(prefix = "[", postfix = "]") { encode(it) }}"
    }

    fun build(): String = fields.joinToString(prefix = "{", postfix = "}")
}

private fun buildPicJsonObject(init: PicJsonObjectBuilder.() -> Unit): String {
    return PicJsonObjectBuilder().apply(init).build()
}

private fun String.picJsonString(): String {
    val builder = StringBuilder(length + 2)
    builder.append('"')
    for (char in this) {
        when (char) {
            '\\' -> builder.append("\\\\")
            '"' -> builder.append("\\\"")
            '\b' -> builder.append("\\b")
            '\u000C' -> builder.append("\\f")
            '\n' -> builder.append("\\n")
            '\r' -> builder.append("\\r")
            '\t' -> builder.append("\\t")
            else -> {
                if (char.code < 0x20) {
                    builder.append("\\u")
                    builder.append(char.code.toString(16).padStart(4, '0'))
                } else {
                    builder.append(char)
                }
            }
        }
    }
    builder.append('"')
    return builder.toString()
}
