package piece.pic;

import java.util.ArrayList;
import java.util.List;
import org.antlr.v4.runtime.BaseErrorListener;
import org.antlr.v4.runtime.CharStreams;
import org.antlr.v4.runtime.CommonTokenStream;
import org.antlr.v4.runtime.RecognitionException;
import org.antlr.v4.runtime.Recognizer;
import org.antlr.v4.runtime.Token;
import org.antlr.v4.runtime.tree.TerminalNode;
import piece.pic.antlr.PieceLexer;
import piece.pic.antlr.PieceParser;

public final class AntlrPicParserBackend {
    public PicParseResult parse(String source) {
        List<PicDiagnostic> diagnostics = new ArrayList<>();
        PieceLexer lexer = new PieceLexer(CharStreams.fromString(source));
        lexer.removeErrorListeners();
        lexer.addErrorListener(new DiagnosticErrorListener(diagnostics));

        PieceParser parser = new PieceParser(new CommonTokenStream(lexer));
        parser.removeErrorListeners();
        parser.addErrorListener(new DiagnosticErrorListener(diagnostics));

        PieceParser.DocumentContext documentContext = parser.document();
        if (!diagnostics.isEmpty()) {
            return new PicParseResult(null, null, diagnostics);
        }

        try {
            PicDocument document = toDocument(documentContext.packageDeclaration());
            return new PicParseResult(document, PicToModelKt.picDocumentToPiecePackage(document), diagnostics);
        } catch (IllegalArgumentException error) {
            diagnostics.add(new PicDiagnostic("pic-model-error", "error", error.getMessage(), null, null));
            return new PicParseResult(null, null, diagnostics);
        }
    }

    private PicDocument toDocument(PieceParser.PackageDeclarationContext context) {
        String packageLabel = stringValue(context.STRING().getSymbol());
        String language = null;
        String source = null;
        List<PicTarget> targets = new ArrayList<>();

        for (PieceParser.PackageMemberContext member : context.packageMember()) {
            if (member.languageDeclaration() != null) {
                language = member.languageDeclaration().IDENTIFIER().getText();
            } else if (member.sourceDeclaration() != null) {
                source = stringValue(member.sourceDeclaration().STRING().getSymbol());
            } else if (member.targetDeclaration() != null) {
                targets.add(toTarget(member.targetDeclaration()));
            }
        }

        if (language == null || language.isBlank()) {
            throw new IllegalArgumentException(".pic package requires a language declaration.");
        }
        if (source == null || source.isBlank()) {
            throw new IllegalArgumentException(".pic package requires a source declaration.");
        }
        return new PicDocument(packageLabel, language, source, targets);
    }

    private PicTarget toTarget(PieceParser.TargetDeclarationContext context) {
        PicTargetKind kind = targetKind(context.targetKind().getText());
        String name = stringValue(context.STRING().getSymbol());
        List<String> deps = new ArrayList<>();
        List<String> runtimeDeps = new ArrayList<>();
        List<String> typeDeps = new ArrayList<>();
        List<String> externalDeps = new ArrayList<>();
        List<PicAction> actions = new ArrayList<>();

        for (PieceParser.TargetMemberContext member : context.targetMember()) {
            if (member.depsDeclaration() != null) {
                deps.addAll(toStringList(member.depsDeclaration().stringList()));
            } else if (member.runtimeDepsDeclaration() != null) {
                runtimeDeps.addAll(toStringList(member.runtimeDepsDeclaration().stringList()));
            } else if (member.typeDepsDeclaration() != null) {
                typeDeps.addAll(toStringList(member.typeDepsDeclaration().stringList()));
            } else if (member.externalDepsDeclaration() != null) {
                externalDeps.addAll(toStringList(member.externalDepsDeclaration().stringList()));
            } else if (member.actionDeclaration() != null) {
                actions.add(toAction(member.actionDeclaration()));
            }
        }

        return new PicTarget(kind, name, deps, runtimeDeps, typeDeps, externalDeps, actions);
    }

    private List<String> toStringList(PieceParser.StringListContext context) {
        List<String> values = new ArrayList<>();
        for (TerminalNode node : context.STRING()) {
            values.add(stringValue(node.getSymbol()));
        }
        return values;
    }

    private PicAction toAction(PieceParser.ActionDeclarationContext context) {
        PicActionKind kind = actionKind(context.actionKind().getText());
        String mnemonic = null;
        String output = null;

        for (PieceParser.ActionMemberContext member : context.actionMember()) {
            if (member.mnemonicDeclaration() != null) {
                mnemonic = stringValue(member.mnemonicDeclaration().STRING().getSymbol());
            } else if (member.outputDeclaration() != null) {
                output = stringValue(member.outputDeclaration().STRING().getSymbol());
            }
        }

        return new PicAction(kind, mnemonic, output);
    }

    private static PicTargetKind targetKind(String value) {
        return switch (value) {
            case "type" -> PicTargetKind.Type;
            case "class" -> PicTargetKind.Class;
            case "function" -> PicTargetKind.Function;
            case "value" -> PicTargetKind.Value;
            case "effect" -> PicTargetKind.Effect;
            case "header" -> PicTargetKind.Header;
            default -> throw new IllegalArgumentException("Unsupported target kind: " + value);
        };
    }

    private static PicActionKind actionKind(String value) {
        return switch (value) {
            case "feedback" -> PicActionKind.Feedback;
            case "compile" -> PicActionKind.Compile;
            case "preview" -> PicActionKind.Preview;
            case "test" -> PicActionKind.Test;
            case "typecheck" -> PicActionKind.Typecheck;
            case "documentation" -> PicActionKind.Documentation;
            default -> throw new IllegalArgumentException("Unsupported action kind: " + value);
        };
    }

    private static String stringValue(Token token) {
        String text = token.getText();
        String body = text.substring(1, text.length() - 1);
        StringBuilder builder = new StringBuilder(body.length());
        for (int index = 0; index < body.length(); index += 1) {
            char current = body.charAt(index);
            if (current != '\\') {
                builder.append(current);
                continue;
            }
            if (index == body.length() - 1) {
                builder.append('\\');
                continue;
            }
            char escaped = body.charAt(++index);
            switch (escaped) {
                case 'b' -> builder.append('\b');
                case 't' -> builder.append('\t');
                case 'n' -> builder.append('\n');
                case 'f' -> builder.append('\f');
                case 'r' -> builder.append('\r');
                case '"' -> builder.append('"');
                case '\\' -> builder.append('\\');
                case 'u' -> {
                    if (index + 4 > body.length() - 1) {
                        builder.append("\\u");
                    } else {
                        String hex = body.substring(index + 1, index + 5);
                        builder.append((char) Integer.parseInt(hex, 16));
                        index += 4;
                    }
                }
                default -> builder.append(escaped);
            }
        }
        return builder.toString();
    }

    private static final class DiagnosticErrorListener extends BaseErrorListener {
        private final List<PicDiagnostic> diagnostics;

        private DiagnosticErrorListener(List<PicDiagnostic> diagnostics) {
            this.diagnostics = diagnostics;
        }

        @Override
        public void syntaxError(
            Recognizer<?, ?> recognizer,
            Object offendingSymbol,
            int line,
            int charPositionInLine,
            String message,
            RecognitionException error
        ) {
            diagnostics.add(new PicDiagnostic(
                "pic-syntax-error",
                "error",
                message,
                line,
                charPositionInLine + 1
            ));
        }
    }
}
