import { describe, expect, test } from "bun:test";
import { parsePersona } from "../src/runs/prompt";

describe("parsePersona", () => {
  test("splits a trailing thinking level off the model", () => {
    const p = parsePersona("---\nname: x\nmodel: anthropic/claude-opus-5-5:high\n---\nBody text\n");
    expect(p.model).toBe("anthropic/claude-opus-5-5");
    expect(p.thinking).toBe("high");
  });

  test("a model without a thinking level keeps thinking null", () => {
    const p = parsePersona("---\nmodel: anthropic/claude-haiku-4-5\n---\nBody\n");
    expect(p.model).toBe("anthropic/claude-haiku-4-5");
    expect(p.thinking).toBeNull();
  });

  test("a non-level colon suffix stays part of the model", () => {
    const p = parsePersona("---\nmodel: local/llama:8b\n---\nBody\n");
    expect(p.model).toBe("local/llama:8b");
    expect(p.thinking).toBeNull();
  });

  test("body excludes the frontmatter", () => {
    const p = parsePersona("---\nmodel: a/b\n---\nLine one\nLine two\n");
    expect(p.body).toBe("Line one\nLine two\n");
  });

  test("frontmatter without model: leaves model null and keeps the body", () => {
    const p = parsePersona("---\nname: x\n---\nBody\n");
    expect(p.model).toBeNull();
    expect(p.thinking).toBeNull();
    expect(p.body).toBe("Body\n");
  });

  test("no frontmatter: whole text is the body, model null", () => {
    const p = parsePersona("Just a body\n");
    expect(p).toEqual({ body: "Just a body\n", model: null, thinking: null });
  });
});
