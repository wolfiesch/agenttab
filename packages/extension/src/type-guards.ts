export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed: Record<string, true> = {};
  for (const key of required) allowed[key] = true;
  for (const key of optional) allowed[key] = true;
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed[key]);
}

export function isBoundedString(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

export function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
