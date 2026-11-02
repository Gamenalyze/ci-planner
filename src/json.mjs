import { parseDocument } from "yaml";
/** Require JSON syntax and unique decoded keys, including escaped spellings of a key. */
export function uniqueJSON(source) {
  const value = JSON.parse(source);
  const doc = parseDocument(source, { uniqueKeys: true, strict: true });
  if (doc.errors.length)
    throw Error("JSON object keys must be unique (duplicate key)");
  return value;
}
