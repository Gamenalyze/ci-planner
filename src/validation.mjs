/** Small shared boundaries; never accept dot path components in authenticated repository requests. */
export function validRepository(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}
