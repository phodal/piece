import { stableTextHash } from "../../core/hash.js";
import { createSourceRange } from "../../core/source-utils.js";

const GO_KEYWORDS = new Set([
  "break",
  "case",
  "chan",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "fallthrough",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "import",
  "interface",
  "map",
  "package",
  "range",
  "return",
  "select",
  "struct",
  "switch",
  "type",
  "var"
]);

const GO_PREDECLARED = new Set([
  "any",
  "append",
  "bool",
  "byte",
  "cap",
  "clear",
  "close",
  "comparable",
  "complex",
  "complex64",
  "complex128",
  "copy",
  "delete",
  "error",
  "false",
  "float32",
  "float64",
  "imag",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "iota",
  "len",
  "make",
  "new",
  "nil",
  "panic",
  "print",
  "println",
  "real",
  "recover",
  "rune",
  "string",
  "true",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr"
]);

const IDENTIFIER_PATTERN = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

function sliceId(filePath, kind, name, index) {
  return `${filePath}#${kind}:${name ?? index}`;
}

function maskGoSource(source) {
  let result = "";
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockCommentDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        result += "\n";
      } else {
        result += " ";
      }
      continue;
    }

    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*") {
        blockCommentDepth += 1;
        result += "  ";
        index += 1;
        continue;
      }
      if (char === "*" && next === "/") {
        blockCommentDepth -= 1;
        result += "  ";
        index += 1;
        continue;
      }
      result += char === "\n" ? "\n" : " ";
      continue;
    }

    if (quote) {
      if (quote !== "`") {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = undefined;
        }
      } else if (char === quote) {
        quote = undefined;
      }
      result += char === "\n" ? "\n" : " ";
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      result += "  ";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockCommentDepth = 1;
      result += "  ";
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      result += " ";
      continue;
    }

    result += char;
  }

  return result;
}

function lineEnd(source, startIndex) {
  const end = source.indexOf("\n", startIndex);
  return end >= 0 ? end + 1 : source.length;
}

function nextLineStart(source, startIndex) {
  const end = source.indexOf("\n", startIndex);
  return end >= 0 ? end + 1 : source.length;
}

function findDeclarationEnd(maskedSource, startIndex) {
  let curlyDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let sawBody = false;

  for (let index = startIndex; index < maskedSource.length; index += 1) {
    const char = maskedSource[index];
    if (char === "(") parenDepth += 1;
    if (char === ")" && parenDepth > 0) parenDepth -= 1;
    if (char === "[") bracketDepth += 1;
    if (char === "]" && bracketDepth > 0) bracketDepth -= 1;
    if (char === "{") {
      curlyDepth += 1;
      sawBody = true;
    }
    if (char === "}" && curlyDepth > 0) {
      curlyDepth -= 1;
      if (sawBody && curlyDepth === 0) {
        return index + 1;
      }
    }
    if (char === "\n" && curlyDepth === 0 && parenDepth === 0 && bracketDepth === 0 && !sawBody) {
      return index + 1;
    }
  }
  return maskedSource.length;
}

