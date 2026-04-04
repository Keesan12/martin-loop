const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})Z$/;

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isEmail(value: unknown): value is string {
  return isNonEmptyString(value) && EMAIL_PATTERN.test(value);
}

export function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

export function isIsoTimestamp(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    ISO_UTC_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

export function isPercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function isBoundedArray<T>(
  value: unknown,
  options: {
    min?: number;
    max: number;
    itemGuard?: (item: unknown) => item is T;
  } = { max: 100 }
): value is T[] {
  if (!Array.isArray(value)) {
    return false;
  }

  const min = options.min ?? 0;
  if (value.length < min || value.length > options.max) {
    return false;
  }

  if (!options.itemGuard) {
    return true;
  }

  return value.every((item) => options.itemGuard?.(item) ?? true);
}
