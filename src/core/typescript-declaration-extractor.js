import { stableTextHash } from "./hash.js";
import { isHookName, isPascalCaseName } from "./source-utils.js";

function scriptKindFor(filePath, ts) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function rangeFor(sourceFile, node) {
  const startByte = node.getStart(sourceFile);
  const endByte = node.getEnd();
  const start = sourceFile.getLineAndCharacterOfPosition(startByte);
  const end = sourceFile.getLineAndCharacterOfPosition(endByte);
  return {
    startByte,
    endByte,
    startLine: start.line + 1,
    endLine: end.line + 1
  };
}

function sliceId(filePath, kind, name, index) {
  return `${filePath}#${kind}:${name ?? index}`;
}

function hasModifier(node, ts, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

function declarationName(node, ts) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
  }
  return undefined;
}

function isFunctionVariable(node, ts) {
  if (!ts.isVariableStatement(node)) {
    return false;
  }
  const declaration = node.declarationList.declarations[0];
  return Boolean(declaration?.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)));
}

function sliceKind(node, ts) {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isEnumDeclaration(node)) return "value";
  if (ts.isVariableStatement(node)) return isFunctionVariable(node, ts) ? "function" : "value";
  return undefined;
}

function sourceFor(sourceFile, node) {
  return sourceFile.text.slice(node.getFullStart(), node.getEnd());
}

function isDeclarationIdentifier(node, ts) {
  const parent = node.parent;
  return Boolean(
    parent &&
      ((parent.name === node &&
        (ts.isFunctionDeclaration(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isInterfaceDeclaration(parent) ||
          ts.isTypeAliasDeclaration(parent) ||
          ts.isEnumDeclaration(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isTypeParameterDeclaration(parent))) ||
        (ts.isImportSpecifier(parent) && parent.name === node) ||
        (ts.isImportClause(parent) && parent.name === node) ||
        (ts.isNamespaceImport(parent) && parent.name === node))
  );
}

function isPropertyNameIdentifier(node, ts) {
  const parent = node.parent;
  return Boolean(
    parent &&
      ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isShorthandPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isJsxAttribute(parent) && parent.name === node) ||
        (ts.isJsxOpeningElement(parent) && parent.tagName === node) ||
        (ts.isJsxSelfClosingElement(parent) && parent.tagName === node) ||
        (ts.isJsxClosingElement(parent) && parent.tagName === node))
  );
}

function collectSymbols(node, sourceFile, ts, excluded = []) {
  const references = new Set();
  const typeReferences = new Set();
  const jsxReferences = new Set();
  const localDefinitions = new Set();
  const excludedSet = new Set(excluded.filter(Boolean));

  function collectEntityName(name, output) {
    if (ts.isIdentifier(name)) {
      output.add(name.text);
      return;
    }
    if (ts.isQualifiedName(name)) {
      collectEntityName(name.left, output);
    }
  }

  function visit(current) {
    if (ts.isTypeReferenceNode(current) || ts.isExpressionWithTypeArguments(current)) {
      collectEntityName(current.typeName ?? current.expression, typeReferences);
      ts.forEachChild(current, visit);
      return;
    }

    if (ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current)) {
      const tagName = current.tagName;
      if (ts.isIdentifier(tagName) && /^[A-Z]/.test(tagName.text)) {
        jsxReferences.add(tagName.text);
        references.add(tagName.text);
      }
      ts.forEachChild(current, visit);
      return;
    }

    if (ts.isIdentifier(current) && isDeclarationIdentifier(current, ts) && !excludedSet.has(current.text)) {
      localDefinitions.add(current.text);
    }

    if (ts.isIdentifier(current) && !excludedSet.has(current.text) && !isDeclarationIdentifier(current, ts) && !isPropertyNameIdentifier(current, ts)) {
      references.add(current.text);
    }

    ts.forEachChild(current, visit);
  }

  visit(node);
  for (const localName of localDefinitions) {
    references.delete(localName);
    typeReferences.delete(localName);
    jsxReferences.delete(localName);
  }
  return {
    references: [...references].sort(),
    typeReferences: [...typeReferences].sort(),
    jsxReferences: [...jsxReferences].sort()
  };
}

