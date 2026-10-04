import { describe, expect, test } from "bun:test";
import { describeCallView, describeResultView } from "../src/native";

describe("AgentTab native (Tern) tool views", () => {
  test("typed values and staged tokens never reach the native view", () => {
    const args = {
      tab_id: 12,
      expected_page_revision: 4,
      actions: [
        { kind: "fill", ref: "ref=e5", text: "private@example.com" },
        { kind: "click", ref: "ref=e9" },
      ],
    };
    const call = JSON.stringify(describeCallView("browser_act", args));
    const result = JSON.stringify(describeResultView("browser_act", {
      details: { staged_token: "tok-secret-123", awaiting_human_approval: true, effect: "submit form" },
    }, { expanded: true }, args));
    for (const view of [call, result]) {
      expect(view).not.toContain("private@example.com");
      expect(view).not.toContain("tok-secret-123");
    }
    expect(result).toContain("[redacted]");
  });

  test("approval-gated results carry a warning tone, review badge, and the lifecycle flow", () => {
    const view = describeResultView("browser_act", {
      details: { staged_token: "t", awaiting_human_approval: true, effect: "purchase" },
    }, {}, { tab_id: 3, actions: [{ kind: "click", ref: "ref=e2" }] });
    expect(view.tone).toBe("warning");
    expect(view.tool?.title).toBe("Click");
    expect(view.tool?.badges?.map((badge) => badge.text)).toEqual(["review"]);
    expect(view.tool?.meta).toContain("Approval required for purchase");
    expect(view.body?.some((node) => node.key === "flow")).toBe(true);
  });

  test("routine observations stay quiet: no flow, details folded until expanded", () => {
    const result = { details: { tabs: [{ tab_id: 5 }], tabs_count: 1, _agenttab: { outcome: "completed" } } };
    const collapsed = describeResultView("browser_tabs", result, {}, {});
    expect(collapsed.tone).toBeUndefined();
    expect(collapsed.tool?.badges).toBeUndefined();
    expect(collapsed.body?.some((node) => node.key === "flow")).toBe(false);
    expect(collapsed.body?.find((node) => node.key === "details")?.p?.collapsed).toBe(true);
    const expanded = describeResultView("browser_tabs", result, { expanded: true }, {});
    expect(expanded.body?.find((node) => node.key === "details")?.p?.collapsed).toBe(false);
  });
});
