import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDiscordStatusCacheForTests,
  DISCORD_STATUS_CACHE_MS,
  fetchDiscordStatus,
  parseStatuspageJson,
} from "./discord-status.js";

describe("parseStatuspageJson", () => {
  it("parses a well-formed Statuspage response", () => {
    const json = JSON.stringify({ status: { indicator: "none", description: "All Systems Operational" } });
    expect(parseStatuspageJson(json)).toEqual({ indicator: "none", description: "All Systems Operational" });
  });

  it("returns null for invalid JSON instead of throwing", () => {
    expect(parseStatuspageJson("not json")).toBeNull();
  });

  it("returns null when the top level isn't an object", () => {
    expect(parseStatuspageJson("42")).toBeNull();
    expect(parseStatuspageJson("null")).toBeNull();
  });

  it("returns null when status.indicator or status.description is missing/wrong type", () => {
    expect(parseStatuspageJson(JSON.stringify({}))).toBeNull();
    expect(parseStatuspageJson(JSON.stringify({ status: {} }))).toBeNull();
    expect(parseStatuspageJson(JSON.stringify({ status: { indicator: 1, description: "x" } }))).toBeNull();
    expect(parseStatuspageJson(JSON.stringify({ status: { indicator: "none" } }))).toBeNull();
  });
});

describe("fetchDiscordStatus", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    __resetDiscordStatusCacheForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(status: { indicator: string; description: string }): Response {
    return {
      ok: true,
      text: async () => JSON.stringify({ status }),
    } as unknown as Response;
  }

  it("returns the parsed status on a successful fetch", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ indicator: "none", description: "All Systems Operational" }));
    const result = await fetchDiscordStatus(() => 1_000);
    expect(result).toEqual({ indicator: "none", description: "All Systems Operational" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches the result -- a second call within DISCORD_STATUS_CACHE_MS does not refetch", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ indicator: "none", description: "All Systems Operational" }));
    const first = await fetchDiscordStatus(() => 1_000);
    const second = await fetchDiscordStatus(() => 1_000 + DISCORD_STATUS_CACHE_MS - 1);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches once the cache window has elapsed", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ indicator: "none", description: "All Systems Operational" }));
    fetchMock.mockResolvedValueOnce(okResponse({ indicator: "major", description: "Some systems affected" }));
    const first = await fetchDiscordStatus(() => 1_000);
    const second = await fetchDiscordStatus(() => 1_000 + DISCORD_STATUS_CACHE_MS + 1);
    expect(first?.indicator).toBe("none");
    expect(second?.indicator).toBe("major");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null (never throws) on a non-ok HTTP response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => "" } as unknown as Response);
    await expect(fetchDiscordStatus(() => 1_000)).resolves.toBeNull();
  });

  it("returns null (never throws) when fetch itself rejects (network error / timeout)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(fetchDiscordStatus(() => 1_000)).resolves.toBeNull();
  });

  it("returns null on malformed JSON in an otherwise-ok response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => "not json" } as unknown as Response);
    await expect(fetchDiscordStatus(() => 1_000)).resolves.toBeNull();
  });
});
