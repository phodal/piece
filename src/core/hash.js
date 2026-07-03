export function stableTextHash(value) {
  const source = String(value ?? "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function stableJsonHash(value) {
  return stableTextHash(JSON.stringify(value, Object.keys(value ?? {}).sort()));
}

export function hashParts(parts) {
  return stableTextHash(parts.filter((part) => part !== undefined && part !== null).join("\u001f"));
}
