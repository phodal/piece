package piece.kotlin

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.net.URLClassLoader
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.createDirectories
import kotlin.io.path.exists
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.system.measureTimeMillis
import piece.extract.SourceFile
import piece.model.PieceActionKind

private const val DEFAULT_KOTLIN_PLUGIN_VERSION = "2.2.21"
private const val DEFAULT_GRADLE_VERSION = "9.6.1"

data class KotlinCompileRequest(
    val filePath: String,
    val source: String,
    val target: String = "jvm",
    val sourceSet: String? = null,
    val companionFiles: List<KotlinCompileSourceFile> = emptyList(),
    val pieceAction: KotlinCompilePieceAction? = null,
    val pieceTarget: String? = null,
    val pieceActionName: String = "compile",
    val workspace: Path? = null,
    val keepWorkspace: Boolean = false,
    val gradleCommand: String,
    val gradleVersion: String = DEFAULT_GRADLE_VERSION,
    val kotlinPluginVersion: String = DEFAULT_KOTLIN_PLUGIN_VERSION,
    val tasks: List<String> = emptyList(),
)

data class KotlinCompileSourceFile(
    val filePath: String,
    val source: String,
)

data class KotlinCompilePieceAction(
    val targetLabel: String,
    val actionId: String,
    val artifactId: String,
    val kind: String = "compile",
)

data class KotlinCommandResult(
    val command: String,
    val args: List<String>,
    val cwd: String,
    val exitCode: Int?,
    val signal: String? = null,
    val stdout: String,
    val stderr: String,
    val errorCode: String? = null,
    val durationMs: Double,
)

data class KotlinOutputFile(
    val path: String,
    val sizeBytes: Long,
)

data class KotlinCompileDiagnostic(
    val code: String,
    val severity: String,
    val message: String,
    val command: String,
)

data class KotlinCompileResult(
    val version: Int = 1,
    val language: String = "kotlin",
    val backend: String = "kotlin-jvm",
    val filePath: String,
    val target: String,
    val sourceSet: String,
    val status: String,
    val workspace: String?,
    val pieceAction: KotlinCompilePieceAction? = null,
    val outputFiles: List<KotlinOutputFile>,
    val commands: List<KotlinCommandResult>,
    val diagnostics: List<KotlinCompileDiagnostic>,
) {
    fun toJson(): String = buildJsonObject {
        field("version", version)
        field("language", language)
        field("backend", backend)
        field("filePath", filePath)
        field("target", target)
        field("sourceSet", sourceSet)
        workspace?.let { field("workspace", it) }
        pieceAction?.let { rawField("pieceAction", it.toJson()) }
        field("status", status)
        field("outputFiles", outputFiles) { it.toJson() }
        field("commands", commands) { it.toJson() }
        field("diagnostics", diagnostics) { it.toJson() }
    }
}

class KotlinCompileBackend {
    fun compile(request: KotlinCompileRequest): KotlinCompileResult {
        require(request.target in setOf("jvm", "js", "wasmJs", "all")) {
            "Unsupported Kotlin compile target: ${request.target}"
        }

        val workspace = request.workspace ?: Files.createTempDirectory("piece-kotlin-")
        val temporaryWorkspace = request.workspace == null
        val sourceSet = request.sourceSet?.takeIf { it.isNotBlank() } ?: sourceSetForTarget(request.target)
        val sourceName = sourceBasename(request.filePath)
        val pieceAction = request.resolvePieceAction()
        val commands = mutableListOf<KotlinCommandResult>()

        try {
            workspace.createDirectories()
            workspace.resolve("settings.gradle.kts").writeText("""rootProject.name = "${projectName(sourceName)}"
""")
            workspace.resolve("build.gradle.kts").writeText(kotlinBuildScript(request.target, request.kotlinPluginVersion))
            val sourceDir = workspace.resolve("src").resolve(sourceSet).resolve("kotlin")
            sourceDir.createDirectories()
            sourceDir.resolve(sourceName).writeText(request.source)
            request.companionFiles.forEachIndexed { index, companion ->
                sourceDir.resolve(companionSourceName(index, companion.filePath)).writeText(companion.source)
            }

            val tasks = request.tasks.ifEmpty { tasksForTarget(request.target) }
            commands += runGradleBuild(request, workspace, tasks)

            val reportDir = workspace.resolve("build").resolve("piece")
            reportDir.createDirectories()
            val status = if (commands.all { it.exitCode == 0 }) "success" else "error"
            val result = KotlinCompileResult(
                filePath = request.filePath,
                target = request.target,
                sourceSet = sourceSet,
                status = status,
                workspace = workspace.takeIf { request.keepWorkspace }?.toString(),
                pieceAction = pieceAction,
                outputFiles = collectFiles(workspace.resolve("build").resolve("libs")) +
                    collectFiles(workspace.resolve("build").resolve("dist")),
                commands = commands,
                diagnostics = diagnosticsFromCommands(commands),
            )
            reportDir.resolve("compile-report.json").writeText(result.toJson() + "\n")
            return result.copy(
                outputFiles = (result.outputFiles + collectFiles(reportDir)).sortedBy { it.path },
            )
        } finally {
            if (temporaryWorkspace && !request.keepWorkspace) {
                workspace.toFile().deleteRecursively()
            }
        }
    }
}

