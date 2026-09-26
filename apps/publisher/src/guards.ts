/** Type guards for decoding JSON files and API responses before use. */

export type JsonRecord = { readonly [key: string]: JsonInput };

export type JsonInput = string | number | boolean | null | JsonRecord | readonly JsonInput[];

export function isRecord(value: JsonInput | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: JsonInput | undefined): value is string {
  return typeof value === "string";
}

export function isBoolean(value: JsonInput | undefined): value is boolean {
  return typeof value === "boolean";
}

export function isList(value: JsonInput | undefined): value is readonly JsonInput[] {
  return Array.isArray(value);
}

/** Parse JSON text into a value that must be narrowed before use. */
export function parseJson(text: string): JsonInput {
  const parsed: JsonInput = JSON.parse(text);

  return parsed;
}

export function optionalString(record: JsonRecord, key: string, where: string): string | undefined {
  const value = record[key];

  if (value === undefined) return undefined;

  if (!isString(value)) throw new Error(`${where}: "${key}" must be a string`);

  return value;
}

export function requiredString(record: JsonRecord, key: string, where: string): string {
  const value = optionalString(record, key, where);

  if (value === undefined || value.trim() === "") throw new Error(`${where}: "${key}" is required`);

  return value;
}
