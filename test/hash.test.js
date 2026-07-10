import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PIECE_FINGERPRINT_VERSION, hashParts, legacyStableTextHash, stableTextHash } from "../src/core/hash.js";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("core fingerprints", () => {
  it("uses a domain-separated SHA-256 text fingerprint rather than the retired 32-bit FNV value", () => {
    const source = "export const greeting = '你好';\n";
    const byteLength = Buffer.byteLength(source, "utf8");

    expect(PIECE_FINGERPRINT_VERSION).toBe(2);
    expect(stableTextHash(source)).toBe(sha256(`piece-text-v2\u0000${byteLength}\u0000${source}`));
    expect(stableTextHash(source)).toMatch(/^[a-f0-9]{64}$/);
    expect(legacyStableTextHash(source)).not.toBe(stableTextHash(source));
  });

  it("length-frames compound identities so separator-containing inputs cannot alias", () => {
    expect(hashParts(["a\u001fb", "c"])).not.toBe(hashParts(["a", "b\u001fc"]));
    expect(hashParts(["a", "b", "c"])).not.toBe(hashParts(["a", "b\u001fc"]));
  });
});
