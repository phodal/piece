// Hashes participate in incremental invalidation and artifact identity, so a
// short non-cryptographic fingerprint is not sufficient. Keep this synchronous
// and browser-safe: the core package cannot depend on Node's crypto module.
export const PIECE_FINGERPRINT_VERSION = 2;

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2
]);
const TEXT_ENCODER = new TextEncoder();

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256Hex(text) {
  const source = TEXT_ENCODER.encode(text);
  const paddingLength = (64 - ((source.length + 1 + 8) % 64)) % 64;
  const message = new Uint8Array(source.length + 1 + paddingLength + 8);
  message.set(source);
  message[source.length] = 0x80;
  const bitLength = source.length * 8;
  const highBits = Math.floor(bitLength / 0x1_0000_0000);
  const lowBits = bitLength >>> 0;
  const lengthOffset = message.length - 8;
  message[lengthOffset] = (highBits >>> 24) & 0xff;
  message[lengthOffset + 1] = (highBits >>> 16) & 0xff;
  message[lengthOffset + 2] = (highBits >>> 8) & 0xff;
  message[lengthOffset + 3] = highBits & 0xff;
  message[lengthOffset + 4] = (lowBits >>> 24) & 0xff;
  message[lengthOffset + 5] = (lowBits >>> 16) & 0xff;
  message[lengthOffset + 6] = (lowBits >>> 8) & 0xff;
  message[lengthOffset + 7] = lowBits & 0xff;

  let hash0 = 0x6a09e667;
  let hash1 = 0xbb67ae85;
  let hash2 = 0x3c6ef372;
  let hash3 = 0xa54ff53a;
  let hash4 = 0x510e527f;
  let hash5 = 0x9b05688c;
  let hash6 = 0x1f83d9ab;
  let hash7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      words[index] =
        (message[byteOffset] << 24) |
        (message[byteOffset + 1] << 16) |
        (message[byteOffset + 2] << 8) |
        message[byteOffset + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rightRotate(left, 7) ^ rightRotate(left, 18) ^ (left >>> 3);
      const sigma1 = rightRotate(right, 17) ^ rightRotate(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let a = hash0;
    let b = hash1;
    let c = hash2;
    let d = hash3;
    let e = hash4;
    let f = hash5;
    let g = hash6;
    let h = hash7;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sigma1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash0 = (hash0 + a) >>> 0;
    hash1 = (hash1 + b) >>> 0;
    hash2 = (hash2 + c) >>> 0;
    hash3 = (hash3 + d) >>> 0;
    hash4 = (hash4 + e) >>> 0;
    hash5 = (hash5 + f) >>> 0;
    hash6 = (hash6 + g) >>> 0;
    hash7 = (hash7 + h) >>> 0;
  }

  return [hash0, hash1, hash2, hash3, hash4, hash5, hash6, hash7].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function framedText(domain, value) {
  const source = String(value ?? "");
  return `${domain}\u0000${TEXT_ENCODER.encode(source).byteLength}\u0000${source}`;
}

function fingerprint(domain, value) {
  return sha256Hex(framedText(domain, value));
}

/** The retired v1 FNV-1a fingerprint is retained only for migration tests. */
export function legacyStableTextHash(value) {
  const source = String(value ?? "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function stableTextHash(value) {
  return fingerprint("piece-text-v2", value);
}

export function stableJsonHash(value) {
  return fingerprint("piece-json-v2", JSON.stringify(value, Object.keys(value ?? {}).sort()));
}

export function hashParts(parts) {
  const normalized = (Array.isArray(parts) ? parts : []).filter((part) => part !== undefined && part !== null).map((part) => String(part));
  const framed = `${normalized.length}\u0000${normalized.map((part) => `${TEXT_ENCODER.encode(part).byteLength}\u0000${part}`).join("")}`;
  return fingerprint("piece-parts-v2", framed);
}
