package piece.dsl

import piece.model.PieceAction
import piece.model.PieceActionKind
import piece.model.PieceArtifact
import piece.model.PiecePackage
import piece.model.PieceRule
import piece.model.PieceTarget
import piece.model.PieceTargetKind
import piece.model.pieceNormalizeDep
import piece.model.piecePackageName
import piece.model.pieceSourceLabel
import piece.model.pieceTargetLabel

data class PieceActionSpec(
    val name: String,
    val kind: PieceActionKind,
    val artifactKind: String,
)

@DslMarker
annotation class PieceDsl

fun pieceFile(filePath: String, init: PieceFileBuilder.() -> Unit): PiecePackage {
    return PieceFileBuilder(filePath).apply(init).build()
}

@PieceDsl
class PieceFileBuilder(private val filePath: String) {
    var language: String = "generic"
    private val targetBuilders = mutableListOf<PieceTargetBuilder>()

    fun kotlin(): String = "kotlin"

    fun go(): String = "go"

    fun typescript(): String = "typescript"

    fun javascript(): String = "javascript"

    fun target(name: String, init: PieceTargetBuilder.() -> Unit) {
        targetBuilders += PieceTargetBuilder(filePath, name).apply(init)
    }

    fun build(): PiecePackage {
        val packageName = piecePackageName(filePath)
        val sourceLabel = pieceSourceLabel(filePath)
        val targetLabelsByName = targetBuilders.associate { builder ->
            builder.name to pieceTargetLabel(filePath, builder.rule, builder.name)
        }
        val targetPairs = targetBuilders.map { builder ->
            builder to builder.build(language, packageName, sourceLabel, targetLabelsByName)
        }
        val targets = targetPairs.map { it.second }
        val rules = targetPairs
            .map { (builder, target) ->
                val actionKind = builder.primaryActionKind()
                PieceRule(
                    name = target.rule,
                    language = language,
                    targetKind = target.kind,
                    actionKind = actionKind,
                    implementation = "$language.${target.kind.name.lowercase()}.${actionKind.name.lowercase()}",
                )
            }
            .distinctBy { it.name }
            .sortedBy { it.name }
        val actions = targetPairs.flatMap { (builder, target) ->
            builder.actionSpecs.map { spec ->
                PieceAction(
                    id = "${target.label}%${spec.name}",
                    target = target.label,
                    kind = spec.kind,
                    inputs = listOf(target.source) + target.deps + target.externalDeps,
                    outputs = listOf(builder.artifactId(target.label, spec)),
                )
            }
        }
        val artifacts = targetPairs.flatMap { (builder, target) ->
            builder.actionSpecs.map { spec ->
                val artifactId = builder.artifactId(target.label, spec)
                PieceArtifact(
                    id = artifactId,
                    target = target.label,
                    kind = spec.artifactKind,
                    path = artifactId.replace("//", "").replace(":", "__"),
                )
            }
        }
        return PiecePackage(
            language = language,
            packageName = packageName,
            label = sourceLabel,
            filePath = filePath,
            sourceFile = sourceLabel,
            rules = rules,
            targets = targets,
            actions = actions,
            artifacts = artifacts,
        )
    }
}

@PieceDsl
class PieceTargetBuilder(private val filePath: String, internal val name: String) {
    var rule: PieceTargetKind = PieceTargetKind.Function
    private val deps = mutableListOf<String>()
    internal val actionSpecs = mutableListOf(PieceActionSpec("analysis", PieceActionKind.Feedback, "piece-feedback"))

    fun type(): PieceTargetKind = PieceTargetKind.Type

    fun klass(): PieceTargetKind = PieceTargetKind.Class

    fun function(): PieceTargetKind = PieceTargetKind.Function

    fun value(): PieceTargetKind = PieceTargetKind.Value

    fun deps(vararg labels: String) {
        deps += labels
    }

    fun feedback(name: String): PieceActionSpec = PieceActionSpec(name, PieceActionKind.Feedback, "piece-feedback")

    fun compile(name: String = "compile"): PieceActionSpec = PieceActionSpec(name, PieceActionKind.Compile, "piece-compile")

    fun action(name: String) {
        actionSpecs.clear()
        actionSpecs += feedback(name)
    }

    fun action(spec: PieceActionSpec) {
        actionSpecs.clear()
        actionSpecs += spec
    }

    fun actions(vararg specs: PieceActionSpec) {
        actionSpecs.clear()
        actionSpecs += specs
    }

    fun build(language: String, packageName: String, sourceLabel: String, targetLabelsByName: Map<String, String>): PieceTarget {
        val ruleName = "${language}_piece_${rule.name.lowercase()}"
        val label = pieceTargetLabel(filePath, rule, name)
        val normalizedDeps = deps.map { pieceNormalizeDep(packageName, it, targetLabelsByName) }.sorted()
        return PieceTarget(
            id = "$filePath#${rule.name.lowercase()}:$name",
            label = label,
            name = name,
            kind = rule,
            rule = ruleName,
            source = sourceLabel,
            deps = normalizedDeps,
            runtimeDeps = normalizedDeps,
            actions = actionSpecs.map { "$label%${it.name}" },
            artifacts = actionSpecs.map { artifactId(label, it) },
        )
    }

    internal fun artifactId(label: String, spec: PieceActionSpec): String {
        return when (spec.kind) {
            PieceActionKind.Feedback -> "$label.piece.json"
            PieceActionKind.Compile -> "$label.compile.json"
            else -> "$label.${spec.name}.json"
        }
    }

    internal fun primaryActionKind(): PieceActionKind = actionSpecs.firstOrNull()?.kind ?: PieceActionKind.Feedback
}
