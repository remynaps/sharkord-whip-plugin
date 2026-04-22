import { describe, it, expect, jest, afterEach } from "bun:test";
import {
  safeEqual,
  sanitizeTitle,
  checkRateLimit,
  recordFailedAttempt,
  clearFailedAttempts,
} from "../src/server/whip-server.ts";

afterEach(() => {
  jest.setSystemTime(new Date());
});

describe("safeEqual", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("secret", "secret")).toBe(true);
  });

  it("returns false for different content", () => {
    expect(safeEqual("secret", "wrong")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("sanitizeTitle", () => {
  it("trims and collapses whitespace", () => {
    expect(sanitizeTitle("  hello   world  ")).toBe("hello world");
  });

  it("falls back to OBS Stream on empty input", () => {
    expect(sanitizeTitle("")).toBe("OBS Stream");
  });

  it("falls back to OBS Stream on whitespace-only input", () => {
    expect(sanitizeTitle("   ")).toBe("OBS Stream");
  });

  it("clamps output to 64 characters", () => {
    expect(sanitizeTitle("a".repeat(100)).length).toBe(64);
  });

  it("strips low control characters", () => {
    expect(sanitizeTitle("hello\x01world")).not.toContain("\x01");
  });
});

describe("rate limiter", () => {
  it("allows a fresh IP", () => {
    expect(checkRateLimit("10.0.0.1")).toBe(true);
  });

  it("still allows after 4 failures", () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < 4; i++) recordFailedAttempt(ip);
    expect(checkRateLimit(ip)).toBe(true);
  });

  it("blocks after 5 failures", () => {
    const ip = "10.0.0.3";
    for (let i = 0; i < 5; i++) recordFailedAttempt(ip);
    expect(checkRateLimit(ip)).toBe(false);
  });

  it("allows again after clearFailedAttempts", () => {
    const ip = "10.0.0.4";
    for (let i = 0; i < 5; i++) recordFailedAttempt(ip);
    clearFailedAttempts(ip);
    expect(checkRateLimit(ip)).toBe(true);
  });

  it("allows again after the window expires", () => {
    const ip = "10.0.0.5";
    const now = Date.now();
    jest.setSystemTime(now);
    for (let i = 0; i < 5; i++) recordFailedAttempt(ip);
    expect(checkRateLimit(ip)).toBe(false);
    jest.setSystemTime(now + 61_000);
    expect(checkRateLimit(ip)).toBe(true);
  });
});
