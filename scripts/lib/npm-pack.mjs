/**
 * Shared npm pack JSON parser.
 *
 * Contract:
 *   - Machine-readable output -> stdout only
 *   - Diagnostics, logs, progress -> stderr only
 *   - Release scripts should not each implement their own npm pack parser.
 *
 * Handles supported npm pack --json output shapes:
 *   - Array: [{ filename, files, ... }]
 *   - Keyed object: { "package-name": [{ filename, files, ... }] }
 *   - Mixed stdout where lifecycle output precedes the final pack JSON payload.
 */

export class NpmPackParseError extends Error {
  constructor(message, { rawStdout, parsedPayload, parserStage, npmVersion, command } = {}) {
    super(message);
    this.name = "NpmPackParseError";
    this.rawStdout = rawStdout;
    this.parsedPayload = parsedPayload ?? null;
    this.parserStage = parserStage ?? "unknown";
    this.npmVersion = npmVersion ?? null;
    this.command = command ?? "npm pack --json";
  }
}

/**
 * Parse npm pack --json stdout into a normalized array of pack artifacts.
 *
 * @param {string} stdout
 * @returns {Array<{ filename: string, files?: Array<{ path?: string }>, [key: string]: unknown }>}
 */
export function parseNpmPackJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = extractLastJsonValue(stdout);
  }
  return normalizePackArtifacts(parsed, stdout);
}

/**
 * Return the first artifact from a normalized array or supported raw parsed shape.
 *
 * @param {unknown} parsed
 * @returns {{ filename?: string, files?: Array<{ path?: string }>, [key: string]: unknown } | null}
 */
export function getFirstPackArtifact(parsed) {
  if (Array.isArray(parsed)) {
    return parsed[0] ?? null;
  }

  if (isRecord(parsed)) {
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) {
        return value[0] ?? null;
      }
      if (isRecord(value)) {
        return value;
      }
    }
  }

  return null;
}

function normalizePackArtifacts(parsed, rawStdout) {
  if (Array.isArray(parsed)) {
    return assertArtifactArray(parsed, rawStdout);
  }

  if (isRecord(parsed)) {
    const arrays = Object.values(parsed).filter(Array.isArray);
    if (arrays.length > 0) {
      return assertArtifactArray(arrays.flat(), rawStdout);
    }
  }

  throw new NpmPackParseError("Unable to normalize npm pack output into artifact array", {
    rawStdout,
    parsedPayload: parsed,
    parserStage: "normalize"
  });
}

function assertArtifactArray(artifacts, rawStdout) {
  const normalized = artifacts.filter(isRecord);
  if (normalized.length === 0 || !normalized.some((artifact) => typeof artifact.filename === "string" && artifact.filename.length > 0)) {
    throw new NpmPackParseError("npm pack output did not contain an artifact with a filename", {
      rawStdout,
      parsedPayload: artifacts,
      parserStage: "validate"
    });
  }
  return normalized;
}

/**
 * Extract the last syntactically valid JSON array/object from mixed stdout.
 * This scanner is string-aware so braces/brackets inside JSON strings do not corrupt depth tracking.
 *
 * @param {string} stdout
 * @returns {unknown}
 */
function extractLastJsonValue(stdout) {
  const candidates = findJsonCandidateRanges(stdout);

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const [start, end] = candidates[index];
    try {
      return JSON.parse(stdout.slice(start, end + 1));
    } catch {
      // Keep walking backward. Lifecycle hooks may print JSON diagnostics before npm's final JSON payload.
    }
  }

  throw new NpmPackParseError("No valid JSON object or array found in npm pack stdout", {
    rawStdout: stdout,
    parsedPayload: null,
    parserStage: "extract"
  });
}

function findJsonCandidateRanges(source) {
  const ranges = [];
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "[" || char === "{") {
      stack.push({ char, index });
      continue;
    }

    if (char !== "]" && char !== "}") {
      continue;
    }

    const opener = stack.at(-1);
    if (!opener || !matchesPair(opener.char, char)) {
      stack.length = 0;
      continue;
    }

    stack.pop();
    if (stack.length === 0) {
      ranges.push([opener.index, index]);
    }
  }

  return ranges;
}

function matchesPair(open, close) {
  return (open === "[" && close === "]") || (open === "{" && close === "}");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
