import { describe, expect, it } from "vitest";
import { parsePageParam, safeDecodeURIComponent } from "./query-params";

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

describe("parsePageParam", () => {
  it("parses valid positive integer pages", () => {
    expect(parsePageParam("1")).toBe(1);
    expect(parsePageParam("3")).toBe(3);
    expect(parsePageParam(" 12 ")).toBe(12);
  });

  it("falls back to 1 for invalid, empty, zero, or negative inputs", () => {
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam(null)).toBe(1);
    expect(parsePageParam("")).toBe(1);
    expect(parsePageParam("abc")).toBe(1);
    expect(parsePageParam("NaN")).toBe(1);
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("-4")).toBe(1);
  });

  it("supports custom fallback values", () => {
    expect(parsePageParam("abc", 2)).toBe(2);
  });
});
