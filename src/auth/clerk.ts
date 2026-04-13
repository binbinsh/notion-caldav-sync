import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { clerkMiddleware, getAuth } from "@clerk/hono";

/**
 * Accounts portal for the shared superplanner.ai Clerk instance.
 */
export const CLERK_ACCOUNTS_URL = "https://accounts.superplanner.ai";

export type AppEnv = {
  APP_ENCRYPTION_KEY?: string;
  APP_BASE_PATH?: string;
  ASSETS?: Fetcher;
  AUTH_DB: D1Database;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  INTERNAL_SERVICE_TOKEN?: string;
  NOTION_API_VERSION?: string;
  TENANT_SYNC?: DurableObjectNamespace;
};

/**
 * Build a standalone Clerk Backend API client.
 * Use this in contexts where the Hono middleware is not available
 * (e.g. Durable Objects, cron handlers).
 */
export function buildClerkClient(env: { CLERK_SECRET_KEY: string; CLERK_PUBLISHABLE_KEY: string }): ClerkClient {
  return createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
  });
}

/**
 * Fetch the Notion OAuth access token for a Clerk user.
 * Returns the token string or null if the user hasn't connected Notion.
 */
export async function getNotionOAuthToken(
  clerk: ClerkClient,
  userId: string,
): Promise<string | null> {
  try {
    const response = await clerk.users.getUserOauthAccessToken(userId, "notion");
    const first = response.data?.[0];
    return first?.token ?? null;
  } catch {
    return null;
  }
}

export type { ClerkClient };
export { clerkMiddleware, getAuth };
