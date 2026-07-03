import { stableTextHash } from "../../core/hash.js";
import { createSourceRange } from "../../core/source-utils.js";

const KOTLIN_KEYWORDS = new Set([
  "abstract",
  "actual",
  "annotation",
  "as",
  "break",
  "by",
  "catch",
  "class",
  "companion",
  "const",
  "constructor",
  "continue",
  "data",
  "do",
  "dynamic",
  "else",
  "enum",
  "expect",
  "external",
  "false",
  "final",
  "finally",
  "for",
  "fun",
  "if",
  "import",
  "in",
  "infix",
  "init",
  "inline",
  "inner",
  "interface",
  "internal",
  "is",
  "lateinit",
  "noinline",
  "null",
  "object",
  "open",
  "operator",
  "out",
  "override",
  "package",
  "private",
  "protected",
  "public",
  "reified",
  "return",
  "sealed",
  "super",
  "suspend",
  "tailrec",
  "this",
  "throw",
  "true",
  "try",
  "typealias",
  "val",
  "var",
  "vararg",
  "when",
  "where",
  "while"
]);

const KOTLIN_STDLIB_NAMES = new Set([
  "Any",
  "Array",
  "Boolean",
  "Byte",
  "Char",
  "CharSequence",
  "Collection",
  "Double",
  "Float",
  "Int",
  "Iterable",
  "List",
  "Long",
  "Map",
  "MutableList",
  "MutableMap",
  "MutableSet",
  "Nothing",
  "Pair",
  "Sequence",
  "Set",
  "Short",
  "String",
  "Triple",
  "Unit",
  "emptyList",
  "emptyMap",
  "emptySet",
  "listOf",
  "mapOf",
  "mutableListOf",
  "mutableMapOf",
  "mutableSetOf",
  "println",
  "setOf"
]);

const DECLARATION_PATTERN =
  /^(?:(?:@\w+(?:\([^)]*\))?\s+)*)((?:(?:public|private|internal|protected|open|final|abstract|sealed|data|value|inline|tailrec|suspend|operator|infix|external|expect|actual|const|lateinit|override|companion)\s+)*)(enum\s+class|typealias|interface|class|object|fun|val|var)\s+([A-Za-z_][A-Za-z0-9_]*)/;

function sliceId(filePath, kind, name, index) {
  return `${filePath}#${kind}:${name ?? index}`;
}

function maskKotlinSource(source) {
  let result = "";
  let quote;
  let tripleQuote = false;
  let escaped = false;
  let lineComment = false;
  let blockCommentDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    const nextTwo = source.slice(index, index + 3);

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
      if (tripleQuote && nextTwo === '"""') {
        quote = undefined;
        tripleQuote = false;
        result += "   ";
        index += 2;
        continue;
      }
      if (!tripleQuote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = undefined;
        }
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
    if (nextTwo === '"""') {
      quote = '"';
      tripleQuote = true;
      result += "   ";
      index += 2;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      result += " ";
      continue;
    }

    result += char;
  }

  return result;
}

function collectLocalBindingNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\b(?:class|interface|object|fun|val|var|typealias|enum\s+class)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(match[1]);
  }
  for (const params of source.matchAll(/\(([^)]*)\)/gs)) {
    for (const param of params[1].split(",")) {
      const name = param.trim().match(/^(?:vararg\s+|val\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1];
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}

function collectKotlinReferences(source, excluded = []) {
  const masked = maskKotlinSource(source);
  const localBindings = collectLocalBindingNames(masked);
  const excludedSet = new Set([...excluded.filter(Boolean), ...localBindings, ...KOTLIN_KEYWORDS, ...KOTLIN_STDLIB_NAMES]);
  const references = new Set();
  for (const match of masked.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const identifier = match[0];
    const previous = masked[match.index - 1];
    const next = masked.slice(match.index + identifier.length).match(/\S/)?.[0];
    if (excludedSet.has(identifier) || previous === "." || previous === "@" || next === "=") {
      continue;
    }
    references.add(identifier);
  }
  return [...references].sort();
}

function collectKotlinTypeReferences(source, excluded = []) {
  const signature = maskKotlinSource(source);
  const excludedSet = new Set([...excluded.filter(Boolean), ...KOTLIN_KEYWORDS, ...KOTLIN_STDLIB_NAMES]);
  const typeReferences = new Set();
  for (const match of signature.matchAll(/[:<,]\s*([A-Z][A-Za-z0-9_]*)\b/g)) {
    if (!excludedSet.has(match[1])) {
      typeReferences.add(match[1]);
    }
  }
  return [...typeReferences].sort();
}

function importBindingsFromHeader(source) {
  const bindings = [];
  for (const match of source.matchAll(/^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*(?:\.\*)?)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm)) {
    const importedPath = match[1];
    const alias = match[2];
    const parts = importedPath.split(".");
    const imported = parts.pop();
    const isWildcard = imported === "*";
    bindings.push({
      local: alias ?? imported,
      imported,
      source: parts.join("."),
      kind: isWildcard ? "namespace" : "named",
      isTypeOnly: false
    });
  }
  return bindings.sort((left, right) => left.local.localeCompare(right.local));
}

function sliceKindForDeclaration(token) {
  if (token === "interface" || token === "typealias") return "type";
  if (token === "class" || token === "enum class" || token === "object") return "class";
  if (token === "fun") return "function";
  if (token === "val" || token === "var") return "value";
  return undefined;
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

function lineEnd(source, startIndex) {
  const end = source.indexOf("\n", startIndex);
  return end >= 0 ? end + 1 : source.length;
}

function nextLineStart(source, startIndex) {
  const end = source.indexOf("\n", startIndex);
  return end >= 0 ? end + 1 : source.length;
}

function topLevelSegments(source) {
  const masked = maskKotlinSource(source);
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
        segments.push({ kind: "header", startIndex: statementStart, endIndex: endOfLine });
        index = endOfLine;
        continue;
      }

      const declaration = line.match(DECLARATION_PATTERN);
      if (declaration) {
        const endIndex = findDeclarationEnd(masked, statementStart);
        segments.push({
          kind: "declaration",
          startIndex: statementStart,
          endIndex,
          declarationToken: declaration[2],
          name: declaration[3]
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

function createKotlinSlice({ filePath, source, segment, index }) {
  const text = source.slice(segment.startIndex, segment.endIndex);
  const kind = sliceKindForDeclaration(segment.declarationToken);
  if (!kind) {
    return undefined;
  }
  const typeReferences = collectKotlinTypeReferences(text, [segment.name]);
  const references = [...new Set([...collectKotlinReferences(text, [segment.name]), ...typeReferences])].sort();
  const signatureEndCandidates = [text.indexOf("{"), text.indexOf("=")].filter((candidate) => candidate >= 0);
  const signatureEnd = signatureEndCandidates.length > 0 ? Math.min(...signatureEndCandidates) : text.length;

  return {
    id: sliceId(filePath, kind, segment.name, index),
    filePath,
    kind,
    name: segment.name,
    exportName: segment.name,
    isDefaultExport: false,
    range: createSourceRange(source, segment.startIndex, segment.endIndex),
    source: text,
    symbols: {
      defines: segment.name ? [segment.name] : [],
      references,
      typeReferences,
      jsxReferences: []
    },
    preview: {
      previewable: kind === "class" || kind === "function",
      reason: kind === "class" || kind === "function" ? undefined : "not a runnable feedback target"
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
    const gap = source.slice(cursor, segment.startIndex);
    if (gap.trim()) {
      effects.push({
        id: sliceId(filePath, "effect", `top-level-${index}`, index),
        filePath,
        kind: "effect",
        range: createSourceRange(source, cursor, segment.startIndex),
        source: gap,
        hashes: { bodyHash: stableTextHash(gap) },
        safety: { hasTopLevelSideEffect: true, hasDynamicImport: false, hasUnknownGlobal: true, fallbackRequired: true }
      });
      index += 1;
    }
    cursor = segment.endIndex;
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

export function createKotlinDeclarationExtractor(options = {}) {
  return {
    name: options.name ?? "kotlin-declaration-extractor",
    extract({ filePath, source }) {
      const segments = topLevelSegments(source);
      const headers = [];
      const slices = [];

      segments.forEach((segment, index) => {
        if (segment.kind === "header") {
          const headerSource = source.slice(segment.startIndex, segment.endIndex);
          headers.push({
            id: sliceId(filePath, "header", `header-${index}`, index),
            filePath,
            kind: "header",
            range: createSourceRange(source, segment.startIndex, segment.endIndex),
            source: headerSource,
            importBindings: importBindingsFromHeader(headerSource)
          });
          return;
        }

        const slice = createKotlinSlice({ filePath, source, segment, index });
        if (slice) {
          slices.push(slice);
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
