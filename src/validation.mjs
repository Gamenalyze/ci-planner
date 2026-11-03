/** Small shared boundaries; never accept dot path components in authenticated repository requests. */
// Git object IDs may use SHA-1 or SHA-256. GitHub Action pins remain SHA-1.
export const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const ACTION_SHA = /^[0-9a-f]{40}$/;
export const WORKFLOW = /^\.github\/workflows\/[^/\\\x00-\x20\x7f]+\.ya?ml$/;
export const WORKFLOW_FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/;

/** Explicit valued/boolean options, with no duplicates or implicit values. */
export function parseOptions(args, values, booleans = []) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (![...values, ...booleans].includes(key) || Object.hasOwn(result, key))
      throw Error("Unknown or repeated option; use --help");
    if (booleans.includes(key)) result[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw Error("Missing option value");
      result[key] = value;
    }
  }
  return result;
}

export function validRepository(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}
