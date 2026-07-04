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
import kotlin.io.path.writeText
import kotlin.system.measureTimeMillis

data class KotlinGradleProjectModelRequest(
    val projectRoot: Path,
    val gradleCommand: String,
    val gradleVersion: String = "9.6.1",
    val sourceSet: String? = null,
)

data class KotlinGradleProjectModelSourceSet(
    val projectPath: String,
    val projectDir: String,
    val name: String,
    val sourceRoots: List<String>,
    val targetNames: List<String>,
)

data class KotlinGradleProjectModelClasspath(
    val projectPath: String,
    val name: String,
    val files: List<String>,
)

data class KotlinGradleProjectModelDependency(
    val projectPath: String,
    val configuration: String,
    val group: String,
    val name: String,
    val version: String,
    val coordinates: String,
)

data class KotlinGradleProjectModelProjectDependency(
    val projectPath: String,
    val configuration: String,
    val dependencyProjectPath: String,
    val dependencyProjectDir: String,
)

data class KotlinGradleProjectModelTargetVariant(
    val projectPath: String,
    val sourceSet: String,
    val targetName: String,
    val compilationName: String,
    val compileTask: String,
    val classpathConfiguration: String,
)

data class KotlinGradleProjectModelDiagnostic(
    val code: String,
    val severity: String,
    val message: String,
    val command: String? = null,
)

data class KotlinGradleProjectModelHashes(
    val sourceRootsHash: String,
    val classpathHash: String,
    val modelHash: String,
)

data class KotlinGradleProjectModelResult(
    val version: Int = 1,
    val projectRoot: String,
    val status: String,
    val sourceSets: List<KotlinGradleProjectModelSourceSet>,
    val classpaths: List<KotlinGradleProjectModelClasspath>,
    val dependencies: List<KotlinGradleProjectModelDependency>,
    val projectDependencies: List<KotlinGradleProjectModelProjectDependency>,
    val targetVariants: List<KotlinGradleProjectModelTargetVariant>,
    val sourceRoots: List<String>,
    val classpath: List<String>,
    val hashes: KotlinGradleProjectModelHashes,
    val commands: List<KotlinCommandResult>,
    val diagnostics: List<KotlinGradleProjectModelDiagnostic>,
) {
    fun toJson(): String = buildGradleModelJsonObject {
        field("version", version)
        field("projectRoot", projectRoot)
        field("status", status)
        field("sourceSets", sourceSets) { it.toJson() }
        field("classpaths", classpaths) { it.toJson() }
        field("dependencies", dependencies) { it.toJson() }
        field("projectDependencies", projectDependencies) { it.toJson() }
        field("targetVariants", targetVariants) { it.toJson() }
        field("sourceRoots", sourceRoots)
        field("classpath", classpath)
        rawField("hashes", hashes.toJson())
        field("commands", commands) { it.toJson() }
        field("diagnostics", diagnostics) { it.toJson() }
    }
}

