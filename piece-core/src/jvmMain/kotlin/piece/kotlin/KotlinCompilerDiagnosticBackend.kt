package piece.kotlin

import org.jetbrains.kotlin.cli.common.ExitCode
import org.jetbrains.kotlin.cli.common.arguments.K2JVMCompilerArguments
import org.jetbrains.kotlin.cli.common.messages.CompilerMessageSeverity
import org.jetbrains.kotlin.cli.common.messages.CompilerMessageSourceLocation
import org.jetbrains.kotlin.cli.common.messages.MessageCollector
import org.jetbrains.kotlin.cli.jvm.K2JVMCompiler
import org.jetbrains.kotlin.config.Services
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.ExperimentalPathApi
import kotlin.io.path.createDirectories
import kotlin.io.path.deleteRecursively
import kotlin.io.path.writeText

data class KotlinCompilerDiagnosticRequest(
    val filePath: String,
    val source: String,
    val classpath: List<String> = defaultKotlinSemanticClasspath(),
)

internal class KotlinCompilerDiagnosticBackend {
    fun diagnostics(request: KotlinCompilerDiagnosticRequest): List<KotlinPsiDiagnostic> {
        val workspace = Files.createTempDirectory("piece-kotlin-semantic-")
        return try {
            val sourceName = request.filePath.replace('\\', '/').substringAfterLast('/').ifBlank { "Main.kt" }
            val sourceFile = workspace.resolve(sourceName)
            val outputDir = workspace.resolve("classes")
            outputDir.createDirectories()
            sourceFile.writeText(request.source)

            val collector = CollectingMessageCollector(
                virtualPath = request.filePath,
                actualPath = sourceFile.toAbsolutePath().normalize().toString(),
            )
            val args = K2JVMCompilerArguments().apply {
                destination = outputDir.toString()
                moduleName = "piece-semantic"
                freeArgs = listOf(sourceFile.toString())
                renderInternalDiagnosticNames = true
                noReflect = true
                val runtimeClasspath = request.classpath.filter { it.isNotBlank() }
                if (runtimeClasspath.isNotEmpty()) {
                    classpath = runtimeClasspath.joinToString(File.pathSeparator)
                    noStdlib = true
                }
            }
            val exitCode = K2JVMCompiler().exec(collector, Services.EMPTY, args)
            collector.diagnostics(exitCode)
        } catch (error: Throwable) {
            listOf(
                KotlinPsiDiagnostic(
                    code = "kotlin-compiler-diagnostic-error",
                    severity = "error",
                    message = error.message ?: error::class.java.name,
                    path = request.filePath,
                ),
            )
        } finally {
            workspace.deleteRecursivelyIfExists()
        }
    }
}

private class CollectingMessageCollector(
    private val virtualPath: String,
    private val actualPath: String,
) : MessageCollector {
    private val collected = mutableListOf<KotlinPsiDiagnostic>()

    override fun clear() {
        collected.clear()
    }

    override fun hasErrors(): Boolean = collected.any { it.severity == "error" }

    override fun report(
        severity: CompilerMessageSeverity,
        message: String,
        location: CompilerMessageSourceLocation?,
    ) {
        if (!severity.isError && !severity.isWarning) return
        collected += KotlinPsiDiagnostic(
            code = "kotlin-compiler-${severity.name.lowercase().replace('_', '-')}",
            severity = if (severity.isError) "error" else "warning",
            message = message.trim(),
            path = location?.path?.let(::displayPath),
            line = location?.line?.takeIf { it > 0 },
            column = location?.column?.takeIf { it > 0 },
            lineEnd = location?.lineEnd?.takeIf { it > 0 },
            columnEnd = location?.columnEnd?.takeIf { it > 0 },
        )
    }

    fun diagnostics(exitCode: ExitCode): List<KotlinPsiDiagnostic> {
        if (exitCode == ExitCode.OK || collected.any { it.severity == "error" }) {
            return collected
        }
        return collected + KotlinPsiDiagnostic(
            code = "kotlin-compiler-${exitCode.name.lowercase().replace('_', '-')}",
            severity = "error",
            message = "Kotlin compiler exited with ${exitCode.name}.",
            path = virtualPath,
        )
    }

    private fun displayPath(path: String): String {
        val normalized = Path.of(path).toAbsolutePath().normalize().toString()
        return if (normalized == actualPath) virtualPath else path
    }
}

internal fun defaultKotlinSemanticClasspath(): List<String> {
    return System.getProperty("java.class.path")
        .split(File.pathSeparator)
        .filter { path ->
            val name = File(path).name
            name.startsWith("kotlin-stdlib") || name.startsWith("annotations-")
        }
        .distinct()
}

@OptIn(ExperimentalPathApi::class)
private fun Path.deleteRecursivelyIfExists() {
    if (Files.exists(this)) {
        deleteRecursively()
    }
}
