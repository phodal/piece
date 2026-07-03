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
