import { describe, expect, it } from "vitest";
import {
  buildLocalAuthUrl,
  canonicalizeAuthPath,
  resolveRequestedRedirectUrl,
} from "../src/auth/navigation";

describe("auth navigation", () => {
  const requestUrl = "https://superplanner.ai/dashboard";
  const serviceBasePath = "/caldav-sync";

  it("builds product-scoped local auth urls", () => {
    expect(buildLocalAuthUrl(requestUrl, serviceBasePath, "sign-in", "/caldav-sync/dashboard")).toBe(
      "https://superplanner.ai/caldav-sync/sign-in?redirect_url=https%3A%2F%2Fsuperplanner.ai%2Fcaldav-sync%2Fdashboard",
    );
  });

  it("keeps same-origin redirects inside the service base path", () => {
    expect(
      resolveRequestedRedirectUrl(
        requestUrl,
        serviceBasePath,
        "/caldav-sync/dashboard",
        "/caldav-sync/dashboard?lang=zh-hans",
      ),
    ).toBe("https://superplanner.ai/caldav-sync/dashboard?lang=zh-hans");
    expect(
      resolveRequestedRedirectUrl(
        requestUrl,
        serviceBasePath,
        "/caldav-sync/dashboard",
        "/caldav-sync",
      ),
    ).toBe("https://superplanner.ai/caldav-sync");
  });

  it("falls back when redirect target is outside the service base path", () => {
    expect(
      resolveRequestedRedirectUrl(
        requestUrl,
        serviceBasePath,
        "/caldav-sync/dashboard",
        "https://superplanner.ai/other-app",
      ),
    ).toBe("https://superplanner.ai/caldav-sync/dashboard");
  });

  it("falls back when redirect target is off-origin", () => {
    expect(
      resolveRequestedRedirectUrl(
        requestUrl,
        serviceBasePath,
        "/caldav-sync/dashboard",
        "https://evil.example/phish",
      ),
    ).toBe("https://superplanner.ai/caldav-sync/dashboard");
  });

  it("canonicalizes auth page trailing slashes", () => {
    expect(canonicalizeAuthPath("/dashboard/")).toBe("/dashboard");
    expect(canonicalizeAuthPath("/sign-in/")).toBe("/sign-in");
    expect(canonicalizeAuthPath("/sign-out//")).toBe("/sign-out");
    expect(canonicalizeAuthPath("/api/workspaces/")).toBeNull();
  });
});
