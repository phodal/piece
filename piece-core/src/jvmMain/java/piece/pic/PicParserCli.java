package piece.pic;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import piece.model.PieceAction;
import piece.model.PieceArtifact;
import piece.model.PiecePackage;
import piece.model.PieceRule;
import piece.model.PieceTarget;

public final class PicParserCli {
    private PicParserCli() {
    }

    public static void main(String[] args) throws IOException {
        Map<String, String> options = parseOptions(args);
        String sourceFile = required(options, "sourceFile");
        String outputReport = required(options, "outputReport");
        String filePath = options.getOrDefault("filePath", "package.pic");
        String source = Files.readString(Path.of(sourceFile), StandardCharsets.UTF_8);

        PicParseResult result = new AntlrPicParserBackend().parse(source);
        Files.createDirectories(Path.of(outputReport).getParent());
        Files.writeString(Path.of(outputReport), toJson(filePath, source, result) + "\n", StandardCharsets.UTF_8);
        if (result.getDiagnostics().stream().anyMatch(diagnostic -> "error".equals(diagnostic.getSeverity()))) {
            System.exit(1);
        }
    }

    private static Map<String, String> parseOptions(String[] args) {
        Map<String, String> options = new LinkedHashMap<>();
        for (String arg : args) {
            if (!arg.startsWith("--")) {
                continue;
            }
            int separator = arg.indexOf('=');
            if (separator < 0) {
                options.put(arg.substring(2), "");
            } else {
                options.put(arg.substring(2, separator), arg.substring(separator + 1));
            }
        }
        return options;
    }

    private static String required(Map<String, String> options, String name) {
        String value = options.get(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Missing --" + name + "=<value>");
        }
        return value;
    }

    private static String toJson(String filePath, String source, PicParseResult result) {
        JsonObject json = new JsonObject()
            .field("version", 1)
            .field("parser", "antlr-pic-parser")
            .field("filePath", filePath)
            .field("source", source)
            .field("diagnostics", result.getDiagnostics(), PicParserCli::diagnosticJson);
        if (result.getPiecePackage() == null) {
            json.rawField("piecePackage", "null");
        } else {
            json.rawField("piecePackage", packageJson(result.getPiecePackage()));
        }
        return json.build();
    }

    private static String packageJson(PiecePackage piecePackage) {
        return new JsonObject()
            .field("version", piecePackage.getVersion())
            .field("kind", piecePackage.getKind())
            .field("language", piecePackage.getLanguage())
            .field("packageName", piecePackage.getPackageName())
            .field("label", piecePackage.getLabel())
            .field("filePath", piecePackage.getFilePath())
            .field("sourceFile", piecePackage.getSourceFile())
            .field("rules", piecePackage.getRules(), PicParserCli::ruleJson)
            .field("targets", piecePackage.getTargets(), PicParserCli::targetJson)
            .field("actions", piecePackage.getActions(), PicParserCli::actionJson)
            .field("artifacts", piecePackage.getArtifacts(), PicParserCli::artifactJson)
            .build();
    }

    private static String ruleJson(PieceRule rule) {
        return new JsonObject()
            .field("name", rule.getName())
            .field("language", rule.getLanguage())
            .field("targetKind", lower(rule.getTargetKind().name()))
            .field("actionKind", lower(rule.getActionKind().name()))
            .field("implementation", rule.getImplementation())
            .build();
    }

    private static String targetJson(PieceTarget target) {
        return new JsonObject()
            .field("id", target.getId())
            .field("label", target.getLabel())
            .field("name", target.getName())
            .field("kind", lower(target.getKind().name()))
            .field("rule", target.getRule())
            .field("source", target.getSource())
            .field("deps", target.getDeps())
            .field("runtimeDeps", target.getRuntimeDeps())
            .field("typeDeps", target.getTypeDeps())
            .field("externalDeps", target.getExternalDeps())
            .field("actions", target.getActions())
            .field("artifacts", target.getArtifacts())
            .field("visibility", target.getVisibility())
            .build();
    }

    private static String actionJson(PieceAction action) {
        return new JsonObject()
            .field("id", action.getId())
            .field("target", action.getTarget())
            .field("kind", lower(action.getKind().name()))
            .field("mnemonic", action.getMnemonic())
            .field("inputs", action.getInputs())
            .field("outputs", action.getOutputs())
            .build();
    }

    private static String artifactJson(PieceArtifact artifact) {
        JsonObject json = new JsonObject()
            .field("id", artifact.getId())
            .field("target", artifact.getTarget())
            .field("kind", artifact.getKind())
            .field("path", artifact.getPath());
        if (artifact.getCacheKey() != null) {
            json.field("cacheKey", artifact.getCacheKey());
        }
        return json.build();
    }

    private static String diagnosticJson(PicDiagnostic diagnostic) {
        JsonObject json = new JsonObject()
            .field("code", diagnostic.getCode())
            .field("severity", diagnostic.getSeverity())
            .field("message", diagnostic.getMessage());
        if (diagnostic.getLine() != null) {
            json.field("line", diagnostic.getLine());
        }
        if (diagnostic.getColumn() != null) {
            json.field("column", diagnostic.getColumn());
        }
        return json.build();
    }

    private static String lower(String value) {
        return value.toLowerCase(Locale.ROOT);
    }

    private static final class JsonObject {
        private final List<String> fields = new java.util.ArrayList<>();

        JsonObject field(String name, String value) {
            fields.add(jsonString(name) + ":" + jsonString(value));
            return this;
        }

        JsonObject field(String name, Number value) {
            fields.add(jsonString(name) + ":" + value);
            return this;
        }

        JsonObject rawField(String name, String json) {
            fields.add(jsonString(name) + ":" + json);
            return this;
        }

        JsonObject field(String name, List<String> values) {
            fields.add(jsonString(name) + ":" + values.stream()
                .map(PicParserCli::jsonString)
                .collect(java.util.stream.Collectors.joining(",", "[", "]")));
            return this;
        }

        <T> JsonObject field(String name, List<T> values, java.util.function.Function<T, String> encode) {
            fields.add(jsonString(name) + ":" + values.stream()
                .map(encode)
                .collect(java.util.stream.Collectors.joining(",", "[", "]")));
            return this;
        }

        String build() {
            return "{" + String.join(",", fields) + "}";
        }
    }

    private static String jsonString(String value) {
        StringBuilder builder = new StringBuilder(value.length() + 2);
        builder.append('"');
        for (int index = 0; index < value.length(); index += 1) {
            char current = value.charAt(index);
            switch (current) {
                case '\\' -> builder.append("\\\\");
                case '"' -> builder.append("\\\"");
                case '\b' -> builder.append("\\b");
                case '\f' -> builder.append("\\f");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                default -> {
                    if (current < 0x20) {
                        builder.append(String.format("\\u%04x", (int) current));
                    } else {
                        builder.append(current);
                    }
                }
            }
        }
        builder.append('"');
        return builder.toString();
    }
}
