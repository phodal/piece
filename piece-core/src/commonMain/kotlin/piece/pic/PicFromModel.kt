package piece.pic

import piece.model.PieceAction
import piece.model.PieceActionKind
import piece.model.PieceArtifact
import piece.model.PiecePackage
import piece.model.PieceTarget
import piece.model.PieceTargetKind
import piece.model.pieceTargetLabel

fun piecePackageToPicDsl(piecePackage: PiecePackage): String {
    validatePicIdentifier(piecePackage.language, "language")
    val actionsById = piecePackage.actions.associateBy { it.id }
    val artifactsById = piecePackage.artifacts.associateBy { it.id }
    val builder = StringBuilder()
    builder.append("package ")
        .append(piecePackage.label.picString())
        .append(" {\n")
    builder.append("  language ").append(piecePackage.language).append('\n')
    builder.append("  source ").append(piecePackage.filePath.picString()).append('\n')

    for (target in piecePackage.targets) {
        builder.append('\n')
        builder.append("  target ")
            .append(target.kind.picToken())
            .append(' ')
            .append(target.name.picString())
            .append(" {\n")
        appendSource(builder, piecePackage, target)
        appendLabel(builder, piecePackage, target)
        appendVisibility(builder, target.visibility)
        appendDeps(builder, "deps", target.unclassifiedDeps())
        appendDeps(builder, "runtimeDeps", target.runtimeDeps)
        appendDeps(builder, "typeDeps", target.typeDeps)
        appendDeps(builder, "externalDeps", target.externalDeps)
        appendActions(builder, target, actionsById, artifactsById)
        builder.append("  }\n")
    }

    builder.append("}\n")
    return builder.toString()
}

fun PiecePackage.toPicDsl(): String = piecePackageToPicDsl(this)

private fun appendLabel(builder: StringBuilder, piecePackage: PiecePackage, target: PieceTarget) {
    val defaultLabel = pieceTargetLabel(target.sourcePath(piecePackage), target.kind, target.name)
    if (target.label == defaultLabel) return
    builder.append("    label ")
        .append(target.label.picString())
        .append('\n')
}

private fun appendSource(builder: StringBuilder, piecePackage: PiecePackage, target: PieceTarget) {
    val packageSource = piece.model.pieceSourceLabel(piecePackage.filePath)
    if (target.source == packageSource) return
    builder.append("    source ")
        .append(target.source.picString())
        .append('\n')
}

private fun PieceTarget.sourcePath(piecePackage: PiecePackage): String {
    return if (source.startsWith("//")) sourcePathFromLabel(source) ?: piecePackage.filePath else source
}

private fun sourcePathFromLabel(label: String): String? {
    if (!label.startsWith("//")) return null
    val separator = label.indexOf(':')
    if (separator < 0) return null
    val packageName = label.substring(2, separator)
    val sourceName = label.substring(separator + 1)
    return "/${listOf(packageName, sourceName).filter { it.isNotBlank() && it != "." }.joinToString("/")}"
}

private fun appendVisibility(builder: StringBuilder, visibility: List<String>) {
    val unique = visibility.distinct().sorted()
    if (unique.isEmpty() || unique == listOf("//visibility:private")) return
    builder.append("    visibility ")
        .append(unique.joinToString(", ") { it.picString() })
        .append('\n')
}

private fun appendDeps(builder: StringBuilder, name: String, values: List<String>) {
    if (values.isEmpty()) return
    builder.append("    ")
        .append(name)
        .append(' ')
        .append(values.distinct().sorted().joinToString(", ") { it.picString() })
        .append('\n')
}

private fun PieceTarget.unclassifiedDeps(): List<String> {
    val classified = (runtimeDeps + typeDeps).toSet()
    return deps.filterNot { it in classified }.distinct().sorted()
}

