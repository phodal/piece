package piece.kotlin

import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText

internal class KotlinAnalysisApiSymbolBackend {
    fun symbols(request: KotlinBindingSymbolRequest): KotlinBindingSymbolResult {
        val workspace = Files.createTempDirectory("piece-kotlin-analysis-api-")
        return try {
            val sourceFile = workspace.resolve("primary").resolve(analysisApiSourceName(request.filePath, "Main.kt"))
            sourceFile.parent.createDirectories()
            sourceFile.writeText(request.source)
            val companionSourceFiles = request.companionFiles
                .filterNot { it.filePath == request.filePath }
                .mapIndexed { index, companion ->
                    val companionFile = workspace
                        .resolve("companions")
                        .resolve("$index-${analysisApiSourceName(companion.filePath, "Companion.kt")}")
                    companionFile.parent.createDirectories()
                    companionFile.writeText(companion.source)
                    AnalysisApiSourceFile(companionFile, companion.filePath)
                }
            runIsolatedAnalysisApi(
                sourceFile = AnalysisApiSourceFile(sourceFile, request.filePath),
                companionSourceFiles = companionSourceFiles,
                classpath = request.classpath,
                identityClasspath = request.hostProvidedClasspath(),
            )
        } catch (error: Throwable) {
            KotlinBindingSymbolResult(
                symbolsByDeclaration = emptyMap(),
                diagnostics = listOf(
                    KotlinPsiDiagnostic(
                        code = "kotlin-analysis-api-symbol-analysis-error",
                        severity = "warning",
                        message = error.message ?: error::class.java.name,
                        path = request.filePath,
                    ),
                ),
            )
        } finally {
            workspace.toFile().deleteRecursively()
        }
    }

    private fun runIsolatedAnalysisApi(
        sourceFile: AnalysisApiSourceFile,
        companionSourceFiles: List<AnalysisApiSourceFile>,
        classpath: List<String>,
        identityClasspath: List<String>,
    ): KotlinBindingSymbolResult {
        val javaExecutable = File(System.getProperty("java.home"), "bin/java").absolutePath
        val childClasspath = analysisApiChildClasspath()
        val command = listOf(
            javaExecutable,
            "-Djava.awt.headless=true",
            "-cp",
            childClasspath,
            "piece.kotlin.KotlinAnalysisApiSymbolRunner",
            sourceFile.physicalPath.toAbsolutePath().normalize().toString(),
            sourceFile.virtualPath,
        ) + companionSourceFiles.flatMap {
            listOf(it.physicalPath.toAbsolutePath().normalize().toString(), it.virtualPath)
        } + classpath
            .filter { it.isNotBlank() }
            .distinct()
            .flatMap {
                listOf("--classpath", it)
        } + identityClasspath
            .filter { it.isNotBlank() }
            .distinct()
            .flatMap {
                listOf("--identity-classpath", it)
        }
        val process = ProcessBuilder(command)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        if (exitCode != 0) {
            error(
                "Kotlin Analysis API symbol runner exited with code $exitCode" +
                    output.takeIf { it.isNotBlank() }?.let { ": ${it.trim()}" }.orEmpty(),
            )
        }
        return parseAnalysisApiReport(output)
    }

    private fun analysisApiChildClasspath(): String {
        return System.getProperty("java.class.path")
            .split(File.pathSeparator)
            .filter { it.isNotBlank() }
            .filterNot { entry ->
                val name = entry.substringAfterLast(File.separatorChar)
                name.contains("-embeddable")
            }
            .joinToString(File.pathSeparator)
    }