class KotlinGradleProjectModelBackend {
    fun discover(request: KotlinGradleProjectModelRequest): KotlinGradleProjectModelResult {
        val projectRoot = request.projectRoot.toAbsolutePath().normalize()
        val initScript = Files.createTempFile("piece-kotlin-project-model-", ".gradle")
        val commands = mutableListOf<KotlinCommandResult>()
        val parsedDiagnostics = mutableListOf<KotlinGradleProjectModelDiagnostic>()

        try {
            initScript.writeText(gradleProjectModelInitScript(request.sourceSet))
            commands += runGradleProjectModelToolingApi(projectRoot, initScript, request.gradleVersion)
            if (commands.last().errorCode == "tooling-api-unavailable") {
                commands += runCommand(
                    command = request.gradleCommand,
                    args = listOf("-p", projectRoot.toString(), "--init-script", initScript.toString(), "-q", "printPieceKotlinProjectModel"),
                    cwd = projectRoot,
                )
            }

            val modelCommand = commands.last()
            val sourceSets = mutableListOf<KotlinGradleProjectModelSourceSet>()
            val classpaths = mutableListOf<KotlinGradleProjectModelClasspath>()
            val dependencies = mutableListOf<KotlinGradleProjectModelDependency>()
            val projectDependencies = mutableListOf<KotlinGradleProjectModelProjectDependency>()
            val targetVariants = mutableListOf<KotlinGradleProjectModelTargetVariant>()
            parseProjectModelOutput(
                modelCommand.stdout,
                sourceSets,
                classpaths,
                dependencies,
                projectDependencies,
                targetVariants,
                parsedDiagnostics,
            )

            val sourceRoots = sourceSets
                .flatMap { it.sourceRoots }
                .filter { it.isNotBlank() }
                .distinct()
                .sorted()
            val classpath = classpaths
                .flatMap { it.files }
                .filter { it.isNotBlank() }
                .distinct()
                .sorted()
            val commandDiagnostics = diagnosticsFromProjectModelCommands(commands)
            val status = if (commands.any { it.exitCode == 0 } && (sourceRoots.isNotEmpty() || classpath.isNotEmpty())) {
                "success"
            } else {
                "fallback"
            }
            val emptyDiagnostics = if (status == "fallback" && commandDiagnostics.isEmpty()) {
                listOf(
                    KotlinGradleProjectModelDiagnostic(
                        code = "kotlin-gradle-project-model-empty",
                        severity = "warning",
                        message = "Gradle project model discovery did not return Kotlin source roots or classpath entries.",
                    ),
                )
            } else {
                emptyList()
            }

            val sortedSourceSets = sourceSets.sortedWith(compareBy({ it.projectPath }, { it.name }))
            val sortedClasspaths = classpaths.sortedWith(compareBy({ it.projectPath }, { it.name }))
            val sortedDependencies = dependencies.sortedWith(compareBy({ it.projectPath }, { it.configuration }, { it.coordinates }))
            val sortedProjectDependencies = projectDependencies
                .distinct()
                .sortedWith(compareBy({ it.projectPath }, { it.configuration }, { it.dependencyProjectPath }))
            val sortedTargetVariants = targetVariants.sortedWith(compareBy({ it.projectPath }, { it.sourceSet }, { it.targetName }))
            val hashes = projectModelHashes(
                projectRoot = projectRoot.toString(),
                status = status,
                sourceSets = sortedSourceSets,
                classpaths = sortedClasspaths,
                dependencies = sortedDependencies,
                projectDependencies = sortedProjectDependencies,
                targetVariants = sortedTargetVariants,
                sourceRoots = sourceRoots,
                classpath = classpath,
            )

            return KotlinGradleProjectModelResult(
                projectRoot = projectRoot.toString(),
                status = status,
                sourceSets = sortedSourceSets,
                classpaths = sortedClasspaths,
                dependencies = sortedDependencies,
                projectDependencies = sortedProjectDependencies,
                targetVariants = sortedTargetVariants,
                sourceRoots = sourceRoots,
                classpath = classpath,
                hashes = hashes,
                commands = commands,
                diagnostics = parsedDiagnostics + commandDiagnostics + emptyDiagnostics,
            )
        } finally {
            Files.deleteIfExists(initScript)
        }
    }
}

