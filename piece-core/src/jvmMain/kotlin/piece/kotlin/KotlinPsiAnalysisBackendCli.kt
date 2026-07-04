package piece.kotlin

import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.system.exitProcess

fun main(args: Array<String>) {
    val options = args.mapNotNull { arg ->
        if (!arg.startsWith("--")) return@mapNotNull null
        val index = arg.indexOf('=')
        if (index < 0) return@mapNotNull arg.drop(2) to ""
        arg.substring(2, index) to arg.substring(index + 1)
    }.toMap()

    val sourceFile = options.required("sourceFile")
    val outputReport = Path.of(options.required("outputReport"))
    val source = Path.of(sourceFile).readText()
    val companionFiles = options["companionSources"]
        ?.takeIf { it.isNotBlank() }
        ?.let(::readCompanionSources)
        .orEmpty()
    val request = KotlinPsiAnalysisRequest(
        filePath = options["filePath"]?.takeIf { it.isNotBlank() } ?: "Main.kt",
        source = source,
        parserName = options["parserName"]?.takeIf { it.isNotBlank() } ?: "kotlin-psi-declaration-extractor",
        semanticDiagnostics = options["semanticDiagnostics"] == "true",
        semanticSymbols = options["semanticSymbols"] == "true",
        companionFiles = companionFiles,
    )

    val result = try {
        KotlinPsiAnalysisBackend().analyze(request)
    } catch (error: Throwable) {
        errorKotlinPsiManifest(request, error)
    }

    outputReport.parent?.createDirectories()
    outputReport.writeText(result.toJson() + "\n")
    if (result.diagnostics.any { it.code in BACKEND_FAILURE_DIAGNOSTICS }) {
        exitProcess(1)
    }
}

private fun Map<String, String>.required(name: String): String {
    return this[name]?.takeIf { it.isNotBlank() } ?: error("Missing --$name=<value>")
}

private fun readCompanionSources(path: String): List<KotlinPsiAnalysisSourceFile> {
    return Path.of(path).readText()
        .lineSequence()
        .mapNotNull { line ->
            val separator = line.indexOf('\t')
            if (separator <= 0 || separator == line.lastIndex) return@mapNotNull null
            val filePath = line.substring(0, separator)
            val sourceFile = line.substring(separator + 1)
            KotlinPsiAnalysisSourceFile(
                filePath = filePath,
                source = Path.of(sourceFile).readText(),
            )
        }
        .toList()
}

private val BACKEND_FAILURE_DIAGNOSTICS = setOf(
    "kotlin-psi-analysis-error",
    "kotlin-compiler-diagnostic-error",
    "kotlin-compiler-internal-error",
    "kotlin-compiler-oom-error",
)