    private fun parseAnalysisApiReport(stdout: String): KotlinBindingSymbolResult {
        val symbolsByDeclaration = linkedMapOf<String, MutableAnalysisApiSymbols>()
        for (line in stdout.lineSequence()) {
            val parts = line.split('\t')
            when {
                parts.firstOrNull() == "DECL" && parts.size >= 6 -> {
                    symbolsByDeclaration[parts[1]] = MutableAnalysisApiSymbols(
                        runtimeReferences = parts[2].csvNames().toMutableList(),
                        typeReferences = parts[3].csvNames().toMutableList(),
                        resolvedRuntimeNames = parts[4].csvNames().toMutableList(),
                        resolvedTypeNames = parts[5].csvNames().toMutableList(),
                    )
                }

                parts.firstOrNull() == "BIND" && parts.size >= 7 -> {
                    val declaration = parts[1]
                    val symbols = symbolsByDeclaration.getOrPut(declaration) {
                        MutableAnalysisApiSymbols()
                    }
                    val isTypeOnly = parts[6].toBooleanStrictOrNull() ?: false
                    symbols.importBindings += KotlinPsiImportBinding(
                        local = parts[2],
                        imported = parts[3],
                        source = parts[4],
                        kind = parts[5],
                        isTypeOnly = isTypeOnly,
                        signature = parts.getOrNull(7)?.takeIf { it.isNotBlank() },
                    )
                    if (isTypeOnly) {
                        symbols.typeReferences += parts[2]
                    } else {
                        symbols.runtimeReferences += parts[2]
                    }
                }
            }
        }
        val immutableSymbols = symbolsByDeclaration.mapValues { (_, symbols) ->
            KotlinSemanticSymbols(
                runtimeReferences = symbols.runtimeReferences.distinct().sorted(),
                typeReferences = symbols.typeReferences.distinct().sorted(),
                resolvedRuntimeNames = symbols.resolvedRuntimeNames.distinct().sorted(),
                resolvedTypeNames = symbols.resolvedTypeNames.distinct().sorted(),
                importBindings = symbols.importBindings.distinctBy {
                    "${it.local}:${it.imported}:${it.source}:${it.kind}:${it.isTypeOnly}:${it.signature.orEmpty()}"
                }.sortedWith(compareBy({ it.source }, { it.imported }, { it.local }, { it.signature.orEmpty() })),
            )
        }
        return KotlinBindingSymbolResult(
            symbolsByDeclaration = immutableSymbols,
            importBindings = immutableSymbols.values
                .flatMap { it.importBindings }
                .distinctBy { "${it.local}:${it.imported}:${it.source}:${it.kind}:${it.isTypeOnly}:${it.signature.orEmpty()}" }
                .sortedWith(compareBy({ it.source }, { it.imported }, { it.local }, { it.signature.orEmpty() })),
        )
    }
}

private data class AnalysisApiSourceFile(
    val physicalPath: Path,
    val virtualPath: String,
)

private data class MutableAnalysisApiSymbols(
    val runtimeReferences: MutableList<String> = mutableListOf(),
    val typeReferences: MutableList<String> = mutableListOf(),
    val resolvedRuntimeNames: MutableList<String> = mutableListOf(),
    val resolvedTypeNames: MutableList<String> = mutableListOf(),
    val importBindings: MutableList<KotlinPsiImportBinding> = mutableListOf(),
)

private fun KotlinBindingSymbolRequest.hostProvidedClasspath(): List<String> {
    val defaultEntries = defaultKotlinSemanticClasspath()
        .map(::normalizedClasspathEntry)
        .toSet()
    return classpath.filter { entry ->
        entry.isNotBlank() && normalizedClasspathEntry(entry) !in defaultEntries
    }
}

private fun normalizedClasspathEntry(path: String): String {
    return runCatching {
        Path.of(path).toAbsolutePath().normalize().toString()
    }.getOrElse { path }
}

private fun String.csvNames(): List<String> {
    return split(',')
        .map { it.trim() }
        .filter { it.isNotBlank() }
        .distinct()
        .sorted()
}

private fun analysisApiSourceName(filePath: String, fallback: String): String {
    return filePath.replace('\\', '/').substringAfterLast('/').ifBlank { fallback }
}