internal fun KotlinCompileRequest.resolvePieceAction(): KotlinCompilePieceAction? {
    pieceAction?.let { return it }
    val requestedTarget = pieceTarget?.takeIf { it.isNotBlank() } ?: return null
    val requestedActionName = pieceActionName.takeIf { it.isNotBlank() } ?: "compile"
    val piecePackage = KotlinPsiDeclarationExtractor().extract(SourceFile(filePath = filePath, source = source))
    val selectedTarget = piecePackage.targets.firstOrNull { target ->
        target.name == requestedTarget ||
            target.label == requestedTarget ||
            target.id == requestedTarget
    } ?: error("Kotlin Piece target '$requestedTarget' was not found in $filePath.")
    val selectedAction = piecePackage.actions.firstOrNull { action ->
        action.id == "${selectedTarget.label}%$requestedActionName" || action.id == requestedActionName
    } ?: error("Kotlin Piece action '$requestedActionName' was not found for target ${selectedTarget.label}.")
    require(selectedAction.kind == PieceActionKind.Compile) {
        "Kotlin Piece action '${selectedAction.id}' is ${selectedAction.kind.name.lowercase()}, not compile."
    }
    val artifactId = selectedAction.outputs.firstOrNull()
        ?: error("Kotlin Piece compile action '${selectedAction.id}' does not declare an output artifact.")
    return KotlinCompilePieceAction(
        targetLabel = selectedTarget.label,
        actionId = selectedAction.id,
        artifactId = artifactId,
        kind = selectedAction.kind.name.lowercase(),
    )
}

private fun sourceSetForTarget(target: String): String = when (target) {
    "jvm" -> "jvmMain"
    "js" -> "jsMain"
    "wasmJs" -> "wasmJsMain"
    else -> "commonMain"
}

private fun tasksForTarget(target: String): List<String> = when (target) {
    "jvm" -> listOf("jvmJar")
    "js" -> listOf("jsNodeProductionLibraryDistribution")
    "wasmJs" -> listOf("wasmJsBrowserDistribution")
    else -> listOf("jvmJar", "jsNodeProductionLibraryDistribution", "wasmJsBrowserDistribution")
}

private fun sourceBasename(filePath: String): String {
    val name = filePath.replace('\\', '/').substringAfterLast('/').takeIf { it.contains('.') }
    return name ?: "Main.kt"
}

private fun companionSourceName(index: Int, filePath: String): String {
    val baseName = sourceBasename(filePath)
        .replace(Regex("\\.kts?$"), "")
        .replace(Regex("[^A-Za-z0-9_]+"), "_")
        .trim('_')
        .ifBlank { "Companion" }
    return "PieceCompanion_${index}_$baseName.kt"
}

private fun projectName(sourceName: String): String {
    return sourceName
        .replace(Regex("\\.kts?$"), "")
        .replace(Regex("[^A-Za-z0-9_-]+"), "-")
        .trim('-')
        .take(48)
        .ifBlank { "piece" }
}

private fun kotlinBuildScript(target: String, kotlinPluginVersion: String): String {
    val includeJvm = target == "jvm" || target == "all"
    val includeJs = target == "js" || target == "all"
    val includeWasm = target == "wasmJs" || target == "all"
    return """
@file:OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)

plugins {
    kotlin("multiplatform") version "$kotlinPluginVersion"
}

group = "cc.phodal.piece.generated"
version = "0.1.0"

repositories {
    mavenCentral()
}

kotlin {
${if (includeJvm) "    jvm()\n" else ""}${if (includeJs) """    js(IR) {
        nodejs()
        binaries.library()
    }
""" else ""}${if (includeWasm) """    wasmJs {
        browser {
            testTask {
                enabled = false
            }
        }
        binaries.executable()
    }
""" else ""}}
""".trimStart()
}

private fun runGradleBuild(request: KotlinCompileRequest, workspace: Path, tasks: List<String>): KotlinCommandResult {
    val toolingResult = runGradleToolingApi(workspace, tasks, request.gradleVersion)
    if (toolingResult.errorCode != "tooling-api-unavailable") {
        return toolingResult
    }
    return runCommand(
        command = request.gradleCommand,
        args = listOf("-p", workspace.toString()) + tasks,
        cwd = workspace,
    )
}