function importBindingsFromStatement(statement, ts) {
  if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) {
    return [];
  }

  const source = statement.moduleSpecifier.text;
  const isTypeOnly = Boolean(statement.importClause.isTypeOnly);
  const bindings = [];

  if (statement.importClause.name) {
    bindings.push({ local: statement.importClause.name.text, imported: "default", source, kind: "default", isTypeOnly });
  }

  const namedBindings = statement.importClause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    bindings.push({ local: namedBindings.name.text, imported: "*", source, kind: "namespace", isTypeOnly });
  }
  if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      bindings.push({
        local: element.name.text,
        imported: (element.propertyName ?? element.name).text,
        source,
        kind: "named",
        isTypeOnly: isTypeOnly || Boolean(element.isTypeOnly)
      });
    }
  }

  return bindings;
}

function exportNamesForStatement(statement, name, ts) {
  if (!name || !hasModifier(statement, ts, ts.SyntaxKind.ExportKeyword)) {
    return {};
  }
  return {
    exportName: hasModifier(statement, ts, ts.SyntaxKind.DefaultKeyword) ? "default" : name,
    isDefaultExport: hasModifier(statement, ts, ts.SyntaxKind.DefaultKeyword)
  };
}

function createSlice({ filePath, sourceFile, statement, kind, name, index, ts }) {
  const source = sourceFor(sourceFile, statement);
  const symbols = collectSymbols(statement, sourceFile, ts, [name]);
  const previewable = (kind === "function" || kind === "class") && Boolean(name) && isPascalCaseName(name) && !isHookName(name);
  const bodyHash = stableTextHash(source);
  const signatureEnd = kind === "function" || kind === "class" ? source.indexOf("{") : -1;

  return {
    id: sliceId(filePath, kind, name, index),
    filePath,
    kind,
    name,
    ...exportNamesForStatement(statement, name, ts),
    range: rangeFor(sourceFile, statement),
    source,
    symbols: {
      defines: name ? [name] : [],
      references: symbols.references,
      typeReferences: symbols.typeReferences,
      jsxReferences: symbols.jsxReferences
    },
    preview: {
      previewable,
      reason: previewable ? undefined : "not a previewable component declaration"
    },
    hashes: {
      bodyHash,
      signatureHash: stableTextHash(signatureEnd >= 0 ? source.slice(0, signatureEnd) : source),
      typeHash: kind === "type" ? bodyHash : undefined
    },
    safety: {
      hasTopLevelSideEffect: false,
      hasDynamicImport: /import\s*\(|require\s*\(/.test(source),
      hasUnknownGlobal: false,
      fallbackRequired: false
    }
  };
}

export async function createTypeScriptDeclarationExtractor(options = {}) {
  const ts = await import("typescript");
  return {
    name: options.name ?? "typescript-declaration-extractor",
    async extract({ filePath, source }) {
      const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath, ts));
      const slices = [];
      const headers = [];
      const effects = [];
      const diagnostics = [];

      sourceFile.statements.forEach((statement, index) => {
        if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
          headers.push({
            id: sliceId(filePath, "header", `header-${index}`, index),
            filePath,
            kind: "header",
            range: rangeFor(sourceFile, statement),
            source: sourceFor(sourceFile, statement),
            importBindings: importBindingsFromStatement(statement, ts)
          });
          return;
        }

        const kind = sliceKind(statement, ts);
        if (kind) {
          const name = declarationName(statement, ts);
          slices.push(createSlice({ filePath, sourceFile, statement, kind, name, index, ts }));
          return;
        }

        if (statement.kind !== ts.SyntaxKind.EndOfFileToken) {
          const effectSource = sourceFor(sourceFile, statement);
          effects.push({
            id: sliceId(filePath, "effect", `top-level-${index}`, index),
            filePath,
            kind: "effect",
            range: rangeFor(sourceFile, statement),
            source: effectSource,
            hashes: { bodyHash: stableTextHash(effectSource) },
            safety: {
              hasTopLevelSideEffect: true,
              hasDynamicImport: /import\s*\(|require\s*\(/.test(effectSource),
              hasUnknownGlobal: true,
              fallbackRequired: true
            }
          });
        }
      });

      return {
        version: 1,
        filePath,
        source,
        parser: this.name,
        slices,
        headers,
        effects,
        importBindings: headers.flatMap((header) => header.importBindings),
        hasTopLevelEffect: effects.length > 0,
        diagnostics
      };
    }
  };
}
