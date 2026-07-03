const IDENTIFIER_PATTERN = /\b[A-Za-z_$][\w$]*\b/g;
const DEFAULT_GLOBALS = new Set([
  "Array",
  "Boolean",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "React",
  "RegExp",
  "Set",
  "String",
  "console",
  "document",
  "globalThis",
  "number",
  "string",
  "window"
]);

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield"
]);

const JSX_ATTRIBUTE_NAMES = new Set([
  "alt",
  "aria",
  "checked",
  "className",
  "color",
  "data",
  "disabled",
  "height",
  "href",
  "id",
  "key",
  "name",
  "onChange",
  "onClick",
  "role",
  "src",
  "style",
  "testid",
  "title",
  "type",
  "value",
  "width"
]);

export function isPascalCaseName(value) {
  return typeof value === "string" && /^[A-Z][A-Za-z0-9_$]*$/.test(value);
}

export function isHookName(value) {
  return typeof value === "string" && /^use[A-Z0-9]/.test(value);
}

export function collectIdentifierReferences(source, options = {}) {
  const searchableSource = maskStringsAndComments(source);
  const excluded = new Set([...(options.excluded ?? []), ...collectLocalBindingNames(searchableSource), ...KEYWORDS]);
  const references = new Set();
  let match;

  while ((match = IDENTIFIER_PATTERN.exec(searchableSource))) {
    const identifier = match[0];
    const previous = searchableSource[match.index - 1];
    const nextNonSpace = searchableSource.slice(match.index + identifier.length).match(/\S/)?.[0];
    const prefix = searchableSource.slice(Math.max(0, match.index - 16), match.index);
    if (previous === "." || excluded.has(identifier)) {
      continue;
    }
    if (isLikelyJsxText(searchableSource, match.index)) {
      continue;
    }
    if (/<\/?\s*$/.test(prefix) && /^[a-z]/.test(identifier)) {
      continue;
    }
    if ((previous === "-" || nextNonSpace === "-") && /^[a-z]/.test(identifier)) {
      continue;
    }
    if (nextNonSpace === "=" && JSX_ATTRIBUTE_NAMES.has(identifier)) {
      continue;
    }
    if (nextNonSpace === ":") {
      continue;
    }
    references.add(identifier);
  }

  return [...references].sort();
}

function isLikelyJsxText(source, index) {
  const previousTagEnd = source.lastIndexOf(">", index);
  const previousTagStart = source.lastIndexOf("<", index);
  if (previousTagEnd <= previousTagStart) {
    return false;
  }

  const lastExpressionStart = source.lastIndexOf("{", index);
  const lastExpressionEnd = source.lastIndexOf("}", index);
  return !(lastExpressionStart > previousTagEnd && lastExpressionStart > lastExpressionEnd);
}

function collectLocalBindingNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/\bfunction\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    for (const param of match[1].split(",")) {
      const name = param.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}

function maskStringsAndComments(source) {
  let result = "";
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

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
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        result += "  ";
        index += 1;
      } else {
        result += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
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
      blockComment = true;
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

export function createSourceRange(source, startByte, endByte) {
  const startPrefix = source.slice(0, startByte);
  const endPrefix = source.slice(0, endByte);
  return {
    startByte,
    endByte,
    startLine: startPrefix.split("\n").length,
    endLine: endPrefix.split("\n").length
  };
}

export function isKnownGlobalReference(name, extraGlobals = []) {
  return DEFAULT_GLOBALS.has(name) || extraGlobals.includes(name);
}

export function sanitizeModulePart(value) {
  return String(value ?? "piece")
    .replace(/[^A-Za-z0-9_$.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "piece";
}