private fun parseProjectModelOutput(
    stdout: String,
    sourceSets: MutableList<KotlinGradleProjectModelSourceSet>,
    classpaths: MutableList<KotlinGradleProjectModelClasspath>,
    dependencies: MutableList<KotlinGradleProjectModelDependency>,
    projectDependencies: MutableList<KotlinGradleProjectModelProjectDependency>,
    targetVariants: MutableList<KotlinGradleProjectModelTargetVariant>,
    diagnostics: MutableList<KotlinGradleProjectModelDiagnostic>,
) {
    stdout.lineSequence().forEach { rawLine ->
        val line = rawLine.trimEnd()
        when {
            line.startsWith("PIECE_KOTLIN_SOURCE_SET\t") -> {
                val parts = line.split('\t')
                if (parts.size >= 6) {
                    sourceSets += KotlinGradleProjectModelSourceSet(
                        projectPath = parts[1],
                        projectDir = parts[2],
                        name = parts[3],
                        sourceRoots = splitPathList(parts[4]),
                        targetNames = parts[5].split(',').map { it.trim() }.filter { it.isNotBlank() },
                    )
                }
            }

            line.startsWith("PIECE_KOTLIN_CLASSPATH\t") -> {
                val parts = line.split('\t')
                if (parts.size >= 4) {
                    classpaths += KotlinGradleProjectModelClasspath(
                        projectPath = parts[1],
                        name = parts[2],
                        files = splitPathList(parts[3]),
                    )
                }
            }

            line.startsWith("PIECE_KOTLIN_DEPENDENCY\t") -> {
                val parts = line.split('\t')
                if (parts.size >= 7) {
                    dependencies += KotlinGradleProjectModelDependency(
                        projectPath = parts[1],
                        configuration = parts[2],
                        group = parts[3],
                        name = parts[4],
                        version = parts[5],
                        coordinates = parts[6],
                    )
                }
            }

            line.startsWith("PIECE_KOTLIN_PROJECT_DEPENDENCY\t") -> {
                val parts = line.split('\t')
                if (parts.size >= 5) {
                    projectDependencies += KotlinGradleProjectModelProjectDependency(
                        projectPath = parts[1],
                        configuration = parts[2],
                        dependencyProjectPath = parts[3],
                        dependencyProjectDir = parts[4],
                    )
                }
            }

            line.startsWith("PIECE_KOTLIN_TARGET_VARIANT\t") -> {
                val parts = line.split('\t')
                if (parts.size >= 7) {
                    targetVariants += KotlinGradleProjectModelTargetVariant(
                        projectPath = parts[1],
                        sourceSet = parts[2],
                        targetName = parts[3],
                        compilationName = parts[4],
                        compileTask = parts[5],
                        classpathConfiguration = parts[6],
                    )
                }
            }

            line.startsWith("PIECE_KOTLIN_DIAGNOSTIC\t") -> {
                val parts = line.split('\t', limit = 4)
                if (parts.size >= 4) {
                    diagnostics += KotlinGradleProjectModelDiagnostic(
                        severity = parts[1],
                        code = parts[2],
                        message = parts[3],
                    )
                }
            }
        }
    }
}

private fun splitPathList(value: String): List<String> {
    return value
        .split(File.pathSeparator)
        .map { it.trim() }
        .filter { it.isNotBlank() }
}

internal fun projectModelHashes(
    projectRoot: String,
    status: String,
    sourceSets: List<KotlinGradleProjectModelSourceSet>,
    classpaths: List<KotlinGradleProjectModelClasspath>,
    dependencies: List<KotlinGradleProjectModelDependency>,
    projectDependencies: List<KotlinGradleProjectModelProjectDependency>,
    targetVariants: List<KotlinGradleProjectModelTargetVariant>,
    sourceRoots: List<String>,
    classpath: List<String>,
): KotlinGradleProjectModelHashes {
    val sourceRootsHash = hashGradleModelParts(sourceRoots)
    val classpathHash = hashGradleModelParts(classpath)
    val sourceSetParts = sourceSets.flatMap { sourceSet ->
        listOf(
            "sourceSet",
            sourceSet.projectPath,
            sourceSet.projectDir,
            sourceSet.name,
            sourceSet.sourceRoots.joinToString("\u001e"),
            sourceSet.targetNames.joinToString("\u001e"),
        )
    }
    val classpathParts = classpaths.flatMap { classpathEntry ->
        listOf(
            "classpath",
            classpathEntry.projectPath,
            classpathEntry.name,
            classpathEntry.files.joinToString("\u001e"),
        )
    }
    val dependencyParts = dependencies.flatMap { dependency ->
        listOf(
            "dependency",
            dependency.projectPath,
            dependency.configuration,
            dependency.coordinates,
        )
    }
    val projectDependencyParts = projectDependencies.flatMap { dependency ->
        listOf(
            "projectDependency",
            dependency.projectPath,
            dependency.configuration,
            dependency.dependencyProjectPath,
            dependency.dependencyProjectDir,
        )
    }
    val targetVariantParts = targetVariants.flatMap { variant ->
        listOf(
            "targetVariant",
            variant.projectPath,
            variant.sourceSet,
            variant.targetName,
            variant.compilationName,
            variant.compileTask,
            variant.classpathConfiguration,
        )
    }
    val modelHash = hashGradleModelParts(
        listOf("v1", projectRoot, status, sourceRootsHash, classpathHash) +
            sourceSetParts +
            classpathParts +
            dependencyParts +
            projectDependencyParts +
            targetVariantParts
    )
    return KotlinGradleProjectModelHashes(
        sourceRootsHash = sourceRootsHash,
        classpathHash = classpathHash,
        modelHash = modelHash,
    )
}

private fun hashGradleModelParts(parts: List<String>): String {
    return stableGradleModelTextHash(parts.joinToString("\u001f"))
}