private fun runGradleToolingApi(workspace: Path, tasks: List<String>, gradleVersion: String): KotlinCommandResult {
    val stdout = ByteArrayOutputStream()
    val stderr = ByteArrayOutputStream()
    var exitCode: Int? = 0
    var errorCode: String? = null
    val elapsed = measureTimeMillis {
        val previousClassLoader = Thread.currentThread().contextClassLoader
        var classLoader: URLClassLoader? = null
        try {
            val gradleHome = findGradleHome(gradleVersion)
                ?: error("Gradle $gradleVersion distribution is not available under GRADLE_USER_HOME.")
            val classpath = collectGradleDistributionJars(gradleHome)
            if (classpath.none { it.fileName.toString().startsWith("gradle-tooling-api-") }) {
                error("Gradle Tooling API jar was not found in $gradleHome.")
            }

            classLoader = URLClassLoader(
                classpath.map { it.toUri().toURL() }.toTypedArray(),
                ClassLoader.getPlatformClassLoader(),
            )
            Thread.currentThread().contextClassLoader = classLoader
            runGradleToolingBuild(classLoader, workspace, tasks, gradleVersion, stdout, stderr)
        } catch (error: IllegalStateException) {
            exitCode = null
            errorCode = "tooling-api-unavailable"
            stderr.writeText(error.message ?: error::class.java.simpleName)
        } catch (error: ClassNotFoundException) {
            exitCode = null
            errorCode = "tooling-api-unavailable"
            stderr.writeText(error.message ?: error::class.java.simpleName)
        } catch (error: NoClassDefFoundError) {
            exitCode = null
            errorCode = "tooling-api-unavailable"
            stderr.writeText(error.message ?: error::class.java.simpleName)
        } catch (error: InvocationTargetException) {
            exitCode = 1
            stderr.writeText(error.targetException?.message ?: error.message ?: error::class.java.simpleName)
        } catch (error: Throwable) {
            exitCode = 1
            stderr.writeText(error.message ?: error::class.java.simpleName)
        } finally {
            Thread.currentThread().contextClassLoader = previousClassLoader
            classLoader?.close()
        }
    }
    return KotlinCommandResult(
        command = "gradle-tooling-api",
        args = listOf("-p", workspace.toString()) + tasks,
        cwd = workspace.toString(),
        exitCode = exitCode,
        stdout = stdout.toString(Charsets.UTF_8),
        stderr = stderr.toString(Charsets.UTF_8),
        errorCode = errorCode,
        durationMs = elapsed.toDouble(),
    )
}

private fun runGradleToolingBuild(
    classLoader: ClassLoader,
    workspace: Path,
    tasks: List<String>,
    gradleVersion: String,
    stdout: OutputStream,
    stderr: OutputStream,
) {
    val connectorClass = classLoader.loadClass("org.gradle.tooling.GradleConnector")
    val connector = connectorClass.getMethod("newConnector").invoke(null)
    connectorClass.getMethod("forProjectDirectory", File::class.java).invoke(connector, workspace.toFile())
    connectorClass.getMethod("useGradleVersion", String::class.java).invoke(connector, gradleVersion)
    val connection = connectorClass.getMethod("connect").invoke(connector)
    try {
        val projectConnectionClass = classLoader.loadClass("org.gradle.tooling.ProjectConnection")
        val buildLauncherClass = classLoader.loadClass("org.gradle.tooling.BuildLauncher")
        val longRunningOperationClass = classLoader.loadClass("org.gradle.tooling.LongRunningOperation")
        val build = projectConnectionClass.getMethod("newBuild").invoke(connection)
        buildLauncherClass.stringVarargMethod("forTasks").invoke(build, tasks.toTypedArray() as Any)
        longRunningOperationClass.getMethod("setStandardOutput", OutputStream::class.java).invoke(build, stdout)
        longRunningOperationClass.getMethod("setStandardError", OutputStream::class.java).invoke(build, stderr)
        buildLauncherClass.getMethod("run").invoke(build)
    } finally {
        (connection as AutoCloseable).close()
    }
}

private fun Class<*>.stringVarargMethod(name: String): Method {
    return methods.firstOrNull { method ->
        method.name == name &&
            method.parameterTypes.size == 1 &&
            method.parameterTypes[0].isArray &&
            method.parameterTypes[0].componentType == String::class.java
    } ?: error("Unable to find $name(vararg) on ${this.name}.")
}