private fun appendActions(
    builder: StringBuilder,
    target: PieceTarget,
    actionsById: Map<String, PieceAction>,
    artifactsById: Map<String, PieceArtifact>,
) {
    val actionIds = target.actions.ifEmpty { listOf("${target.label}%feedback") }
    for (actionId in actionIds) {
        val action = actionsById[actionId]
        val kind = action?.kind ?: actionKindFromId(actionId)
        val artifactId = defaultArtifactId(target.label, kind)
        val artifact = artifactsById[artifactId]
        val defaultMnemonic = "Piece${kind.name}"
        val defaultPath = artifactId.replace("//", "").replace(":", "__")
        val defaultInputs = (listOf(target.source) + target.deps + target.externalDeps).toSet()
        val mnemonic = action?.mnemonic?.takeIf { it != defaultMnemonic }
        val output = action?.outputs?.singleOrNull()?.takeIf { it != artifactId }
        val path = artifact?.path?.takeIf { it != defaultPath && it != output }
        val inputs = action?.inputs
            ?.filterNot { it in defaultInputs }
            ?.distinct()
            ?.sorted()
            .orEmpty()

        if (mnemonic == null && output == null && path == null && inputs.isEmpty()) {
            builder.append("    action ").append(kind.picToken()).append(" {}\n")
            continue
        }

        builder.append("    action ").append(kind.picToken()).append(" {\n")
        if (mnemonic != null) {
            builder.append("      mnemonic ").append(mnemonic.picString()).append('\n')
        }
        if (output != null) {
            builder.append("      output ").append(output.picString()).append('\n')
        }
        if (path != null) {
            builder.append("      path ").append(path.picString()).append('\n')
        }
        appendActionInputs(builder, inputs)
        builder.append("    }\n")
    }
}

private fun appendActionInputs(builder: StringBuilder, inputs: List<String>) {
    if (inputs.isEmpty()) return
    builder.append("      inputs ")
        .append(inputs.joinToString(", ") { it.picString() })
        .append('\n')
}

private fun actionKindFromId(actionId: String): PieceActionKind {
    return when (actionId.substringAfterLast('%')) {
        "compile" -> PieceActionKind.Compile
        "preview" -> PieceActionKind.Preview
        "test" -> PieceActionKind.Test
        "typecheck" -> PieceActionKind.Typecheck
        "documentation" -> PieceActionKind.Documentation
        else -> PieceActionKind.Feedback
    }
}

private fun defaultArtifactId(label: String, kind: PieceActionKind): String {
    return when (kind) {
        PieceActionKind.Feedback -> "$label.piece.json"
        PieceActionKind.Compile -> "$label.compile.json"
        PieceActionKind.Preview -> "$label.preview.json"
        PieceActionKind.Test -> "$label.test.json"
        PieceActionKind.Typecheck -> "$label.typecheck.json"
        PieceActionKind.Documentation -> "$label.documentation.json"
    }
}

private fun PieceTargetKind.picToken(): String {
    return when (this) {
        PieceTargetKind.Type -> "type"
        PieceTargetKind.Class -> "class"
        PieceTargetKind.Function -> "function"
        PieceTargetKind.Value -> "value"
        PieceTargetKind.Effect -> "effect"
        PieceTargetKind.Header -> "header"
    }
}

private fun PieceActionKind.picToken(): String {
    return when (this) {
        PieceActionKind.Feedback -> "feedback"
        PieceActionKind.Compile -> "compile"
        PieceActionKind.Preview -> "preview"
        PieceActionKind.Test -> "test"
        PieceActionKind.Typecheck -> "typecheck"
        PieceActionKind.Documentation -> "documentation"
    }
}

private fun validatePicIdentifier(value: String, label: String) {
    require(value.matches(PIC_IDENTIFIER)) {
        "$label must be a valid .pic identifier: $value"
    }
}

private val PIC_IDENTIFIER = Regex("[A-Za-z_][A-Za-z0-9_.-]*")

private fun String.picString(): String {
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