private fun stableGradleModelTextHash(value: String): String {
    var hash = 0x811c9dc5L
    for (char in value) {
        hash = (hash xor char.code.toLong()) and 0xffffffffL
        hash = (hash * 0x01000193L) and 0xffffffffL
    }
    return java.lang.Long.toString(hash, 36)
}

private fun diagnosticsFromProjectModelCommands(commands: List<KotlinCommandResult>): List<KotlinGradleProjectModelDiagnostic> {
    return commands
        .filter { it.exitCode != 0 && it.errorCode != "tooling-api-unavailable" }
        .map { command ->
            KotlinGradleProjectModelDiagnostic(
                code = if (command.errorCode == "ENOENT") "tool-not-found" else "kotlin-gradle-project-model-error",
                severity = "warning",
                message = command.stderr.trim().ifBlank {
                    command.stdout.trim().ifBlank { "${command.command} exited with code ${command.exitCode}" }
                },
                command = (listOf(command.command) + command.args).joinToString(" "),
            )
        }
}

private fun runGradleProjectModelToolingApi(projectRoot: Path, initScript: Path, gradleVersion: String): KotlinCommandResult {
    val stdout = ByteArrayOutputStream()
    val stderr = ByteArrayOutputStream()
    var exitCode: Int? = 0
    var errorCode: String? = null
    val elapsed = measureTimeMillis {
        val previousClassLoader = Thread.currentThread().contextClassLoader
        var classLoader: URLClassLoader? = null
        try {
            val gradleHome = findGradleProjectModelGradleHome(gradleVersion)
                ?: error("Gradle $gradleVersion distribution is not available under GRADLE_USER_HOME.")
            val classpath = collectGradleProjectModelDistributionJars(gradleHome)
            if (classpath.none { it.fileName.toString().startsWith("gradle-tooling-api-") }) {
                error("Gradle Tooling API jar was not found in $gradleHome.")
            }

            classLoader = URLClassLoader(
                classpath.map { it.toUri().toURL() }.toTypedArray(),
                ClassLoader.getPlatformClassLoader(),
            )
            Thread.currentThread().contextClassLoader = classLoader
            runGradleProjectModelBuild(classLoader, projectRoot, initScript, gradleVersion, stdout, stderr)
        } catch (error: IllegalStateException) {
            exitCode = null
            errorCode = "tooling-api-unavailable"
            stderr.writeProjectModelText(error.message ?: error::class.java.simpleName)
        } catch (error: ClassNotFoundException) {
            exitCode = null
            errorCode = "tooling-api-unavailable"
            stderr.writeProjectModelText(error.message ?: error::class.java.simpleName)
        } catch (error: NoClassDefFoundError) {
            exitCode = null
            errorCode = "tooling-api-unavailable"
            stderr.writeProjectModelText(error.message ?: error::class.java.simpleName)
        } catch (error: InvocationTargetException) {
            exitCode = 1
            stderr.writeProjectModelText(error.targetException?.message ?: error.message ?: error::class.java.simpleName)
        } catch (error: Throwable) {
            exitCode = 1
            stderr.writeProjectModelText(error.message ?: error::class.java.simpleName)
        } finally {
            Thread.currentThread().contextClassLoader = previousClassLoader
            classLoader?.close()
        }
    }
    return KotlinCommandResult(
        command = "gradle-tooling-api",
        args = listOf("-p", projectRoot.toString(), "--init-script", initScript.toString(), "-q", "printPieceKotlinProjectModel"),
        cwd = projectRoot.toString(),
        exitCode = exitCode,
        stdout = stdout.toString(Charsets.UTF_8),
        stderr = stderr.toString(Charsets.UTF_8),
        errorCode = errorCode,
        durationMs = elapsed.toDouble(),
    )
}