private fun findGradleHome(version: String): Path? {
    val gradleUserHome = System.getenv("GRADLE_USER_HOME")?.takeIf { it.isNotBlank() }?.let(Paths::get)
        ?: Paths.get(System.getProperty("user.home"), ".gradle")
    val distributions = gradleUserHome.resolve("wrapper").resolve("dists")
    if (!distributions.exists()) return null
    Files.walk(distributions).use { stream ->
        return stream
            .filter { Files.isDirectory(it) }
            .filter { it.fileName.toString() == "gradle-$version" }
            .filter { it.resolve("lib").exists() }
            .findFirst()
            .orElse(null)
    }
}

private fun collectGradleDistributionJars(gradleHome: Path): List<Path> {
    val lib = gradleHome.resolve("lib")
    if (!lib.exists()) return emptyList()
    return Files.walk(lib).use { stream ->
        stream
            .filter { Files.isRegularFile(it) && it.fileName.toString().endsWith(".jar") }
            .toList()
            .sortedBy { it.toString() }
    }
}

private fun ByteArrayOutputStream.writeText(value: String) {
    write(value.toByteArray(Charsets.UTF_8))
}

private fun runCommand(command: String, args: List<String>, cwd: Path): KotlinCommandResult {
    val stdout = StringBuilder()
    val stderr = StringBuilder()
    var exitCode: Int? = null
    var errorCode: String? = null
    val elapsed = measureTimeMillis {
        try {
            val process = ProcessBuilder(listOf(command) + args)
                .directory(cwd.toFile())
                .redirectErrorStream(false)
                .start()
            stdout.append(process.inputStream.bufferedReader().readText())
            stderr.append(process.errorStream.bufferedReader().readText())
            exitCode = process.waitFor()
        } catch (error: java.io.IOException) {
            errorCode = "ENOENT"
            stderr.append(error.message ?: error::class.java.simpleName)
        }
    }
    return KotlinCommandResult(
        command = command,
        args = args,
        cwd = cwd.toString(),
        exitCode = exitCode,
        stdout = stdout.toString(),
        stderr = stderr.toString(),
        errorCode = errorCode,
        durationMs = elapsed.toDouble(),
    )
}

private fun collectFiles(root: Path): List<KotlinOutputFile> {
    if (!root.exists()) return emptyList()
    return Files.walk(root).use { stream ->
        stream
            .filter { Files.isRegularFile(it) }
            .map { KotlinOutputFile(it.toString(), Files.size(it)) }
            .toList()
            .sortedBy { it.path }
    }
}

private fun diagnosticsFromCommands(commands: List<KotlinCommandResult>): List<KotlinCompileDiagnostic> {
    return commands
        .filter { it.exitCode != 0 }
        .map {
            KotlinCompileDiagnostic(
                code = if (it.errorCode == "ENOENT") "tool-not-found" else "compiler-error",
                severity = "error",
                message = it.stderr.trim().ifBlank {
                    it.stdout.trim().ifBlank { "${it.command} exited with code ${it.exitCode}" }
                },
                command = (listOf(it.command) + it.args).joinToString(" "),
            )
        }
}

private class JsonObjectBuilder {
    private val fields = mutableListOf<String>()

    fun field(name: String, value: String) {
        fields += "${name.jsonString()}:${value.jsonString()}"
    }

    fun field(name: String, value: Number) {
        fields += "${name.jsonString()}:$value"
    }

    fun nullField(name: String) {
        fields += "${name.jsonString()}:null"
    }

    fun rawField(name: String, value: String) {
        fields += "${name.jsonString()}:$value"
    }

    fun <T> field(name: String, values: List<T>, encode: (T) -> String) {
        fields += "${name.jsonString()}:${values.joinToString(prefix = "[", postfix = "]") { encode(it) }}"
    }

    fun build(): String = fields.joinToString(prefix = "{", postfix = "}")
}

private fun buildJsonObject(init: JsonObjectBuilder.() -> Unit): String {
    return JsonObjectBuilder().apply(init).build()
}

private fun KotlinCompilePieceAction.toJson(): String = buildJsonObject {
    field("targetLabel", targetLabel)
    field("actionId", actionId)
    field("artifactId", artifactId)
    field("kind", kind)
}

private fun KotlinOutputFile.toJson(): String = buildJsonObject {
    field("path", path)
    field("sizeBytes", sizeBytes)
}

private fun KotlinCommandResult.toJson(): String = buildJsonObject {
    field("command", command)
    field("args", args) { it.jsonString() }
    field("cwd", cwd)
    exitCode?.let { field("exitCode", it) } ?: nullField("exitCode")
    signal?.let { field("signal", it) }
    field("stdout", stdout)
    field("stderr", stderr)
    errorCode?.let { field("errorCode", it) }
    field("durationMs", durationMs)
}

private fun KotlinCompileDiagnostic.toJson(): String = buildJsonObject {
    field("code", code)
    field("severity", severity)
    field("message", message)
    field("command", command)
}

private fun String.jsonString(): String {
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
