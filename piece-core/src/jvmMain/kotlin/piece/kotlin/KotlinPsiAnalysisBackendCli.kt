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

    val outputReport = Path.of(options.required("outputReport"))
    val classpath = (
        defaultKotlinSemanticClasspath() + options["classpathFile"]
            ?.takeIf { it.isNotBlank() }
            ?.let(::readClasspathEntries)
            .orEmpty()
    ).distinct()
    val batchSources = options["batchSources"]?.takeIf { it.isNotBlank() }?.let(::readCompanionSources)
    val results = if (batchSources != null) {
        require(batchSources.isNotEmpty()) { "--batchSources must contain one or more Kotlin sources" }
        batchSources.map { primary ->
            analyzeRequest(
                requestFor(
                    options = options,
                    source = primary,
                    companionFiles = batchSources.filterNot { candidate -> candidate.filePath == primary.filePath },
                    classpath = classpath,
                ),
            )
        }
    } else {
        val sourceFile = options.required("sourceFile")
        val source = KotlinPsiAnalysisSourceFile(
            filePath = options["filePath"]?.takeIf { it.isNotBlank() } ?: "Main.kt",
            source = Path.of(sourceFile).readText(),
        )
        val companionFiles = options["companionSources"]
            ?.takeIf { it.isNotBlank() }
            ?.let(::readCompanionSources)
            .orEmpty()
        listOf(analyzeRequest(requestFor(options, source, companionFiles, classpath)))
    }

    outputReport.parent?.createDirectories()
    outputReport.writeText(if (batchSources == null) results.single().toJson() + "\n" else results.toBatchJson() + "\n")
    if (results.any { result -> result.diagnostics.any { diagnostic -> diagnostic.code in BACKEND_FAILURE_DIAGNOSTICS } }) {
        exitProcess(1)
    }
}

private fun requestFor(
    options: Map<String, String>,
    source: KotlinPsiAnalysisSourceFile,
    companionFiles: List<KotlinPsiAnalysisSourceFile>,
    classpath: List<String>,
): KotlinPsiAnalysisRequest = KotlinPsiAnalysisRequest(
    filePath = source.filePath,
    source = source.source,
    parserName = options["parserName"]?.takeIf { it.isNotBlank() } ?: "kotlin-psi-declaration-extractor",
    backend = options["backend"]?.takeIf { it.isNotBlank() }?.let(KotlinAnalysisBackendKind::fromWireName),
    analysisApiEnabled = options["analysisApiEnabled"] == "true",
    analysisApiVersion = options["analysisApiVersion"]?.takeIf { it.isNotBlank() },
    semanticDiagnostics = options["semanticDiagnostics"] == "true",
    semanticSymbols = options["semanticSymbols"] == "true",
    companionFiles = companionFiles,
    classpath = classpath,
)

private fun analyzeRequest(request: KotlinPsiAnalysisRequest): KotlinPsiManifest = try {
    KotlinPsiAnalysisBackend().analyze(request)
} catch (error: Throwable) {
    errorKotlinPsiManifest(request, error)
}

private fun List<KotlinPsiManifest>.toBatchJson(): String = joinToString(prefix = "[", postfix = "]", separator = ",") { manifest -> manifest.toJson() }

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

private fun readClasspathEntries(path: String): List<String> {
    return Path.of(path).readText()
        .lineSequence()
        .map { it.trim() }
        .filter { it.isNotBlank() }
        .toList()
}

private val BACKEND_FAILURE_DIAGNOSTICS = setOf(
    "kotlin-psi-analysis-error",
    "kotlin-compiler-diagnostic-error",
    "kotlin-compiler-internal-error",
    "kotlin-compiler-oom-error",
)
