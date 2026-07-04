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
                    companionFile
                }
            val report = runIsolatedAnalysisApi(sourceFile, companionSourceFiles)
            KotlinBindingSymbolResult(
                symbolsByDeclaration = report,
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
        sourceFile: Path,
        companionSourceFiles: List<Path>,
    ): Map<String, KotlinSemanticSymbols> {
        val javaExecutable = File(System.getProperty("java.home"), "bin/java").absolutePath
        val childClasspath = analysisApiChildClasspath()
        val command = listOf(
            javaExecutable,
            "-Djava.awt.headless=true",
            "-cp",
            childClasspath,
            "piece.kotlin.KotlinAnalysisApiSymbolRunner",
            sourceFile.toAbsolutePath().normalize().toString(),
        ) + companionSourceFiles.map { it.toAbsolutePath().normalize().toString() }
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

    private fun parseAnalysisApiReport(stdout: String): Map<String, KotlinSemanticSymbols> {
        return stdout
            .lineSequence()
            .filter { it.startsWith("DECL\t") }
            .mapNotNull { line ->
                val parts = line.split('\t')
                if (parts.size < 6) return@mapNotNull null
                parts[1] to KotlinSemanticSymbols(
                    runtimeReferences = parts[2].csvNames(),
                    typeReferences = parts[3].csvNames(),
                    resolvedRuntimeNames = parts[4].csvNames(),
                    resolvedTypeNames = parts[5].csvNames(),
                )
            }
            .toMap()
    }
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
