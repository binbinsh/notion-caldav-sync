import { describe, expect, it } from "vitest";
import {
  collectPageIds,
  extractEventTypes,
  extractRoutingIds,
} from "../src/notion/webhook";

describe("webhook recursion depth limits", () => {
  function buildDeeplyNested(depth: number, leaf: unknown): unknown {
    let current = leaf;
    for (let i = 0; i < depth; i++) {
      current = { payload: current };
    }
    return current;
  }

  it("collectPageIds stops at MAX_RECURSION_DEPTH and does not crash", () => {
    const pageId = "9c01f93a6862420f941f7609fa1f8911";
    const deepPayload = buildDeeplyNested(50, {
      object: "page",
      id: pageId,
    });

    // Should not throw
    const result = collectPageIds(deepPayload);

    // The page ID is nested 50 levels deep, beyond MAX_RECURSION_DEPTH=20
    // So it should NOT be found
    expect(result).toEqual([]);
  });

  it("collectPageIds finds page IDs within depth limit", () => {
    const pageId = "9c01f93a-6862-420f-941f-7609fa1f8911";
    const shallowPayload = buildDeeplyNested(10, {
      object: "page",
      id: pageId,
    });

    const result = collectPageIds(shallowPayload);

    expect(result).toEqual([pageId]);
  });

  it("extractEventTypes stops at MAX_RECURSION_DEPTH", () => {
    const deepPayload = buildDeeplyNested(50, {
      type: "page.updated",
    });

    const result = extractEventTypes(deepPayload);

    // "page.updated" is too deep to find
    expect(result).toEqual([]);
  });

  it("extractEventTypes finds types within depth limit", () => {
    const shallowPayload = buildDeeplyNested(10, {
      type: "page.updated",
    });

    const result = extractEventTypes(shallowPayload);

    expect(result).toEqual(["page.updated"]);
  });

  it("extractRoutingIds stops at MAX_RECURSION_DEPTH", () => {
    const deepPayload = buildDeeplyNested(50, {
      bot_id: "bot-123",
      workspace_id: "ws-456",
    });

    const result = extractRoutingIds(deepPayload);

    expect(result.botIds).toEqual([]);
    expect(result.workspaceIds).toEqual([]);
  });

  it("extractRoutingIds finds IDs within depth limit", () => {
    const shallowPayload = buildDeeplyNested(10, {
      bot_id: "bot-123",
      workspace_id: "ws-456",
    });

    const result = extractRoutingIds(shallowPayload);

    expect(result.botIds).toEqual(["bot-123"]);
    expect(result.workspaceIds).toEqual(["ws-456"]);
  });

  it("handles circular-like deeply nested arrays without crashing", () => {
    // Build a deeply nested array structure
    let current: unknown = [{ page_id: "9c01f93a6862420f941f7609fa1f8911" }];
    for (let i = 0; i < 50; i++) {
      current = { data: [current] };
    }

    // Should not throw or hang
    const result = collectPageIds(current);

    // Page ID is beyond depth limit so should not be found
    expect(result).toEqual([]);
  });
});
