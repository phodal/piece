@file:OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)

plugins {
    kotlin("multiplatform") version "2.2.21"
}

group = "cc.phodal.piece"
version = "0.1.0"

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
        }

        commonTest.dependencies {
            implementation(kotlin("test"))
        }
    }
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
            "--kotlinPluginVersion=${providers.gradleProperty("pieceCompile.kotlinPluginVersion").orNull ?: ""}",
            "--tasks=${providers.gradleProperty("pieceCompile.tasks").orNull ?: ""}",
            "--outputReport=$outputReport",
            "--keepWorkspace=${providers.gradleProperty("pieceCompile.keepWorkspace").orNull ?: "false"}",
        )
        providers.gradleProperty("pieceCompile.workspace").orNull?.takeIf { it.isNotBlank() }?.let {
            cliArgs += "--workspace=$it"
        }
        setArgs(cliArgs)
    }
}
