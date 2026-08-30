import { describe, expect, test } from "bun:test";
import {
  createCallComponent,
  createResultComponent,
  type RenderTheme,
} from "../src/render";

const theme: RenderTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

describe("AgentTab operation card rendering", () => {
  test("collapsed action cards show lifecycle, ownership, and hidden-input notice", () => {
    const component = createCallComponent("browser_act", {
      tab_id: 12,
      expected_page_revision: 4,
      actions: [{ kind: "fill", ref: "ref=e5", text: "private@example.com" }],
    }, theme);
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Plan · Fill · e5 · 19 characters · tab 12 · rev 4 · task-owned");
    expect(rendered).toContain("▶ Intent  · Decision  · Execute  · Observe");
    expect(rendered).toContain("Privacy · 1 sensitive input hidden");
    expect(rendered).not.toContain("private@example.com");
  });

  test("compact wait cards identify condition, target, tab, and ownership", () => {
    const component = createCallComponent("browser_wait", {
      tab_id: 7,
      condition: { kind: "text", value: "Publish app" },
    }, theme);
    expect(component.render(120)).toEqual([
      "Plan · Wait for Text · “Publish app” · tab 7 · task-owned",
      "  Flow · ▶ Intent  · Decision  · Execute  · Observe",
    ]);
  });

  test("staged action results surface approval and redact sensitive fields", () => {
    const component = createResultComponent(
      "browser_act",
      {
        details: {
          staged_token: "never-display-this-token",
          nested: { cookie: "never-display-this-cookie", page_revision: 8 },
          _agenttab: { outcome: "committed", task_id: "task-operation-123456" },
        },
      },
      { expanded: true },
      theme,
      { tab_id: 12, actions: [{ kind: "click", ref: "ref=e5" }] },
    );
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain(
      "Review · Human approval required · task task-ope…3456 · tab 12 · task-owned",
    );
    expect(rendered).toContain("▶ Approval  · Execute  · Observe");
    expect(rendered).toContain("Policy · Consequential action paused before execution");
    expect(rendered).toContain('"staged_token": "[redacted]"');
    expect(rendered).toContain('"cookie": "[redacted]"');
    expect(rendered).toContain('"page_revision": 8');
    expect(rendered).not.toContain("never-display");
  });

  test("completed actions distinguish execution from observed browser effects", () => {
    const component = createResultComponent(
      "browser_act",
      {
        details: {
          page_revision: 5,
          opened_tabs: [{ tab_id: 21 }],
          dialog: { status: "opened", type: "confirm" },
          _agenttab: { outcome: "committed", task_id: "task-7" },
        },
      },
      { expanded: true },
      theme,
      {
        tab_id: 18,
        actions: [{ kind: "click", ref: "ref=e3" }, { kind: "click", ref: "ref=e4" }],
      },
    );
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain(
      "Executed · 2 browser actions executed · task task-7 · tab 18 · rev 5 · task-owned",
    );
    expect(rendered).toContain("✓ Execute  ▶ Observe");
    expect(rendered).toContain("Evidence · 1 new tab");
    expect(rendered).toContain("Dialog · Confirm opened");
  });

  test("tab results summarize task lineage without dumping JSON", () => {
    const component = createResultComponent(
      "browser_tabs",
      {
        details: {
          tabs: [
            { tab_id: 1, task_id: "task-7" },
            { tab_id: 2, task_id: "task-7" },
          ],
        },
      },
      { expanded: false },
      theme,
      {},
    );
    expect(component.render(120)).toEqual([
      "Observed · 2 task tabs · task task-7 · task-owned",
    ]);
  });

  test("blocked results retain policy recovery without claiming execution", () => {
    const component = createResultComponent(
      "browser_act",
      {
        isError: true,
        details: {
          code: "page_revision_mismatch",
          outcome: "blocked",
          recovery: { instruction: "Observe the page again." },
        },
      },
      { expanded: true },
      theme,
      { tab_id: 18, expected_page_revision: 4, actions: [{ kind: "click", ref: "ref=e3" }] },
    );
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Blocked · Page revision mismatch · tab 18 · rev 4 · task-owned");
    expect(rendered).toContain("× Operation");
    expect(rendered).toContain("Observe the page again.");
    expect(rendered).not.toContain("Executed ·");
  });

  test("unknown failures warn that execution may have occurred", () => {
    const component = createResultComponent(
      "browser_act",
      {
        content: [{ type: "text", text: "Connection closed after dispatch" }],
        isError: true,
        details: {
          code: "transport_closed",
          outcome: "unknown",
        },
      },
      { expanded: false },
      theme,
      { tab_id: 18, expected_page_revision: 4, actions: [{ kind: "click", ref: "ref=e3" }] },
    );
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Uncertain · Connection closed after dispatch · tab 18 · rev 4 · task-owned");
    expect(rendered).toContain("✓ Intent  ? Execute  ▶ Reconcile");
    expect(rendered).toContain("Execution may have occurred; inspect live state before retrying");
    expect(rendered).not.toContain("Blocked ·");
  });

  test("handoff cards distinguish waiting from completed user work", () => {
    const args = {
      tab_id: 18,
      expected_page_revision: 5,
      prompt: "Complete passkey verification",
      completion: { kind: "manual_done" },
    };
    const waiting = createResultComponent(
      "browser_handoff",
      { details: {} },
      { expanded: true, isPartial: true },
      theme,
      args,
    );
    expect(waiting.render(120)).toEqual([
      "Your turn · Waiting for user · tab 18 · rev 5 · task-owned",
      "  Flow · ✓ Intent  ▶ Human  · Resume",
    ]);
    const activated = createResultComponent(
      "browser_handoff",
      {
        details: {
          tab_id: 18,
          page_revision: 6,
          _agenttab: { outcome: "needs_user", task_id: "task-7" },
        },
      },
      { expanded: false },
      theme,
      args,
    );
    expect(activated.render(120)).toEqual([
      "Your turn · Waiting for user · task task-7 · tab 18 · rev 6 · task-owned",
      "  Flow · ✓ Intent  ▶ Human  · Resume",
    ]);


    const completed = createResultComponent(
      "browser_handoff",
      { details: { tab_id: 18, page_revision: 6 } },
      { expanded: false },
      theme,
      args,
    );
    expect(completed.render(120)).toEqual([
      "Observed · User handoff completed · tab 18 · rev 6 · task-owned",
    ]);
  });

  test("partial results stay compact even when expanded", () => {
    const component = createResultComponent(
      "browser_snapshot",
      { details: { authorization: "hidden", nodes: Array.from({ length: 300 }, (_, index) => ({ index })) } },
      { expanded: true, isPartial: true },
      theme,
      { mode: "accessibility" },
    );
    expect(component.render(120)).toEqual(["Working · Working… · task-owned"]);
  });
});
