/** A reloaded extension leaves its old content scripts running in open tabs. */
export function hasExtensionContext(): boolean {
  return Boolean(globalThis.chrome?.runtime?.id);
}

export function isContextInvalidatedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Extension context invalidated");
}
