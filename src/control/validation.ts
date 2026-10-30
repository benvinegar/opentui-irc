import { entityId } from "../contracts/common";
import type { ControlError, JsonObject, JsonValue } from "../contracts/control";
import { isJsonValue } from "./protocol";

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
  // Also protect direct in-process callers: accessors, inherited/prototype keys and exotic
  // JSON values must not execute code or disappear during fingerprinting/validation.
  if (
    !isJsonValue(value) ||
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
export const OPAQUE_ID_PATTERN = "^[^\\s\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]+$";
export function opaqueId<Kind extends string>(value: unknown, max = 512) {
  const text = string(value, max);
  if (!new RegExp(OPAQUE_ID_PATTERN, "u").test(text))
    fail("invalid-input", "Invalid opaque identifier.");
  return entityId<Kind>(text);
}
export function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  for (const candidate of choices) if (value === candidate) return candidate;
  return fail("invalid-input", "An enumerated parameter is not supported.");
}
export function isJson(value: unknown): value is JsonValue {
  return isJsonValue(value);
}

/** Owned, bounded output JSON. Omit undefined object properties like JSON.stringify, but
 * never invoke getters/toJSON, serialize exception instances, or silently rewrite non-JSON data. */
export function json(value: unknown): JsonValue {
  let remaining = 100000;
  let units = 0;
  const ancestors = new Set<object>();
  const invalid = (): never =>
    fail("internal", "The control result is not serializable or exceeds supported limits.");
  // Only own, enumerable data properties are copied; accessors are never invoked.
  const dataValue = (input: object, name: string): unknown => {
    const property = Object.getOwnPropertyDescriptor(input, name);
    if (!property || !property.enumerable || !("value" in property)) return invalid();
    const child: unknown = property.value;
    return child;
  };
  const copyArray = (input: readonly unknown[], depth: number): JsonValue[] => {
    if (
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > remaining ||
      Reflect.ownKeys(input).length !== input.length + 1
    )
      return invalid();
    const items: JsonValue[] = [];
    for (let index = 0; index < input.length; index++)
      items.push(copy(dataValue(input, String(index)), depth + 1));
    return items;
  };
  const copyObject = (input: object, depth: number): JsonObject => {
    if (!object(input)) return invalid();
    const properties: Record<string, JsonValue> = {};
    for (const name of Reflect.ownKeys(input)) {
      if (typeof name !== "string" || ["__proto__", "prototype", "constructor"].includes(name))
        return invalid();
      units += name.length;
      if (units > 4194304) return invalid();
      const child = dataValue(input, name);
      if (child !== undefined) properties[name] = copy(child, depth + 1);
    }
    return properties;
  };
  function copy(input: unknown, depth: number): JsonValue {
    if (--remaining < 0 || depth > 64) return invalid();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : invalid();
    if (typeof input === "string") {
      units += input.length;
      return units <= 4194304 ? input : invalid();
    }
    if (typeof input !== "object" || input === null || ancestors.has(input)) return invalid();
    ancestors.add(input);
    const result = Array.isArray(input) ? copyArray(input, depth) : copyObject(input, depth);
    ancestors.delete(input);
    return result;
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 4194304) return invalid();
  return result;
}
export function jsonObject(value: unknown): JsonObject {
  if (!isJsonValue(value) || !object(value))
    fail("invalid-input", "A JSON object parameter is required.");
  return value;
}
