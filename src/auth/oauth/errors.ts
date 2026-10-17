import { SERVER_NAME } from "../../version.js";

/** Misconfiguration the user or administrator must fix (missing client id, unknown tenant, …). */
export class OAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthConfigurationError";
  }
}

/** Error answer from a token endpoint (RFC 6749 §5.2). */
export class OAuthTokenError extends Error {
  constructor(readonly code: string, readonly description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = "OAuthTokenError";
  }
}

/** No sign-in is stored yet for an OAuth account (typical right after installing the bundle). */
export class OAuthSignInRequiredError extends Error {
  constructor(readonly accountId: string) {
    super(`Not signed in yet to mail account "${accountId}" — ask me to run sign_in (or run "${SERVER_NAME} setup").`);
    this.name = "OAuthSignInRequiredError";
  }
}

/** The stored sign-in can no longer be used; the user has to sign in again. */
export class OAuthReauthRequiredError extends Error {
  constructor(readonly accountId: string, reason: string) {
    super(
      `The sign-in for mail account "${accountId}" is no longer valid (${reason}). ` +
        `Ask me to run sign_in, or run "${SERVER_NAME} setup" and choose "Sign in again".`,
    );
    this.name = "OAuthReauthRequiredError";
  }
}

/** The provider redirected back with an error (user cancelled, consent denied, …). */
export class OAuthAuthorizationError extends Error {
  constructor(readonly code: string, description?: string) {
    super(
      code === "access_denied"
        ? "Sign-in was cancelled or access was not granted."
        : `Sign-in failed (${code}${description ? `: ${description}` : ""}).`,
    );
    this.name = "OAuthAuthorizationError";
  }
}

export class OAuthTimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out. Please start the sign-in again.`);
    this.name = "OAuthTimeoutError";
  }
}