function findParenBlockEnd(maskedSource, startIndex) {
  const open = maskedSource.indexOf("(", startIndex);
  if (open < 0) return lineEnd(maskedSource, startIndex);
  let depth = 0;
  for (let index = open; index < maskedSource.length; index += 1) {
    if (maskedSource[index] === "(") depth += 1;
    if (maskedSource[index] === ")" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return maskedSource.length;
}

function receiverTypeName(receiverSource) {
  const cleaned = receiverSource.replace(/[()*\[\]]/g, " ").trim();
  const identifiers = [...cleaned.matchAll(IDENTIFIER_PATTERN)].map((match) => match[0]);
  return identifiers.at(-1);
}

function parseFunctionName(line) {
  const match = line.match(/^func\s*(?:\(([^)]*)\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (!match) return undefined;
  const receiver = match[1] ? receiverTypeName(match[1]) : undefined;
  return receiver ? `${receiver}.${match[2]}` : match[2];
}

function parseValueNames(line) {
  const match = line.match(/^(?:const|var)\s+(.+?)(?:=|$)/);
  if (!match) return [];
  const head = match[1].trim();
  if (head.startsWith("(")) return [];
  const firstPart = head.split(/\s+/)[0] ?? "";
  return firstPart
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

function blockDeclarations(source, masked, statementStart, blockEnd, token) {
  const open = masked.indexOf("(", statementStart);
  const declarations = [];
  let index = open + 1;
  while (index < blockEnd - 1) {
    const start = index;
    const end = lineEnd(source, start);
    const prefixLength = source.slice(start, end).match(/^\s*/)?.[0].length ?? 0;
    const statement = source.slice(start + prefixLength, end).trim();
    if (statement && !statement.startsWith("//")) {
      const name = statement.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      if (name) {
        declarations.push({
          token,
          name,
          startIndex: start + prefixLength,
          endIndex: end
        });
      }
    }
    index = nextLineStart(source, start);
  }
  return declarations;
}

function topLevelSegments(source) {
  const masked = maskGoSource(source);
  const segments = [];
  let index = 0;
  let depth = 0;

  while (index < source.length) {
    const lineStart = index;
    const endOfLine = lineEnd(source, lineStart);
    const prefixLength = source.slice(lineStart, endOfLine).match(/^\s*/)?.[0].length ?? 0;
    const statementStart = lineStart + prefixLength;
    const line = source.slice(statementStart, endOfLine);

    if (depth === 0) {
      if (/^(package|import)\s+/.test(line)) {
        const isImportBlock = /^import\s*\(/.test(line);
        const endIndex = isImportBlock ? findParenBlockEnd(masked, statementStart) : endOfLine;
        segments.push({ kind: "header", startIndex: statementStart, endIndex });
        index = endIndex;
        continue;
      }

      if (/^func\s+/.test(line) || /^func\s*\(/.test(line)) {
        const name = parseFunctionName(line);
        if (name) {
          const endIndex = findDeclarationEnd(masked, statementStart);
          segments.push({
            kind: "declaration",
            declarationToken: "func",
            startIndex: statementStart,
            endIndex,
            declarations: [{ token: "func", name, startIndex: statementStart, endIndex }]
          });
          index = segments.at(-1).endIndex;
          continue;
        }
      }

      const typeBlock = line.match(/^type\s*\(/);
      if (typeBlock) {
        const endIndex = findParenBlockEnd(masked, statementStart);
        segments.push({
          kind: "declaration",
          declarationToken: "type",
          startIndex: statementStart,
          endIndex,
          declarations: blockDeclarations(source, masked, statementStart, endIndex, "type")
        });
        index = endIndex;
        continue;
      }

      const typeDeclaration = line.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (typeDeclaration) {
        const endIndex = findDeclarationEnd(masked, statementStart);
        segments.push({
          kind: "declaration",
          declarationToken: "type",
          startIndex: statementStart,
          endIndex,
          declarations: [{ token: "type", name: typeDeclaration[1], startIndex: statementStart, endIndex }]
        });
        index = endIndex;
        continue;
      }

      const valueBlock = line.match(/^(const|var)\s*\(/);
      if (valueBlock) {
        const endIndex = findParenBlockEnd(masked, statementStart);
        segments.push({
          kind: "declaration",
          declarationToken: valueBlock[1],
          startIndex: statementStart,
          endIndex,
          declarations: blockDeclarations(source, masked, statementStart, endIndex, valueBlock[1])
        });
        index = endIndex;
        continue;
      }

      const valueDeclaration = line.match(/^(const|var)\s+/);
      if (valueDeclaration) {
        const endIndex = findDeclarationEnd(masked, statementStart);
        const names = parseValueNames(source.slice(statementStart, endIndex));
        segments.push({
          kind: "declaration",
          declarationToken: valueDeclaration[1],
          startIndex: statementStart,
          endIndex,
          declarations: names.map((name) => ({ token: valueDeclaration[1], name, startIndex: statementStart, endIndex }))
        });
        index = endIndex;
        continue;
      }
    }

    for (let cursor = lineStart; cursor < endOfLine; cursor += 1) {
      if (masked[cursor] === "{") depth += 1;
      if (masked[cursor] === "}" && depth > 0) depth -= 1;
    }
    index = nextLineStart(source, lineStart);
  }

  return segments.sort((left, right) => left.startIndex - right.startIndex);
}

function importBindingsFromHeader(source) {
  const bindings = [];
  const addBinding = (alias, importPath) => {
    if (!importPath || alias === "_") return;
    const imported = importPath.split("/").at(-1);
    bindings.push({
      local: alias && alias !== "." ? alias : imported,
      imported,
      source: importPath,
      kind: "namespace",
      isTypeOnly: false
    });
  };

  for (const match of source.matchAll(/^\s*(?:import\s+)?(?:(\.|_|[A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/gm)) {
    addBinding(match[1], match[2]);
  }
  return bindings.sort((left, right) => left.local.localeCompare(right.local));
}

function collectParameterNames(source) {
  const names = new Set();
  for (const group of source.matchAll(/\(([^)]*)\)/gs)) {
    for (const part of group[1].split(",")) {
      const name = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s+[\*\[\]A-Za-z_]/)?.[1];
      if (name) names.add(name);
    }
  }
  return names;
}

function collectLocalBindingNames(maskedSource) {
  const names = collectParameterNames(maskedSource);
  for (const match of maskedSource.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:=/g)) {
    names.add(match[1]);
  }
  for (const match of maskedSource.matchAll(/\b(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(match[1]);
  }
  return names;
}

function usefulIdentifiers(source, excluded = []) {
  const masked = maskGoSource(source);
  const excludedSet = new Set([...Array.from(excluded).filter(Boolean), ...GO_KEYWORDS, ...GO_PREDECLARED]);
  const identifiers = new Set();
  for (const match of masked.matchAll(IDENTIFIER_PATTERN)) {
    const identifier = match[0];
    const previous = masked[match.index - 1];
    const next = masked.slice(match.index + identifier.length).match(/\S/)?.[0];
    if (excludedSet.has(identifier) || previous === "." || next === ":") {
      continue;
    }
    identifiers.add(identifier);
  }
  return [...identifiers].sort();
}

function collectStructTypeReferences(text, excluded) {
  const body = text.match(/\bstruct\s*\{([\s\S]*)\}/)?.[1];
  if (!body) return [];
  const refs = new Set();
  for (const line of body.split("\n")) {
    const trimmed = line.trim().replace(/`[^`]*`/g, "");
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const typeExpression = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
    for (const ref of usefulIdentifiers(typeExpression, excluded)) {
      refs.add(ref);
    }
  }
  return [...refs].sort();
}

function collectGoTypeReferences(text, declaration, excluded = []) {
  const excludedSet = new Set(excluded);
  if (declaration.token === "func") {
    const signature = text.slice(0, text.indexOf("{") >= 0 ? text.indexOf("{") : text.length);
    for (const name of collectParameterNames(signature)) excludedSet.add(name);
    return usefulIdentifiers(signature, [...excludedSet, declaration.name, ...declaration.name.split(".")]);
  }
  if (declaration.token === "type" && /\bstruct\s*\{/.test(text)) {
    return collectStructTypeReferences(text, [...excludedSet, declaration.name]);
  }
  if (declaration.token === "type") {
    return usefulIdentifiers(text.replace(/^type\s+[A-Za-z_][A-Za-z0-9_]*/, ""), [...excludedSet, declaration.name]);
  }
  if (declaration.token === "var" || declaration.token === "const") {
    const signature = text.split("=")[0] ?? text;
    return usefulIdentifiers(signature.replace(/^(?:var|const)\s+[A-Za-z_][A-Za-z0-9_]*/, ""), [...excludedSet, declaration.name]);
  }
  return [];
}

function collectGoReferences(text, declaration, typeReferences) {
  if (declaration.token === "type") {
    return [];
  }
  const masked = maskGoSource(text);
  const localBindings = collectLocalBindingNames(masked);
  const excluded = new Set([declaration.name, ...declaration.name.split("."), ...localBindings, ...typeReferences]);
  return usefulIdentifiers(text, excluded);
}

function sliceKindForDeclaration(token) {
  if (token === "type") return "type";
  if (token === "func") return "function";
  if (token === "const" || token === "var") return "value";
  return undefined;
}

function createGoSlice({ filePath, source, declaration, index }) {
  const text = source.slice(declaration.startIndex, declaration.endIndex);
  const kind = sliceKindForDeclaration(declaration.token);
  if (!kind) return undefined;

  const typeReferences = collectGoTypeReferences(text, declaration, [declaration.name]);
  const references = [...new Set([...collectGoReferences(text, declaration, typeReferences), ...typeReferences])].sort();
  const signatureEndCandidates = [text.indexOf("{"), text.indexOf("=")].filter((candidate) => candidate >= 0);
  const signatureEnd = signatureEndCandidates.length > 0 ? Math.min(...signatureEndCandidates) : text.length;

  return {
    id: sliceId(filePath, kind, declaration.name, index),
    filePath,
    kind,
    name: declaration.name,
    exportName: declaration.name,
    isDefaultExport: false,
    range: createSourceRange(source, declaration.startIndex, declaration.endIndex),
    source: text,
    symbols: {
      defines: [declaration.name],
      references,
      typeReferences,
      jsxReferences: []
    },
    preview: {
      previewable: kind === "function" || kind === "type",
      reason: kind === "function" || kind === "type" ? undefined : "not a runnable feedback target"
    },
    hashes: {
      bodyHash: stableTextHash(text),
      signatureHash: stableTextHash(text.slice(0, signatureEnd)),
      typeHash: kind === "type" ? stableTextHash(text) : undefined
    },
    safety: {
      hasTopLevelSideEffect: false,
      hasDynamicImport: false,
      hasUnknownGlobal: false,
      fallbackRequired: false
    }
  };
}

function createEffectSegments({ filePath, source, segments }) {
  const effects = [];
  let cursor = 0;
  let index = 0;
  for (const segment of segments) {
    const startIndex = segment.startIndex ?? segment.declarations?.[0]?.startIndex ?? cursor;
    const gap = source.slice(cursor, startIndex);
    if (gap.trim()) {
      effects.push({
        id: sliceId(filePath, "effect", `top-level-${index}`, index),
        filePath,
        kind: "effect",
        range: createSourceRange(source, cursor, startIndex),
        source: gap,
        hashes: { bodyHash: stableTextHash(gap) },
        safety: { hasTopLevelSideEffect: true, hasDynamicImport: false, hasUnknownGlobal: true, fallbackRequired: true }
      });
      index += 1;
    }
    cursor = segment.endIndex ?? Math.max(...(segment.declarations ?? []).map((declaration) => declaration.endIndex), cursor);
  }
  const tail = source.slice(cursor);
  if (tail.trim()) {
    effects.push({
      id: sliceId(filePath, "effect", `top-level-${index}`, index),
      filePath,
      kind: "effect",
      range: createSourceRange(source, cursor, source.length),
      source: tail,
      hashes: { bodyHash: stableTextHash(tail) },
      safety: { hasTopLevelSideEffect: true, hasDynamicImport: false, hasUnknownGlobal: true, fallbackRequired: true }
    });
  }
  return effects;
}

export function createGoDeclarationExtractor(options = {}) {
  return {
    name: options.name ?? "go-declaration-extractor",
    extract({ filePath, source }) {
      const segments = topLevelSegments(source);
      const headers = [];
      const slices = [];

      segments.forEach((segment, segmentIndex) => {
        if (segment.kind === "header") {
          const headerSource = source.slice(segment.startIndex, segment.endIndex);
          headers.push({
            id: sliceId(filePath, "header", `header-${segmentIndex}`, segmentIndex),
            filePath,
            kind: "header",
            range: createSourceRange(source, segment.startIndex, segment.endIndex),
            source: headerSource,
            importBindings: importBindingsFromHeader(headerSource)
          });
          return;
        }

        for (const declaration of segment.declarations ?? []) {
          const slice = createGoSlice({ filePath, source, declaration, index: slices.length });
          if (slice) {
            slices.push(slice);
          }
        }
      });

      const effects = createEffectSegments({ filePath, source, segments });
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
        diagnostics: []
      };
    }
  };
}
