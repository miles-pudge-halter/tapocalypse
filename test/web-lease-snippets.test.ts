import { describe, expect, test } from "bun:test";
import { LEASE_PROMPT } from "../web/lib/lease-snippets";

describe("lease prompt", () => {
  test("the Setup page prompt is exactly the snippet agents are told to add in docs/agent-setup.md step 8", async () => {
    const doc = await Bun.file(new URL("../docs/agent-setup.md", import.meta.url)).text();
    const step = doc.slice(doc.indexOf("## 8. Let your agents borrow devices"));
    const snippet = /```md\n([\s\S]*?)\n```/.exec(step)?.[1] ?? "";
    expect(snippet).not.toBe("");
    expect(LEASE_PROMPT).toBe(snippet);
  });
});
