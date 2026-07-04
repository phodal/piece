@file:OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)

plugins {
    kotlin("multiplatform") version "2.2.21"
}

group = "cc.phodal.piece"
version = "0.1.0"

val antlrTool = configurations.create("antlrTool")
val generatedPicAntlrDir = layout.buildDirectory.dir("generated/antlr/pic")

kotlin {
    jvm()
    js(IR) {
        nodejs()
        binaries.library()
    }
    wasmJs {
        browser {
            testTask {
                enabled = false
            }
        }
        binaries.executable()
    }

    sourceSets {
        jvmMain.dependencies {
            implementation("org.jetbrains.kotlin:kotlin-compiler-embeddable:2.2.21")
            implementation("org.antlr:antlr4-runtime:4.13.2")
        }

        commonTest.dependencies {
            implementation(kotlin("test"))
        }
    }
}

dependencies {
    antlrTool("org.antlr:antlr4:4.13.2")
}

val generatePicAntlr = tasks.register<JavaExec>("generatePicAntlr") {
    val grammarFile = layout.projectDirectory.file("../grammar/Piece.g4")
    inputs.file(grammarFile)
    outputs.dir(generatedPicAntlrDir)
    classpath = antlrTool
    mainClass.set("org.antlr.v4.Tool")
    args(
        "-visitor",
        "-no-listener",
        "-package",
        "piece.pic.antlr",
        "-Xexact-output-dir",
        "-o",
        generatedPicAntlrDir.get().asFile.absolutePath,
        grammarFile.asFile.absolutePath,
    )
}

extensions.configure<org.gradle.api.tasks.SourceSetContainer>("sourceSets") {
    named("jvmMain") {
        java.srcDir(generatedPicAntlrDir)
    }
}

tasks.named("compileJvmMainJava") {
    dependsOn(generatePicAntlr)
}

tasks.named("compileKotlinJvm") {
    dependsOn(generatePicAntlr)
}

tasks.register<JavaExec>("runKotlinCompileBackend") {
    dependsOn("jvmMainClasses")

    val jvmCompilation = kotlin.targets.getByName("jvm").compilations.getByName("main")
    mainClass.set("piece.kotlin.KotlinCompileBackendCliKt")
    classpath = files(jvmCompilation.output.allOutputs, jvmCompilation.runtimeDependencyFiles)

    doFirst {
        val sourceFile = providers.gradleProperty("pieceCompile.sourceFile").orNull
            ?: error("Missing -PpieceCompile.sourceFile=<path>")
        val outputReport = providers.gradleProperty("pieceCompile.outputReport").orNull
            ?: error("Missing -PpieceCompile.outputReport=<path>")
        val cliArgs = mutableListOf(
            "--filePath=${providers.gradleProperty("pieceCompile.filePath").orNull ?: "Main.kt"}",
            "--sourceFile=$sourceFile",
            "--target=${providers.gradleProperty("pieceCompile.target").orNull ?: "jvm"}",
            "--sourceSet=${providers.gradleProperty("pieceCompile.sourceSet").orNull ?: ""}",
            "--gradleCommand=${providers.gradleProperty("pieceCompile.gradleCommand").orNull ?: rootProject.file("gradlew").absolutePath}",
            "--gradleVersion=${providers.gradleProperty("pieceCompile.gradleVersion").orNull ?: gradle.gradleVersion}",
            "--kotlinPluginVersion=${providers.gradleProperty("pieceCompile.kotlinPluginVersion").orNull ?: ""}",
            "--tasks=${providers.gradleProperty("pieceCompile.tasks").orNull ?: ""}",
            "--outputReport=$outputReport",
            "--keepWorkspace=${providers.gradleProperty("pieceCompile.keepWorkspace").orNull ?: "false"}",
            "--companionSources=${providers.gradleProperty("pieceCompile.companionSources").orNull ?: ""}",
            "--pieceTargetLabel=${providers.gradleProperty("pieceCompile.pieceTargetLabel").orNull ?: ""}",
            "--pieceActionId=${providers.gradleProperty("pieceCompile.pieceActionId").orNull ?: ""}",
            "--pieceArtifactId=${providers.gradleProperty("pieceCompile.pieceArtifactId").orNull ?: ""}",
            "--pieceActionKind=${providers.gradleProperty("pieceCompile.pieceActionKind").orNull ?: ""}",
            "--pieceTarget=${providers.gradleProperty("pieceCompile.pieceTarget").orNull ?: ""}",
            "--pieceActionName=${providers.gradleProperty("pieceCompile.pieceActionName").orNull ?: ""}",
        )
        providers.gradleProperty("pieceCompile.workspace").orNull?.takeIf { it.isNotBlank() }?.let {
            cliArgs += "--workspace=$it"
        }
        setArgs(cliArgs)
    }
}

