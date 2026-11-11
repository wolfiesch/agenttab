import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readSecretSource } from "../src/secret-read";

/** Minimal element classes: only what `readSecretSource` reads. */
type Location = { origin: string };
type Doc = { location: Location; defaultView: { top: { location: Location } } };

const sameOrigin = (): Doc => {
  const location = { origin: "https://console.example" };
  return { location, defaultView: { top: { location } } };
};

class FakeElement {
  ownerDocument: Doc = sameOrigin();
  innerText = "";
  attributes: Record<string, string> = {};
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}
class FakeInput extends FakeElement {
  type = "text";
  value = "";
  readOnly = false;
  disabled = false;
}
class FakeTextarea extends FakeElement {
  value = "";
}
class FakeSelect extends FakeElement {}

const GLOBALS = ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"] as const;
const saved = new Map<string, unknown>();

beforeAll(() => {
  const fakes = [FakeElement, FakeInput, FakeTextarea, FakeSelect];
  GLOBALS.forEach((name, index) => {
    saved.set(name, Reflect.get(globalThis, name));
    Reflect.set(globalThis, name, fakes[index]);
  });
});

afterAll(() => {
  for (const name of GLOBALS) Reflect.set(globalThis, name, saved.get(name));
});

const read = (element: FakeElement): unknown => readSecretSource.call(element as unknown as Element);

describe("readSecretSource", () => {
  test("reads displayed text and read-only key fields, trimmed", () => {
    const code = new FakeElement();
    code.innerText = "\n  tok-live-0123456789abcdef  \n";
    expect(read(code)).toEqual({ value: "tok-live-0123456789abcdef" });

    const masked = new FakeInput();
    masked.type = "password";
    masked.readOnly = true;
    masked.value = "tok-live-0123456789abcdef";
    expect(read(masked)).toEqual({ value: "tok-live-0123456789abcdef" });

    const textarea = new FakeTextarea();
    textarea.value = " token-0123456789abcdef ";
    expect(read(textarea)).toEqual({ value: "token-0123456789abcdef" });
  });

  test("refuses account password fields", () => {
    const editable = new FakeInput();
    editable.type = "password";
    editable.value = "hunter2-account-password";
    expect(read(editable)).toEqual({ agenttab_secret_error: "secret_capture_source_forbidden" });

    const autocomplete = new FakeInput();
    autocomplete.readOnly = true;
    autocomplete.attributes.autocomplete = "current-password";
    expect(read(autocomplete)).toEqual({ agenttab_secret_error: "secret_capture_source_forbidden" });
  });

  test("refuses cross-origin frames and controls without a single displayed value", () => {
    const framed = new FakeElement();
    framed.innerText = "tok-live-0123456789abcdef";
    framed.ownerDocument = {
      location: { origin: "https://widget.example" },
      defaultView: { top: { location: { origin: "https://console.example" } } },
    };
    expect(read(framed)).toEqual({ agenttab_secret_error: "cross_origin_credentials_forbidden" });

    const blocked = new FakeElement();
    blocked.ownerDocument = {
      location: { origin: "https://console.example" },
      defaultView: {
        get top(): { location: Location } {
          throw new Error("SecurityError");
        },
      },
    };
    expect(read(blocked)).toEqual({ agenttab_secret_error: "cross_origin_credentials_forbidden" });

    expect(read(new FakeSelect())).toEqual({ agenttab_secret_error: "secret_capture_source_invalid" });
  });
});
