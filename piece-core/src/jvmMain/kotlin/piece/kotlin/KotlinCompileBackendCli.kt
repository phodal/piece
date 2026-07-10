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
    val gradleCommand = options["gradleCommand"]?.takeIf { it.isNotBlank() } ?: defaultGradleCommand()
    val source = Path.of(sourceFile).readText()
    val companionFiles = options["companionSources"]
        ?.takeIf { it.isNotBlank() }
        ?.let(::readCompanionSources)
        .orEmpty()
    val request = KotlinCompileRequest(
        filePath = options["filePath"]?.takeIf { it.isNotBlank() } ?: "Main.kt",
        source = source,
        target = options["target"]?.takeIf { it.isNotBlank() } ?: "jvm",
        sourceSet = options["sourceSet"]?.takeIf { it.isNotBlank() },
        projectRoot = options["projectRoot"]?.takeIf { it.isNotBlank() }?.let { Path.of(it) },
        companionFiles = companionFiles,
        pieceAction = options.toPieceAction(),
        pieceTarget = options["pieceTarget"]?.takeIf { it.isNotBlank() },
        pieceActionName = options["pieceActionName"]?.takeIf { it.isNotBlank() } ?: "compile",
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
            projectRoot = request.projectRoot?.toAbsolutePath()?.normalize()?.toString(),
            pieceAction = request.pieceAction,
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

private fun readCompanionSources(path: String): List<KotlinCompileSourceFile> {
    return Path.of(path)
        .readText()
        .lineSequence()
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .map { line ->
            val parts = line.split('\t', limit = 2)
            require(parts.size == 2) {
                "Companion source rows must be tab-separated as: filePath<TAB>sourceFile"
            }
            KotlinCompileSourceFile(
                filePath = parts[0],
                source = Path.of(parts[1]).readText(),
            )
        }
        .toList()
}

private fun Map<String, String>.toPieceAction(): KotlinCompilePieceAction? {
    val targetLabel = this["pieceTargetLabel"]?.takeIf { it.isNotBlank() }
    val actionId = this["pieceActionId"]?.takeIf { it.isNotBlank() }
    val artifactId = this["pieceArtifactId"]?.takeIf { it.isNotBlank() }
    if (targetLabel == null && actionId == null && artifactId == null) return null
    return KotlinCompilePieceAction(
        targetLabel = targetLabel ?: error("Missing --pieceTargetLabel=<label> for compile action metadata."),
        actionId = actionId ?: error("Missing --pieceActionId=<id> for compile action metadata."),
        artifactId = artifactId ?: error("Missing --pieceArtifactId=<id> for compile action metadata."),
        kind = this["pieceActionKind"]?.takeIf { it.isNotBlank() } ?: "compile",
    )
}
