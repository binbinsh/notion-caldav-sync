import { describe, expect, it } from "vitest";
import { basicAuthHeader } from "../src/calendar/webdav";

describe("basicAuthHeader", () => {
  it("produces a valid Basic auth header for ASCII credentials", () => {
    const header = basicAuthHeader("user@example.com", "password123");
    expect(header).toMatch(/^Basic /);
    // Decode and verify
    const decoded = atob(header.replace("Basic ", ""));
    expect(decoded).toBe("user@example.com:password123");
  });

  it("handles non-ASCII passwords without throwing", () => {
    // This was previously a bug: btoa would throw on non-ASCII
    expect(() => basicAuthHeader("user@example.com", "密码-pässwörd")).not.toThrow();
    const header = basicAuthHeader("user@example.com", "密码-pässwörd");
    expect(header).toMatch(/^Basic /);
  });

  it("handles non-ASCII usernames without throwing", () => {
    expect(() => basicAuthHeader("用户@example.com", "pass")).not.toThrow();
    const header = basicAuthHeader("用户@example.com", "pass");
    expect(header).toMatch(/^Basic /);
  });

  it("handles empty credentials", () => {
    const header = basicAuthHeader("", "");
    expect(header).toMatch(/^Basic /);
    const decoded = atob(header.replace("Basic ", ""));
    expect(decoded).toBe(":");
  });

  it("handles special characters in app-specific passwords", () => {
    // Apple app-specific passwords format: xxxx-xxxx-xxxx-xxxx
    const header = basicAuthHeader("user@icloud.com", "abcd-efgh-ijkl-mnop");
    expect(header).toMatch(/^Basic /);
    const decoded = atob(header.replace("Basic ", ""));
    expect(decoded).toBe("user@icloud.com:abcd-efgh-ijkl-mnop");
  });
});