private fun runGradleProjectModelBuild(
    classLoader: ClassLoader,
    projectRoot: Path,
    initScript: Path,
    gradleVersion: String,
    stdout: OutputStream,
    stderr: OutputStream,
) {
    val connectorClass = classLoader.loadClass("org.gradle.tooling.GradleConnector")
    val connector = connectorClass.getMethod("newConnector").invoke(null)
    connectorClass.getMethod("forProjectDirectory", File::class.java).invoke(connector, projectRoot.toFile())
    connectorClass.getMethod("useGradleVersion", String::class.java).invoke(connector, gradleVersion)
    val connection = connectorClass.getMethod("connect").invoke(connector)
    try {
        val projectConnectionClass = classLoader.loadClass("org.gradle.tooling.ProjectConnection")
        val buildLauncherClass = classLoader.loadClass("org.gradle.tooling.BuildLauncher")
        val longRunningOperationClass = classLoader.loadClass("org.gradle.tooling.LongRunningOperation")
        val build = projectConnectionClass.getMethod("newBuild").invoke(connection)
        buildLauncherClass.projectModelStringVarargMethod("forTasks").invoke(build, arrayOf("printPieceKotlinProjectModel") as Any)
        longRunningOperationClass.projectModelStringVarargMethod("withArguments").invoke(
            build,
            arrayOf("--init-script", initScript.toString(), "-q") as Any,
        )
        longRunningOperationClass.getMethod("setStandardOutput", OutputStream::class.java).invoke(build, stdout)
        longRunningOperationClass.getMethod("setStandardError", OutputStream::class.java).invoke(build, stderr)
        buildLauncherClass.getMethod("run").invoke(build)
    } finally {
        (connection as AutoCloseable).close()
    }
}

private fun Class<*>.projectModelStringVarargMethod(name: String): Method {
    return methods.firstOrNull { method ->
        method.name == name &&
            method.parameterTypes.size == 1 &&
            method.parameterTypes[0].isArray &&
            method.parameterTypes[0].componentType == String::class.java
    } ?: error("Unable to find $name(vararg) on ${this.name}.")
}

