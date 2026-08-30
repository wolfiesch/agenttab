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

describe("AgentTab tool rendering", () => {
  test("compact action cards show intent and hide typed values", () => {
    const component = createCallComponent("browser_act", {
      tab_id: 12,
      expected_page_revision: 4,
      actions: [{ kind: "fill", ref: "ref=e5", text: "private@example.com" }],
    }, theme);
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Fill · e5 · 19 characters · tab 12");
    expect(rendered).not.toContain("private@example.com");
  });

  test("compact wait cards identify condition, target, and tab", () => {
    const component = createCallComponent("browser_wait", {
      tab_id: 7,
      condition: { kind: "text", value: "Publish app" },
    }, theme);
    expect(component.render(120)).toEqual(["Wait for Text · “Publish app” · tab 7"]);
  });

  test("expanded results redact sensitive fields", () => {
    const component = createResultComponent(
      "browser_commit",
      {
        details: {
          outcome: "committed",
          staged_token: "never-display-this-token",
          nested: { cookie: "never-display-this-cookie", page_revision: 8 },
        },
      },
      { expanded: true },
      theme,
      {},
    );
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Committed");
    expect(rendered).toContain('"staged_token": "[redacted]"');
    expect(rendered).toContain('"cookie": "[redacted]"');
    expect(rendered).toContain('"page_revision": 8');
    expect(rendered).not.toContain("never-display");
  });

  test("tab results summarize task-owned tabs without dumping JSON", () => {
    const component = createResultComponent(
      "browser_tabs",
      { details: { tabs: [{ tab_id: 1 }, { tab_id: 2 }] } },
      { expanded: false },
      theme,
      {},
    );
    expect(component.render(120)).toEqual(["2 task tabs"]);
  });

  test("partial results stay compact even when expanded", () => {
    const component = createResultComponent(
      "browser_snapshot",
      { details: { authorization: "hidden", nodes: Array.from({ length: 300 }, (_, index) => ({ index })) } },
      { expanded: true, isPartial: true },
      theme,
      { mode: "accessibility" },
    );
    expect(component.render(120)).toEqual(["Working…"]);
  });
});
