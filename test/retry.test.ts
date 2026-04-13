import { describe, expect, it } from "vitest";
import { withRetry, RateLimiter, parallelMap } from "../src/lib/retry";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("retries on transient failure and succeeds", async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        if (attempt < 3) {
          const error = new Error("fetch failed");
          throw error;
        }
        return Promise.resolve("ok");
      },
      { maxAttempts: 3, baseDelayMs: 10 },
    );
    expect(result).toBe("ok");
    expect(attempt).toBe(3);
  });

  it("throws after max attempts exhausted", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        () => {
          attempt++;
          throw new Error("fetch failed");
        },
        { maxAttempts: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow("fetch failed");
    expect(attempt).toBe(2);
  });

  it("does not retry when shouldRetry returns false", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        () => {
          attempt++;
          throw new Error("permanent");
        },
        {
          maxAttempts: 3,
          baseDelayMs: 10,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow("permanent");
    expect(attempt).toBe(1);
  });

  it("retries on HTTP 429 status", async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        if (attempt < 2) {
          throw { status: 429, message: "rate limited" };
        }
        return Promise.resolve("done");
      },
      { maxAttempts: 3, baseDelayMs: 10 },
    );
    expect(result).toBe("done");
    expect(attempt).toBe(2);
  });
});

describe("RateLimiter", () => {
  it("allows immediate requests within capacity", async () => {
    const limiter = new RateLimiter(3, 3);
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    // First 3 should be nearly instant (within token capacity)
    expect(elapsed).toBeLessThan(100);
  });

  it("delays when tokens are exhausted", async () => {
    const limiter = new RateLimiter(1, 10); // 1 token, refills at 10/s
    await limiter.acquire(); // Consume the only token
    const start = Date.now();
    await limiter.acquire(); // Should wait ~100ms
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});

describe("parallelMap", () => {
  it("processes all items", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await parallelMap(items, (n) => Promise.resolve(n * 2), 3);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("respects concurrency limit", async () => {
    let maxConcurrent = 0;
    let active = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await parallelMap(
      items,
      async (n) => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return n;
      },
      3,
    );

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("handles empty input", async () => {
    const results = await parallelMap([], async (n: number) => n, 5);
    expect(results).toEqual([]);
  });

  it("preserves order of results", async () => {
    const items = [3, 1, 4, 1, 5];
    const results = await parallelMap(
      items,
      async (n) => {
        await new Promise((r) => setTimeout(r, Math.random() * 20));
        return n * 10;
      },
      2,
    );
    expect(results).toEqual([30, 10, 40, 10, 50]);
  });
});