private fun findGradleProjectModelGradleHome(version: String): Path? {
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

private fun collectGradleProjectModelDistributionJars(gradleHome: Path): List<Path> {
    val lib = gradleHome.resolve("lib")
    if (!lib.exists()) return emptyList()
    return Files.walk(lib).use { stream ->
        stream
            .filter { Files.isRegularFile(it) && it.fileName.toString().endsWith(".jar") }
            .toList()
            .sortedBy { it.toString() }
    }
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

private fun gradleProjectModelInitScript(sourceSet: String?): String = """
gradle.projectsLoaded {
    def pieceFocusSourceSet = '${sourceSet.orEmpty().replace("\\", "\\\\").replace("'", "\\'")}'
    def pieceFocusTarget = pieceFocusSourceSet.replaceAll(/(Main|Test)${'$'}/, '').toLowerCase(java.util.Locale.ROOT)
    def pieceFocusIsTest = pieceFocusSourceSet.endsWith('Test')
    def pieceShouldResolveClasspath = { cfg ->
        if (!cfg.canBeResolved) {
            return false
        }
        def lowerName = cfg.name.toLowerCase(java.util.Locale.ROOT)
        if (!lowerName.contains('compileclasspath')) {
            return false
        }
        if (pieceFocusTarget.length() == 0 || pieceFocusTarget == 'common') {
            return true
        }
        if (!lowerName.contains(pieceFocusTarget)) {
            return false
        }
        return pieceFocusIsTest || !lowerName.contains('test')
    }
    def pieceCapitalize = { value ->
        return value == null || value.length() == 0 ? '' : value.substring(0, 1).toUpperCase(java.util.Locale.ROOT) + value.substring(1)
    }
    def pieceVariantForClasspath = { project, cfg ->
        def lowerName = cfg.name.toLowerCase(java.util.Locale.ROOT)
        def targetName = ''
        if (lowerName.startsWith('wasmjs')) {
            targetName = 'wasmJs'
        } else if (lowerName.startsWith('jvm')) {
            targetName = 'jvm'
        } else if (lowerName.startsWith('js')) {
            targetName = 'js'
        } else if (lowerName.startsWith('common')) {
            targetName = 'common'
        }
        if (targetName.length() == 0) {
            return null
        }
        def testVariant = lowerName.contains('test')
        def sourceSet = targetName + (testVariant ? 'Test' : 'Main')
        def compileTask = targetName == 'common'
            ? ''
            : (testVariant ? 'compileTestKotlin' : 'compileKotlin') + pieceCapitalize(targetName)
        return [sourceSet, targetName, testVariant ? 'test' : 'main', compileTask, cfg.name]
    }
    def root = gradle.rootProject
    if (root.tasks.findByName('printPieceKotlinProjectModel') == null) {
        root.tasks.register('printPieceKotlinProjectModel') {
            group = 'piece'
            doLast {
                def pieceEscape = { value ->
                    return (value == null ? '' : value.toString())
                        .replace('\t', ' ')
                        .replace('\r', ' ')
                        .replace('\n', ' ')
                }
                def pieceJoinPaths = { values ->
                    return values.collect { pieceEscape(it) }.join(File.pathSeparator)
                }
                root.allprojects.each { project ->
                    def kotlinExt = project.extensions.findByName('kotlin')
                    def targetNames = []
                    if (kotlinExt != null) {
                        try {
                            kotlinExt.targets.each { target ->
                                targetNames.add(target.name.toString())
                            }
                        } catch (Throwable ignored) {
                        }
                        try {
                            kotlinExt.sourceSets.each { sourceSet ->
                                def sourceRoots = []
                                try {
                                    sourceSet.kotlin.srcDirs.each { dir ->
                                        if (dir.exists()) {
                                            sourceRoots.add(dir.absolutePath)
                                        }
                                    }
                                } catch (Throwable error) {
                                    println('PIECE_KOTLIN_DIAGNOSTIC\twarning\tkotlin-gradle-source-roots-unavailable\t' + pieceEscape(error.message))
                                }
                                println('PIECE_KOTLIN_SOURCE_SET\t' + pieceEscape(project.path) + '\t' + pieceEscape(project.projectDir.absolutePath) + '\t' + pieceEscape(sourceSet.name) + '\t' + pieceJoinPaths(sourceRoots) + '\t' + targetNames.collect { pieceEscape(it) }.join(','))
                            }
                        } catch (Throwable error) {
                            println('PIECE_KOTLIN_DIAGNOSTIC\twarning\tkotlin-gradle-source-sets-unavailable\t' + pieceEscape(error.message))
                        }
                    }
                    project.configurations.findAll { cfg -> pieceShouldResolveClasspath(cfg) }.each { cfg ->
                        try {
                            def files = cfg.resolve().findAll { file -> file.exists() }.collect { file -> file.absolutePath }.sort()
                            try {
                                cfg.incoming.resolutionResult.allComponents.each { component ->
                                    def componentId = component.id
                                    if (componentId instanceof org.gradle.api.artifacts.component.ProjectComponentIdentifier && componentId.projectPath != project.path) {
                                        def dependencyProject = root.findProject(componentId.projectPath)
                                        def dependencyProjectDir = dependencyProject == null ? '' : dependencyProject.projectDir.absolutePath
                                        println('PIECE_KOTLIN_PROJECT_DEPENDENCY\t' + pieceEscape(project.path) + '\t' + pieceEscape(cfg.name) + '\t' + pieceEscape(componentId.projectPath) + '\t' + pieceEscape(dependencyProjectDir))
                                    }
                                }
                            } catch (Throwable error) {
                                println('PIECE_KOTLIN_DIAGNOSTIC\twarning\tkotlin-gradle-project-dependencies-unavailable\t' + pieceEscape(cfg.name + ': ' + error.message))
                            }
                            println('PIECE_KOTLIN_CLASSPATH\t' + pieceEscape(project.path) + '\t' + pieceEscape(cfg.name) + '\t' + pieceJoinPaths(files))
                            def variant = pieceVariantForClasspath(project, cfg)
                            if (variant != null) {
                                println('PIECE_KOTLIN_TARGET_VARIANT\t' + pieceEscape(project.path) + '\t' + pieceEscape(variant[0]) + '\t' + pieceEscape(variant[1]) + '\t' + pieceEscape(variant[2]) + '\t' + pieceEscape(variant[3]) + '\t' + pieceEscape(variant[4]))
                            }
                            try {
                                cfg.resolvedConfiguration.firstLevelModuleDependencies.each { dependency ->
                                    def group = dependency.moduleGroup == null ? '' : dependency.moduleGroup.toString()
                                    def name = dependency.moduleName == null ? '' : dependency.moduleName.toString()
                                    def version = dependency.moduleVersion == null ? '' : dependency.moduleVersion.toString()
                                    if (group.length() > 0 && name.length() > 0 && version.length() > 0) {
                                        println('PIECE_KOTLIN_DEPENDENCY\t' + pieceEscape(project.path) + '\t' + pieceEscape(cfg.name) + '\t' + pieceEscape(group) + '\t' + pieceEscape(name) + '\t' + pieceEscape(version) + '\t' + pieceEscape(group + ':' + name + ':' + version))
                                    }
                                }
                            } catch (Throwable error) {
                                println('PIECE_KOTLIN_DIAGNOSTIC\twarning\tkotlin-gradle-dependencies-unavailable\t' + pieceEscape(cfg.name + ': ' + error.message))
                            }
                        } catch (Throwable error) {
                            println('PIECE_KOTLIN_DIAGNOSTIC\twarning\tkotlin-gradle-classpath-unavailable\t' + pieceEscape(cfg.name + ': ' + error.message))
                        }
                    }
                }
            }
        }
    }
}
""".trimIndent()

private fun ByteArrayOutputStream.writeProjectModelText(value: String) {
    write(value.toByteArray(Charsets.UTF_8))
}

private class GradleModelJsonObjectBuilder {
    private val fields = mutableListOf<String>()

    fun field(name: String, value: String) {
        fields += "${name.gradleModelJsonString()}:${value.gradleModelJsonString()}"
    }

    fun field(name: String, value: Number) {
        fields += "${name.gradleModelJsonString()}:$value"
    }

    fun nullField(name: String) {
        fields += "${name.gradleModelJsonString()}:null"
    }

    fun <T> field(name: String, values: List<T>, encode: (T) -> String) {
        fields += "${name.gradleModelJsonString()}:${values.joinToString(prefix = "[", postfix = "]") { encode(it) }}"
    }

    fun rawField(name: String, value: String) {
        fields += "${name.gradleModelJsonString()}:$value"
    }

    fun field(name: String, values: List<String>) {
        fields += "${name.gradleModelJsonString()}:${values.joinToString(prefix = "[", postfix = "]") { it.gradleModelJsonString() }}"
    }

    fun build(): String = fields.joinToString(prefix = "{", postfix = "}")
}

private fun buildGradleModelJsonObject(init: GradleModelJsonObjectBuilder.() -> Unit): String {
    return GradleModelJsonObjectBuilder().apply(init).build()
}

private fun KotlinGradleProjectModelSourceSet.toJson(): String = buildGradleModelJsonObject {
    field("projectPath", projectPath)
    field("projectDir", projectDir)
    field("name", name)
    field("sourceRoots", sourceRoots)
    field("targetNames", targetNames)
}

private fun KotlinGradleProjectModelClasspath.toJson(): String = buildGradleModelJsonObject {
    field("projectPath", projectPath)
    field("name", name)
    field("files", files)
}

private fun KotlinGradleProjectModelDependency.toJson(): String = buildGradleModelJsonObject {
    field("projectPath", projectPath)
    field("configuration", configuration)
    field("group", group)
    field("name", name)
    field("version", version)
    field("coordinates", coordinates)
}

private fun KotlinGradleProjectModelProjectDependency.toJson(): String = buildGradleModelJsonObject {
    field("projectPath", projectPath)
    field("configuration", configuration)
    field("dependencyProjectPath", dependencyProjectPath)
    field("dependencyProjectDir", dependencyProjectDir)
}

private fun KotlinGradleProjectModelTargetVariant.toJson(): String = buildGradleModelJsonObject {
    field("projectPath", projectPath)
    field("sourceSet", sourceSet)
    field("targetName", targetName)
    field("compilationName", compilationName)
    field("compileTask", compileTask)
    field("classpathConfiguration", classpathConfiguration)
}

private fun KotlinGradleProjectModelHashes.toJson(): String = buildGradleModelJsonObject {
    field("sourceRootsHash", sourceRootsHash)
    field("classpathHash", classpathHash)
    field("modelHash", modelHash)
}

private fun KotlinCommandResult.toJson(): String = buildGradleModelJsonObject {
    field("command", command)
    field("args", args)
    field("cwd", cwd)
    exitCode?.let { field("exitCode", it) } ?: nullField("exitCode")
    signal?.let { field("signal", it) }
    field("stdout", stdout)
    field("stderr", stderr)
    errorCode?.let { field("errorCode", it) }
    field("durationMs", durationMs)
}

private fun KotlinGradleProjectModelDiagnostic.toJson(): String = buildGradleModelJsonObject {
    field("code", code)
    field("severity", severity)
    field("message", message)
    command?.let { field("command", it) }
}

private fun String.gradleModelJsonString(): String {
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
