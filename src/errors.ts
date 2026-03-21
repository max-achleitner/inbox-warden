/** Extract a safe error message without stack traces or internal paths */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
