const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const AUTH_REDIRECT_QUERY_PARAM = "redirect_url";
export const CLERK_ACCOUNTS_URL = "https://accounts.superplanner.ai";

export class AuthRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRedirectError";
  }
}

export function getAppBasePath(): string {
  return BASE;
}

export function buildAppUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${window.location.origin}${BASE}${normalizedPath}`;
}

function buildAuthUrl(path: "/sign-in", returnPath: string): string {
  return `${buildAppUrl(path)}?${AUTH_REDIRECT_QUERY_PARAM}=${encodeURIComponent(
    buildAppUrl(returnPath),
  )}`;
}

export function buildSignInUrl(returnPath = "/dashboard"): string {
  return buildAuthUrl("/sign-in", returnPath);
}

export function redirectToSignIn(returnPath = "/dashboard"): never {
  window.location.href = buildSignInUrl(returnPath);
  throw new AuthRedirectError("Redirecting to product sign-in.");
}

export function isAuthRedirectError(error: unknown): boolean {
  return error instanceof AuthRedirectError;
}
