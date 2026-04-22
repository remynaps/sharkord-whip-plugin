import { describe, it, expect, mock } from "bun:test";
import { corsResponse, addOnceListener } from "../src/server/util.ts";

describe("corsResponse", () => {
  it("sets all required CORS headers", () => {
    const res = corsResponse(new Response(null, { status: 200 }));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe("Location");
  });

  it("preserves the original status code", () => {
    expect(corsResponse(new Response(null, { status: 204 })).status).toBe(204);
  });
});

describe("addOnceListener", () => {
  it("uses once() when available", () => {
    const once = mock(() => {});
    const on = mock(() => {});
    addOnceListener({ once, on }, "close", () => {});
    expect(once).toHaveBeenCalledTimes(1);
    expect(on).not.toHaveBeenCalled();
  });

  it("falls back to on() when once is absent", () => {
    const on = mock(() => {});
    addOnceListener({ on }, "close", () => {});
    expect(on).toHaveBeenCalledTimes(1);
  });

  it("does nothing when target is null", () => {
    expect(() => addOnceListener(null, "close", () => {})).not.toThrow();
  });
});
