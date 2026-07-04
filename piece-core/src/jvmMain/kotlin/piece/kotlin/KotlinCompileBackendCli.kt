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
    val gradleCommand = options["gradleCommand"]?.takeIf { it.isNotBlank() } ?: "./gradlew"
    val source = Path.of(sourceFile).readText()
    val request = KotlinCompileRequest(
        filePath = options["filePath"]?.takeIf { it.isNotBlank() } ?: "Main.kt",
        source = source,
        target = options["target"]?.takeIf { it.isNotBlank() } ?: "jvm",
        sourceSet = options["sourceSet"]?.takeIf { it.isNotBlank() },
        workspace = options["workspace"]?.takeIf { it.isNotBlank() }?.let { Path.of(it) },
        keepWorkspace = options["keepWorkspace"] == "true",
        gradleCommand = gradleCommand,
        gradleVersion = options["gradleVersion"]?.takeIf { it.isNotBlank() } ?: "9.6.1",
        kotlinPluginVersion = options["kotlinPluginVersion"]?.takeIf { it.isNotBlank() } ?: "2.2.21",
        tasks = options["tasks"]?.takeIf { it.isNotBlank() }?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty(),
    )

    val result = try {
        KotlinCompileBackend().compile(request)
    } catch (error: Throwable) {
        KotlinCompileResult(
            filePath = request.filePath,
            target = request.target,
            sourceSet = request.sourceSet ?: "commonMain",
            status = "error",
            workspace = request.workspace?.takeIf { request.keepWorkspace }?.toString(),
            outputFiles = emptyList(),
            commands = emptyList(),
            diagnostics = listOf(
                KotlinCompileDiagnostic(
                    code = "kotlin-backend-error",
                    severity = "error",
                    message = error.message ?: error::class.java.name,
                    command = "piece.kotlin.KotlinCompileBackend",
                ),
            ),
        )
    }

    outputReport.parent?.createDirectories()
    outputReport.writeText(result.toJson() + "\n")
    if (result.status != "success") {
        exitProcess(1)
    }
}

private fun Map<String, String>.required(name: String): String {
    return this[name]?.takeIf { it.isNotBlank() } ?: error("Missing --$name=<value>")
}
