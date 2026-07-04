package piece.kotlin

import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText

fun main(args: Array<String>) {
    val options = args.mapNotNull { arg ->
        if (!arg.startsWith("--")) return@mapNotNull null
        val index = arg.indexOf('=')
        if (index < 0) return@mapNotNull arg.drop(2) to ""
        arg.substring(2, index) to arg.substring(index + 1)
    }.toMap()

    val projectRoot = Path.of(options.required("projectRoot"))
    val outputReport = Path.of(options.required("outputReport"))
    val request = KotlinGradleProjectModelRequest(
        projectRoot = projectRoot,
        gradleCommand = options["gradleCommand"]?.takeIf { it.isNotBlank() } ?: "./gradlew",
        gradleVersion = options["gradleVersion"]?.takeIf { it.isNotBlank() } ?: "9.6.1",
        sourceSet = options["sourceSet"]?.takeIf { it.isNotBlank() },
    )
    val result = try {
        KotlinGradleProjectModelBackend().discover(request)
    } catch (error: Throwable) {
        val fallbackProjectRoot = projectRoot.toAbsolutePath().normalize().toString()
        KotlinGradleProjectModelResult(
            projectRoot = fallbackProjectRoot,
            status = "fallback",
            sourceSets = emptyList(),
            classpaths = emptyList(),
            dependencies = emptyList(),
            projectDependencies = emptyList(),
            targetVariants = emptyList(),
            sourceRoots = emptyList(),
            classpath = emptyList(),
            hashes = projectModelHashes(
                projectRoot = fallbackProjectRoot,
                status = "fallback",
                sourceSets = emptyList(),
                classpaths = emptyList(),
                dependencies = emptyList(),
                projectDependencies = emptyList(),
                targetVariants = emptyList(),
                sourceRoots = emptyList(),
                classpath = emptyList(),
            ),
            commands = emptyList(),
            diagnostics = listOf(
                KotlinGradleProjectModelDiagnostic(
                    code = "kotlin-gradle-project-model-backend-error",
                    severity = "warning",
                    message = error.message ?: error::class.java.name,
                ),
            ),
        )
    }

    outputReport.parent?.createDirectories()
    outputReport.writeText(result.toJson() + "\n")
}

private fun Map<String, String>.required(name: String): String {
    return this[name]?.takeIf { it.isNotBlank() } ?: error("Missing --$name=<value>")
}