tasks.register<JavaExec>("runPicParserBackend") {
    dependsOn("jvmMainClasses")

    val jvmCompilation = kotlin.targets.getByName("jvm").compilations.getByName("main")
    mainClass.set("piece.pic.PicParserCli")
    classpath = files(jvmCompilation.output.allOutputs, jvmCompilation.runtimeDependencyFiles)

    doFirst {
        val sourceFile = providers.gradleProperty("pieceDsl.sourceFile").orNull
            ?: error("Missing -PpieceDsl.sourceFile=<path>")
        val outputReport = providers.gradleProperty("pieceDsl.outputReport").orNull
            ?: error("Missing -PpieceDsl.outputReport=<path>")
        setArgs(
            listOf(
                "--filePath=${providers.gradleProperty("pieceDsl.filePath").orNull ?: "package.pic"}",
                "--sourceFile=$sourceFile",
                "--outputReport=$outputReport",
            ),
        )
    }
}

tasks.register<JavaExec>("runKotlinPicGeneratorBackend") {
    dependsOn("jvmMainClasses")

    val jvmCompilation = kotlin.targets.getByName("jvm").compilations.getByName("main")
    mainClass.set("piece.kotlin.KotlinPicGeneratorBackendCliKt")
    classpath = files(jvmCompilation.output.allOutputs, jvmCompilation.runtimeDependencyFiles)

    doFirst {
        val sourceFile = providers.gradleProperty("piecePic.sourceFile").orNull
            ?: error("Missing -PpiecePic.sourceFile=<path>")
        val outputReport = providers.gradleProperty("piecePic.outputReport").orNull
            ?: error("Missing -PpiecePic.outputReport=<path>")
        setArgs(
            listOf(
                "--filePath=${providers.gradleProperty("piecePic.filePath").orNull ?: "Main.kt"}",
                "--sourceFile=$sourceFile",
                "--outputReport=$outputReport",
            ),
        )
    }
}

tasks.register<JavaExec>("runKotlinPsiAnalysisBackend") {
    dependsOn("jvmMainClasses")

    val jvmCompilation = kotlin.targets.getByName("jvm").compilations.getByName("main")
    mainClass.set("piece.kotlin.KotlinPsiAnalysisBackendCliKt")
    classpath = files(jvmCompilation.output.allOutputs, jvmCompilation.runtimeDependencyFiles)

    doFirst {
        val sourceFile = providers.gradleProperty("pieceAnalysis.sourceFile").orNull
            ?: error("Missing -PpieceAnalysis.sourceFile=<path>")
        val outputReport = providers.gradleProperty("pieceAnalysis.outputReport").orNull
            ?: error("Missing -PpieceAnalysis.outputReport=<path>")
        setArgs(
            listOf(
                "--filePath=${providers.gradleProperty("pieceAnalysis.filePath").orNull ?: "Main.kt"}",
                "--sourceFile=$sourceFile",
                "--outputReport=$outputReport",
                "--parserName=${providers.gradleProperty("pieceAnalysis.parserName").orNull ?: "kotlin-psi-declaration-extractor"}",
                "--semanticDiagnostics=${providers.gradleProperty("pieceAnalysis.semanticDiagnostics").orNull ?: "false"}",
                "--semanticSymbols=${providers.gradleProperty("pieceAnalysis.semanticSymbols").orNull ?: "false"}",
                "--companionSources=${providers.gradleProperty("pieceAnalysis.companionSources").orNull ?: ""}",
                "--classpathFile=${providers.gradleProperty("pieceAnalysis.classpathFile").orNull ?: ""}",
            ),
        )
    }
}
