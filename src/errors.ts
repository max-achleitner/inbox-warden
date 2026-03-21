/** Extract a safe error message without stack traces or internal paths */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class ImapConnectionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = "ImapConnectionError";
  }
}

export class SmtpConnectionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = "SmtpConnectionError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
