import { entityId } from "../contracts/common";
import type { ControlError, JsonObject, JsonValue } from "../contracts/control";

export class ControlFault extends Error {
  constructor(readonly detail: ControlError) {
    super(detail.message);
  }
}
export function fail(code: ControlError["code"], message: string, retryable = false): never {
  throw new ControlFault({ code, message, retryable });
}
export function object(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
export function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !object(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail("invalid-input", "Parameters do not match the documented schema.");
  return value;
}
export function string(value: unknown, max = 65536): string {
  if (typeof value !== "string" || value.length > max)
    fail("invalid-input", "A string parameter is missing or exceeds its size limit.");
  return value;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail("invalid-input", "A boolean parameter is required.");
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    fail("invalid-input", "A numeric parameter is outside its allowed range.");
  return value;
}
export function opaqueId<Kind extends string>(value: unknown, max = 512) {
  const text = string(value, max);
  if (
    !text ||
    /\s/u.test(text) ||
    Array.from(text).some((c) => {
      const code = c.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  )
    fail("invalid-input", "Invalid opaque identifier.");
  return entityId<Kind>(text);
}
export function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  for (const candidate of choices) if (value === candidate) return candidate;
  return fail("invalid-input", "An enumerated parameter is not supported.");
}

export function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry: unknown) => isJson(entry, depth + 1));
  if (!object(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && isJson(entry, depth + 1),
  );
}
/** Produce an owned JSON copy; never serialize platform exceptions or arbitrary runtime objects. */
export function json(value: unknown): JsonValue {
  const copied: unknown = JSON.parse(JSON.stringify(value));
  if (!isJson(copied)) fail("internal", "The control result is not serializable.");
  return copied;
}
export function jsonObject(value: unknown): JsonObject {
  if (!object(value) || !isJson(value))
    fail("invalid-input", "A JSON object parameter is required.");
  return value;
}
