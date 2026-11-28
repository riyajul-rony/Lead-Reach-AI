import { describe, expect, it } from "vitest";
import { safeDecodeURIComponent } from "./query-params";

describe("safeDecodeURIComponent", () => {
  it("decodes valid percent-encoded strings", () => {
    expect(safeDecodeURIComponent("user%2Btest%40example.com")).toBe("user+test@example.com");
    expect(safeDecodeURIComponent("hello%20world")).toBe("hello world");
  });

  it("returns empty string for null, undefined, or empty input", () => {
    expect(safeDecodeURIComponent(undefined)).toBe("");
    expect(safeDecodeURIComponent(null)).toBe("");
    expect(safeDecodeURIComponent("")).toBe("");
  });

  it("does not throw on malformed percent-encoding and falls back safely", () => {
    expect(safeDecodeURIComponent("%")).toBe("%");
    expect(safeDecodeURIComponent("100% failed")).toBe("100% failed");
    expect(safeDecodeURIComponent("bad%ZZvalue")).toBe("bad%ZZvalue");
    expect(safeDecodeURIComponent("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
