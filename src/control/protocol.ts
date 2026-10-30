import type { Result } from "../contracts/common";
import {
  ALL_CONTROL_PERMISSIONS,
  CONTROL_METHODS,
  CONTROL_VERSION,
  type ControlError,
  type ControlPermission,
  type ControlRequest,
  type ControlResponse,
  type JsonObject,
  type JsonValue,
} from "../contracts/control";

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const errorCodes: readonly ControlError["code"][] = [
  "cancelled",
  "invalid-input",
  "unsupported",
  "unavailable",
  "conflict",
  "authentication",
  "tls",
  "network",
  "storage",
  "rate-limited",
  "internal",
  "permission-denied",
  "protocol",
  "timeout",
];
const invalid = (): { ok: false; error: ControlError } => ({
  ok: false,
  error: { code: "protocol", message: "Invalid control protocol envelope.", retryable: false },
});

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/** JSON only: no accessors, exotic prototypes, cycles, non-finite numbers or unsafe keys.
 * Depth and node budgets also bound validation of non-wire callers. */
export function isJsonValue(value: unknown): value is JsonValue {
  let remaining = 100_000;
  const dataProperty = (property: PropertyDescriptor | undefined, depth: number): boolean =>
    property !== undefined &&
    "value" in property &&
    property.enumerable === true &&
    visit(property.value, depth + 1);
  const visitArray = (item: readonly unknown[], depth: number): boolean => {
    if (
      Object.getPrototypeOf(item) !== Array.prototype ||
      item.length > remaining ||
      Object.getOwnPropertyNames(item).length !== item.length + 1 ||
      Object.getOwnPropertySymbols(item).length !== 0
    )
      return false;
    for (let index = 0; index < item.length; index++) {
      if (!dataProperty(Object.getOwnPropertyDescriptor(item, String(index)), depth)) return false;
    }
    return true;
  };
  const visitRecord = (item: Record<string, unknown>, depth: number): boolean => {
    if (Object.getOwnPropertySymbols(item).length !== 0) return false;
    for (const key of Object.getOwnPropertyNames(item)) {
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (unsafeKeys.has(key) || !dataProperty(property, depth)) return false;
    }
    return true;
  };
  const visit = (item: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 64) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (Array.isArray(item)) return visitArray(item, depth);
    return record(item) && visitRecord(item, depth);
  };
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return record(value) && isJsonValue(value);
}

function fields(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

export function parseControlRequest(value: unknown): Result<ControlRequest, ControlError> {
  if (
    !isJsonObject(value) ||
    !fields(value, ["version", "id", "method", "params", "permissions"]) ||
    value.version !== CONTROL_VERSION ||
    !validId(value.id) ||
    !isJsonObject(value.params) ||
    !Array.isArray(value.permissions)
  )
    return invalid();
  const method = CONTROL_METHODS.find((candidate) => candidate === value.method);
  if (!method || value.permissions.length > ALL_CONTROL_PERMISSIONS.length) return invalid();
  const permissions: ControlPermission[] = [];
  for (const input of value.permissions) {
    const permission = ALL_CONTROL_PERMISSIONS.find((candidate) => candidate === input);
    if (!permission || permissions.includes(permission)) return invalid();
    permissions.push(permission);
  }
  return {
    ok: true,
    value: { version: CONTROL_VERSION, id: value.id, method, params: value.params, permissions },
  };
}

export function parseControlResponse(value: unknown): Result<ControlResponse, ControlError> {
  if (!isJsonObject(value) || value.version !== CONTROL_VERSION || !validId(value.id))
    return invalid();
  if (
    value.ok === true &&
    fields(value, ["version", "id", "ok", "result"]) &&
    isJsonValue(value.result)
  ) {
    return {
      ok: true,
      value: { version: CONTROL_VERSION, id: value.id, ok: true, result: value.result },
    };
  }
  if (
    value.ok !== false ||
    !fields(value, ["version", "id", "ok", "error"]) ||
    !isJsonObject(value.error) ||
    !fields(value.error, ["code", "message", "retryable"], ["outcome"])
  )
    return invalid();
  const error = value.error;
  const code = errorCodes.find((candidate) => candidate === error.code);
  if (
    !code ||
    typeof error.message !== "string" ||
    error.message.length > 1024 ||
    Array.from(error.message).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159);
    }) ||
    typeof error.retryable !== "boolean" ||
    (Object.hasOwn(error, "outcome") && error.outcome !== "unknown")
  )
    return invalid();
  return {
    ok: true,
    value: {
      version: CONTROL_VERSION,
      id: value.id,
      ok: false,
      error: {
        code,
        message: error.message,
        retryable: error.retryable,
        ...(error.outcome === "unknown" ? { outcome: "unknown" } : {}),
      },
    },
  };
}
