export function buildPieceSymbolTable(manifest) {
  const local = new Map();
  const imports = new Map();
  const exports = new Map();
  let defaultExport;

  for (const slice of manifest.slices) {
    for (const name of slice.symbols.defines) {
      local.set(name, slice.id);
    }
    if (slice.exportName) {
      exports.set(slice.exportName, slice.id);
    }
    if (slice.isDefaultExport) {
      defaultExport = slice.id;
      exports.set("default", slice.id);
    }
  }

  for (const binding of manifest.importBindings ?? []) {
    imports.set(binding.local, binding);
  }

  return {
    local,
    imports,
    exports,
    defaultExport
  };
}

export function serializePieceSymbolTable(symbolTable) {
  return {
    local: Object.fromEntries([...symbolTable.local.entries()].sort(([left], [right]) => left.localeCompare(right))),
    imports: Object.fromEntries([...symbolTable.imports.entries()].sort(([left], [right]) => left.localeCompare(right))),
    exports: Object.fromEntries([...symbolTable.exports.entries()].sort(([left], [right]) => left.localeCompare(right))),
    defaultExport: symbolTable.defaultExport
  };
}
