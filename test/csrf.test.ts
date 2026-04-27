import { describe, expect, it } from "vitest";
import {
  createCsrfToken,
  hasHostileBrowserOrigin,
  verifyCsrfToken,
} from "../src/auth/csrf";

describe("csrf protection helpers", () => {
  const secret = "sk_test_csrf_secret";
  const userId = "user_123";
  const now = Date.parse("2026-04-27T12:00:00Z");

  it("creates user-bound csrf tokens that verify for the same user", async () => {
    const token = await createCsrfToken(secret, userId, now);

    await expect(verifyCsrfToken(secret, userId, token, now)).resolves.toBe(true);
    await expect(verifyCsrfToken(secret, "user_other", token, now)).resolves.toBe(false);
  });

  it("rejects expired csrf tokens", async () => {
    const token = await createCsrfToken(secret, userId, now);

    await expect(verifyCsrfToken(secret, userId, token, now + 13 * 60 * 60 * 1000)).resolves.toBe(false);
  });

  it("detects hostile browser origins", () => {
    expect(hasHostileBrowserOrigin(new Request("https://superplanner.ai/caldav-sync/apple", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }))).toBe(true);
    expect(hasHostileBrowserOrigin(new Request("https://superplanner.ai/caldav-sync/apple", {
      method: "POST",
      headers: { origin: "https://superplanner.ai" },
    }))).toBe(false);
    expect(hasHostileBrowserOrigin(new Request("https://superplanner.ai/caldav-sync/apple", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    }))).toBe(true);
  });
});
