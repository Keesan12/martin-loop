// src/utils/platform.ts
/**
 * Detect if the current platform is macOS or Ubuntu (Linux).
 * This helper is used to adjust safeguard requirements for non‑Windows environments.
 */
export function isMacOrUbuntu(): boolean {
  const platform = process.platform;
  // "darwin" = macOS, "linux" = Ubuntu (or other Linux distributions).
  return platform === "darwin" || platform === "linux";
}
