import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Coerce any runtime value (event payloads from `pi --mode json` are not always
 * the shape their docs promise) into a display-safe string. Never throws.
 */
export function toText(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value, null, 2) ?? ""
  } catch {
    return String(value)
  }
}
