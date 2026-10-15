import { describe, expect, it, vi } from "vitest";

import {
  failureStatus,
  providersFromEnv,
  translateWithFallback,
} from "./translate-providers.ts";

const stream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'));
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
  OPENAI_API_KEY: "sk-test",
  OPENAI_TEXT_MODEL: "gpt-5-mini",
  OPENAI_FALLBACK_MODEL: "gpt-4.1-mini",
});

const modelOf = (init) => JSON.parse(String(init.body)).model;

describe("překlad – záložní model", () => {
  it("bez klíče OpenAI nemá s čím překládat", () => {
    expect(providersFromEnv({})).toEqual([]);
  });

  it("hlavní model má přednost, záložní je druhý", () => {
    expect(BOTH.map((p) => p.model)).toEqual(["gpt-5-mini", "gpt-4.1-mini"]);
  });

  it("parametr reasoning posílá jen modelům, které ho umí", async () => {
    const bodies = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return modelOf(init) === "gpt-5-mini" ? failure(404) : stream();
    });
    await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(bodies[0].reasoning).toEqual({ effort: "low" });
    expect(bodies[1].reasoning).toBeUndefined();
  });

  it("když hlavní model selže, odpoví záložní", async () => {
    const fetchImpl = vi.fn(async (_url, init) =>
      modelOf(init) === "gpt-5-mini" ? failure(403) : stream(),
    );
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("fallback");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dočasnou chybu zkusí u stejného modelu znovu", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => (++calls === 1 ? failure(503) : stream()));
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("primary");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("výpadek sítě u hlavního modelu přepne na záložní", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      if (modelOf(init) === "gpt-5-mini") throw new TypeError("fetch failed");
      return stream();
    });
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("fallback");
  });

  it("vyčerpaný kredit se neopakuje a hlásí se jako 402", async () => {
    const fetchImpl = vi.fn(async () => failure(429, '{"error":{"code":"insufficient_quota"}}'));
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.failures.map((f) => f.message)).toEqual([
      "OpenAI: došel kredit.",
      "OpenAI (záložní model): došel kredit.",
    ]);
    expect(failureStatus(result.failures)).toBe(402);
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
