import assert from "node:assert/strict";
import test from "node:test";
import { platformAnswerModel, recentlyRefused, rememberRefusedModel } from "./llm";

test("a model the Gateway refused is skipped for ten minutes, then tried again", () => {
  const saved = { model: process.env.LLM_MODEL, fallback: process.env.LLM_FALLBACK_MODEL };
  process.env.LLM_MODEL = "openai/test-refused-model";
  delete process.env.LLM_FALLBACK_MODEL;
  try {
    const t0 = 1_000_000;
    assert.equal(platformAnswerModel(t0), "openai/test-refused-model");
    // Refused once: every turn after starts on the fallback, without the wasted round trip.
    rememberRefusedModel("openai/test-refused-model", t0);
    assert.equal(recentlyRefused("openai/test-refused-model", t0 + 60_000), true);
    assert.equal(platformAnswerModel(t0 + 60_000), "openai/gpt-4.1-mini");
    // Forgotten after ten minutes, so adding Gateway credit needs no deploy.
    assert.equal(platformAnswerModel(t0 + 10 * 60_000 + 1), "openai/test-refused-model");
    assert.equal(recentlyRefused("openai/test-refused-model", t0 + 10 * 60_000 + 1), false);
  } finally {
    if (saved.model === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = saved.model;
    if (saved.fallback !== undefined) process.env.LLM_FALLBACK_MODEL = saved.fallback;
  }
});
