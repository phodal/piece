export function nowMs() {
  if (globalThis.performance && typeof globalThis.performance.now === "function") {
    return globalThis.performance.now();
  }
  return Date.now();
}

export function byteLength(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

export function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

export async function measureAsync(callback) {
  const start = nowMs();
  const value = await callback();
  return {
    value,
    ms: roundMs(nowMs() - start)
  };
}

export function measureSync(callback) {
  const start = nowMs();
  const value = callback();
  return {
    value,
    ms: roundMs(nowMs() - start)
  };
}
