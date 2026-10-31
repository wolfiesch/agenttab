/**
 * Minimal synthetic DOM for the email code page function. It models only what
 * `fillEmailCodeInPage` and `sensitiveFieldState` read: attributes, labels,
 * visibility, document order, the prototype value setter, and events.
 */

export const ATLASSIAN = {
  origin: "https://id.atlassian.com",
  path: "/signup/verify-email/otp",
  recipient: "agent@example.com",
} as const;

export const ATLASSIAN_TEXT =
  "Check your inbox to log in. We've emailed a 6-character code to agent@example.com. " +
  "Enter the code below to verify your email address. Didn't receive an email? Resend email";

interface FakeLocation {
  origin: string;
  pathname: string;
}

export interface FakePageOptions {
  origin?: string;
  path?: string;
  /** Top document location; defaults to this document's. `"blocked"` throws like a cross-origin parent. */
  top?: FakeLocation | "blocked";
  title?: string;
  text?: string;
}

export class FakeDocument {
  readonly location: FakeLocation;
  readonly defaultView: { top: { location: FakeLocation } | null; Event: typeof Event };
  readonly body: { innerText: string };
  readonly inputs: FakeInput[] = [];
  title: string;

  constructor(options: FakePageOptions = {}) {
    this.location = { origin: options.origin ?? ATLASSIAN.origin, pathname: options.path ?? ATLASSIAN.path };
    const top = options.top;
    this.defaultView = {
      top: top === "blocked"
        ? {
          get location(): FakeLocation {
            throw new Error("Blocked a frame from accessing a cross-origin frame");
          },
        }
        : { location: top ?? this.location },
      Event,
    };
    this.title = options.title ?? "Verify your email - Atlassian";
    this.body = { innerText: options.text ?? ATLASSIAN_TEXT };
  }

  input(attributes: Record<string, string>): FakeInput {
    const input = new FakeInput(this, this.inputs.length, attributes);
    this.inputs.push(input);
    return input;
  }

  querySelectorAll(selector: string): FakeInput[] {
    if (selector === "input") return [...this.inputs];
    if (selector === 'input[type="password" i]') {
      return this.inputs.filter((input) => input.getAttribute("type")?.toLowerCase() === "password");
    }
    if (selector === 'input[autocomplete~="webauthn" i]') {
      return this.inputs.filter((input) =>
        String(input.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).includes("webauthn"));
    }
    throw new Error(`FakeDocument does not support selector ${selector}`);
  }

  getElementById(id: string): FakeInput | null {
    return this.inputs.find((input) => input.id === id) ?? null;
  }
}

export class FakeInput extends EventTarget {
  readonly tagName = "INPUT";
  readonly attributes: Map<string, string>;
  readonly events: string[] = [];
  id: string;
  form: object | null = null;
  disabled = false;
  readOnly = false;
  isConnected = true;
  visible = true;
  labels: Array<{ textContent: string }> = [];
  stored = "";
  /** Page-owned setter behavior; defaults to storing the value. */
  pageSetter: (value: string) => string = (value) => value;

  constructor(readonly ownerDocument: FakeDocument, readonly order: number, attributes: Record<string, string>) {
    super();
    this.attributes = new Map(Object.entries(attributes));
    this.id = attributes.id ?? "";
  }

  get value(): string {
    return this.stored;
  }

  set value(value: string) {
    this.stored = this.pageSetter(value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  checkVisibility(): boolean {
    return this.visible;
  }

  getRootNode(): FakeDocument {
    return this.ownerDocument;
  }

  compareDocumentPosition(other: FakeInput): number {
    // DOCUMENT_POSITION_FOLLOWING (4) or DOCUMENT_POSITION_PRECEDING (2).
    return other.order > this.order ? 4 : 2;
  }

  override dispatchEvent(event: Event): boolean {
    this.events.push(event.type);
    return super.dispatchEvent(event);
  }
}

/** Atlassian's split signup code widget: six one-character boxes. */
export function atlassianSplitPage(options: FakePageOptions = {}): { doc: FakeDocument; inputs: FakeInput[] } {
  const doc = new FakeDocument(options);
  const inputs = Array.from({ length: 6 }, (_unused, index) =>
    doc.input({ type: "text", maxlength: "1", "aria-label": `Please enter OTP character ${index + 1}` }));
  return { doc, inputs };
}

/** One `autocomplete="one-time-code"` box taking the whole code. */
export function singleCodePage(options: FakePageOptions = {}): { doc: FakeDocument; input: FakeInput } {
  const doc = new FakeDocument(options);
  const input = doc.input({
    type: "text",
    maxlength: "6",
    autocomplete: "one-time-code",
    name: "verificationCode",
    "aria-label": "Verification code",
  });
  return { doc, input };
}
