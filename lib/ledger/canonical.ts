import { createHash } from "node:crypto";

import type { CanonicalValue, LedgerCanonicalPayload } from "./types";

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "string": return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
        throw new Error(`${path} must be a safe integer`);
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) {
          throw new Error(`${path} must not contain sparse array elements`);
        }
        return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path} must contain only plain JSON objects`);
      }
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => {
        if (record[key] === undefined) throw new Error(`${path}.${key} must not be undefined`);
        return `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`;
      }).join(",")}}`;
    }
    default: throw new Error(`${path} contains unsupported ${typeof value}`);
  }
}

export function canonicalStringify(value: CanonicalValue | unknown): string {
  return serialize(value, "$root");
}

export const canonicalize = canonicalStringify;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}


export function hashLedgerEvent(payload: LedgerCanonicalPayload): string {
  return sha256Hex(canonicalStringify(payload));
}
