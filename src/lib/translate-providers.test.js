import { describe, expect, it, vi } from "vitest";

import {
  failureMessage,
  failureStatus,
  providersFromEnv,
  translateWithFallback,
} from "./translate-providers.ts";

const stream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n'),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

const failure = (status, body = "") => new Response(body, { status });

const options = (fetchImpl) => ({
  signal: new AbortController().signal,
  fetchImpl,
  backoff: () => 0,
});

const BOTH = providersFromEnv({
  GEMINI_API_KEY: "test-key",
  GEMINI_TEXT_MODEL: "gemini-main",
  GEMINI_FALLBACK_MODEL: "gemini-lite",
});

const modelOf = (url) => (String(url).includes("gemini-main") ? "main" : "lite");

describe("překlad – záložní model Gemini", () => {
  it("bez klíče Gemini nemá s čím překládat", () => {
    expect(providersFromEnv({})).toEqual([]);
  });

  it("hlavní model má přednost, záložní je druhý", () => {
    expect(BOTH.map((p) => p.model)).toEqual(["gemini-main", "gemini-lite"]);
  });

  it("posílá klíč v hlavičce, ne v adrese", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      return stream();
    });
    await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(calls[0].url).toContain("models/gemini-main:streamGenerateContent?alt=sse");
    expect(calls[0].url).not.toContain("test-key");
    expect(calls[0].headers["x-goog-api-key"]).toBe("test-key");
  });

  it("když hlavní model chybí, odpoví záložní", async () => {
    const fetchImpl = vi.fn(async (url) => (modelOf(url) === "main" ? failure(404) : stream()));
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("fallback");
    expect(result.model).toBe("gemini-lite");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("přetížení (429) zkusí u stejného modelu znovu", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () =>
      ++calls === 1 ? failure(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}') : stream(),
    );
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("primary");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("výpadek sítě u hlavního modelu přepne na záložní", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (modelOf(url) === "main") throw new TypeError("fetch failed");
      return stream();
    });
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("fallback");
  });

  it("vyčerpaný denní limit se neopakuje a hlásí se jako 402", async () => {
    const daily = '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier"}}';
    const fetchImpl = vi.fn(async () => failure(429, daily));
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(failureStatus(result.failures)).toBe(402);
    // Stejný důvod u obou modelů se v hlášce neopakuje.
    expect(failureMessage(result.failures)).toBe(
      "Překlad se nepodařil. Denní bezplatný limit Gemini je vyčerpaný. Zkuste to zítra, nebo zapněte placenou úroveň.",
    );
  });

  it("neplatný klíč se hlásí srozumitelně a neopakuje", async () => {
    const fetchImpl = vi.fn(async () => failure(400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}'));
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(failureStatus(result.failures)).toBe(401);
    expect(failureMessage(result.failures)).toContain("Klíč Gemini je neplatný");
  });

  it("zrušený požadavek už další model nevolá", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => stream());
    await expect(
      translateWithFallback(BOTH, "přelož", "Ahoj", { signal: controller.signal, fetchImpl, backoff: () => 0 }),
    ).rejects.toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
