/**
 * Page side of the brokered email verification code fill. The host resolves the
 * code from an approved message and the extension routes it here through either
 * the debugger (`Runtime.callFunctionOn`) or the scripting page agent.
 *
 * Every target and the surrounding document are checked once before any value
 * is written. Page listeners run inside each write, so the top location, the
 * frame origin, and every target are checked again before each character and
 * after the last; a failed check or a write the page does not accept stops the
 * fill and takes back every character already written.
 *
 * The page must name the expected recipient in full, or by exactly one bounded
 * ASCII `*` mask that fits it and that no other shown address also fits.
 *
 * Results carry fixed refusal reasons only. Nothing here reports a value, a
 * label, page text, or a page exception message.
 *
 * Self-contained so it can run in either page route: serialized with
 * `toString()` into a debugger declaration, or bundled into the page agent. It
 * must not reference module scope.
 */

export interface EmailCodePageExpectation {
  /** Host-derived origin the target document and the top document must have. */
  origin: string;
  /** Host-derived exact pathname of the top document. */
  path: string;
  /** Mailbox address the page must name as the code's destination. */
  recipient: string;
}

export type EmailCodePageRefusal =
  | "target_invalid"
  | "sensitive_target"
  | "otp_mismatch"
  | "url_mismatch"
  | "cross_origin_frame"
  | "password_present"
  | "context_unverified"
  | "recipient_unverified"
  | "mfa_context"
  | "human_challenge"
  | "write_failed";

export interface EmailCodePageResult {
  agenttab_email_code:
    | { ok: true; filled: number }
    | { ok: false; reason: EmailCodePageRefusal; wrote: boolean };
}

/** Label source shared with the sensitive-field guard (`sensitiveFieldState`). */
export type EmailCodeLabelSource = (this: Element) => { associated: string[]; accessible: string[] };

export function fillEmailCodeInPage(
  elements: unknown[],
  values: unknown[],
  expectation: EmailCodePageExpectation,
  labelsOf: EmailCodeLabelSource,
): EmailCodePageResult {
  const refuse = (reason: EmailCodePageRefusal, wrote = false): EmailCodePageResult => ({
    agenttab_email_code: { ok: false, reason, wrote },
  });
  try {
    if (
      !Array.isArray(elements) || !Array.isArray(values) || elements.length === 0 || elements.length > 12 ||
      elements.length !== values.length || typeof expectation !== "object" || expectation === null ||
      typeof expectation.origin !== "string" || typeof expectation.path !== "string" ||
      typeof expectation.recipient !== "string" || expectation.recipient.length < 3 ||
      expectation.recipient.length > 320
    ) {
      return refuse("target_invalid");
    }
    const split = elements.length > 1;
    const texts = values.map((value) => (typeof value === "string" ? value : ""));
    if (
      split
        ? elements.length < 4 || texts.some((text) => !/^[A-Za-z0-9]$/.test(text))
        : !/^[A-Za-z0-9]{4,12}$/.test(texts[0])
    ) {
      return refuse("otp_mismatch");
    }
    const inputs = elements as HTMLInputElement[];
    if (new Set(inputs).size !== inputs.length) return refuse("target_invalid");
    const first = inputs[0];
    const doc = first && typeof first === "object" ? first.ownerDocument : null;
    if (!doc) return refuse("target_invalid");

    // The top document must be the approved page; the target document must share its origin.
    const locationRefusal = (): EmailCodePageRefusal | null => {
      let topOrigin: string;
      let topPath: string;
      let frameOrigin: string;
      try {
        const view = doc.defaultView;
        if (!view || !view.top) return "cross_origin_frame";
        topOrigin = String(view.top.location.origin);
        topPath = String(view.top.location.pathname);
        frameOrigin = String(doc.location.origin);
      } catch {
        return "cross_origin_frame";
      }
      if (topOrigin !== expectation.origin || topPath !== expectation.path) return "url_mismatch";
      return frameOrigin === expectation.origin ? null : "cross_origin_frame";
    };
    const preflightLocation = locationRefusal();
    if (preflightLocation !== null) return refuse(preflightLocation);

    const rendered = (node: Element): boolean =>
      typeof node.checkVisibility === "function"
        ? node.checkVisibility({ checkVisibilityCSS: true })
        : typeof node.getClientRects === "function" && node.getClientRects().length > 0;
    const setterOf = (node: object): ((this: unknown, value: string) => void) | undefined => {
      // Skips own-instance overrides, as frameworks track values there and must observe the change.
      for (let proto = Object.getPrototypeOf(node); proto; proto = Object.getPrototypeOf(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor && typeof descriptor.set === "function") return descriptor.set;
      }
      return undefined;
    };

    const form = first.form ?? null;
    const setters: Array<(this: unknown, value: string) => void> = [];
    let firstType = "";
    let firstMaxLength: string | null = null;
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      if (
        !input || typeof input !== "object" || String(input.tagName || "").toUpperCase() !== "INPUT" ||
        input.ownerDocument !== doc || (input.form ?? null) !== form || input.isConnected === false
      ) {
        return refuse("target_invalid");
      }
      const attr = (name: string): string => String(input.getAttribute(name) || "").toLowerCase();
      const type = attr("type") || "text";
      if (type === "password") return refuse("sensitive_target");
      if (type !== "text" && type !== "tel" && type !== "number") return refuse("target_invalid");
      if (input.disabled === true || input.readOnly === true || attr("aria-disabled") === "true" || !rendered(input)) {
        return refuse("target_invalid");
      }
      const autocomplete = attr("autocomplete").split(/\s+/).filter(Boolean);
      if (autocomplete.includes("webauthn")) return refuse("mfa_context");
      if (
        autocomplete.some((token) =>
          token === "current-password" || token === "new-password" || token === "username" ||
          token === "email" || token.startsWith("cc-"))
      ) {
        return refuse("sensitive_target");
      }
      const { associated, accessible } = labelsOf.call(input);
      const descriptor = [
        input.getAttribute("name"),
        input.id,
        input.getAttribute("aria-label"),
        input.getAttribute("title"),
        input.getAttribute("placeholder"),
        ...associated,
        ...accessible,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      const compact = descriptor.replace(/\s+/g, "");
      if (
        /\b(password|passphrase|passcode|pin|user ?name|login id|card|cvv|cvc|cvn|iban|routing|bank|account number|expir\w*|ssn|social security)\b/
          .test(descriptor) ||
        /password|username|cardnumber|creditcard|securitycode/.test(compact)
      ) {
        return refuse("sensitive_target");
      }
      if (
        /\b(totp|authenticator|2fa|mfa|two ?factor|multi ?factor|2 ?step|two ?step|backup|recovery|sms|phone|passkeys?|security keys?)\b/
          .test(descriptor)
      ) {
        return refuse("mfa_context");
      }
      const codeField = autocomplete.includes("one-time-code") ||
        /\b(otp|code|one ?time|verification|verify|digit|character|char)\b/.test(descriptor) ||
        /onetimecode|verificationcode|otp/.test(compact);
      if (!codeField) return refuse("otp_mismatch");
      const maxLength = input.getAttribute("maxlength");
      if (maxLength !== null) {
        const limit = Number(maxLength);
        if (!Number.isInteger(limit) || limit < texts[index].length) return refuse("otp_mismatch");
      }
      const inputMode = attr("inputmode");
      if (
        (type === "number" || type === "tel" || inputMode === "numeric" || inputMode === "decimal" || inputMode === "tel") &&
        !/^[0-9]+$/.test(texts[index])
      ) {
        return refuse("otp_mismatch");
      }
      if (index === 0) {
        firstType = type;
        firstMaxLength = maxLength;
      } else {
        // Split boxes are one widget: same kind of input, in code-character order.
        if (type !== firstType || maxLength !== firstMaxLength) return refuse("otp_mismatch");
        const previous = inputs[index - 1];
        if (
          typeof previous.compareDocumentPosition === "function" &&
          typeof previous.getRootNode === "function" && previous.getRootNode() === input.getRootNode() &&
          (previous.compareDocumentPosition(input) & 4) === 0
        ) {
          return refuse("otp_mismatch");
        }
      }
      const setter = setterOf(input);
      if (!setter) return refuse("target_invalid");
      setters.push(setter);
    }

    // The form, or the document when the code boxes have none, must not also collect a password.
    const scope: ParentNode = form ?? doc;
    if (Array.from(scope.querySelectorAll('input[type="password" i]')).some(rendered)) {
      return refuse("password_present");
    }
    if (Array.from(doc.querySelectorAll('input[autocomplete~="webauthn" i]')).some(rendered)) {
      return refuse("mfa_context");
    }

    const body = doc.body;
    const bodyText = body ? String(body.innerText ?? body.textContent ?? "") : "";
    const corpus = `${String(doc.title || "")}\n${bodyText}`
      .slice(0, 200_000)
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (
      /\b(two[- ]?factor|2fa|mfa|multi[- ]?factor|2[- ]?step|two[- ]step|authenticator|authentication app|totp|passkeys?|security keys?|webauthn|backup codes?|recovery codes?|hardware key|yubikey|text message|sms)\b/
        .test(corpus)
    ) {
      return refuse("mfa_context");
    }
    // reCAPTCHA's required disclosure is not a challenge; the challenge guard watches its widget.
    const humanCorpus = corpus.replace(/this (?:site|page|form) is protected by recaptcha[^.]*\.?/g, " ");
    if (
      /\b(captcha|recaptcha|hcaptcha|not a robot|are you (?:a )?human|verify (?:that )?you(?:'re| are) (?:a )?human|prove you(?:'re| are) (?:a )?human|human verification)\b/
        .test(humanCorpus)
    ) {
      return refuse("human_challenge");
    }
    if (!/\b(e-?mail(?:ed)?|inbox)\b/.test(corpus) || !/\b(code|otp|one[- ]time|verification|verify)\b/.test(corpus)) {
      return refuse("context_unverified");
    }

    const recipient = expectation.recipient.toLowerCase();
    const namesRecipient = (text: string): boolean => {
      for (let from = 0; ;) {
        const at = text.indexOf(recipient, from);
        if (at < 0) return false;
        const before = at > 0 ? text.charAt(at - 1) : "";
        const after = text.charAt(at + recipient.length);
        const following = text.charAt(at + recipient.length + 1);
        if (
          !/[a-z0-9._%+\-]/.test(before) &&
          !/[a-z0-9\-]/.test(after) &&
          !(after === "." && /[a-z0-9]/.test(following))
        ) {
          return true;
        }
        from = at + 1;
      }
    };
    const displayed = Array.from(doc.querySelectorAll("input"))
      .slice(0, 64)
      .filter((node) => {
        const type = String(node.getAttribute("type") || "text").toLowerCase();
        return type === "email" || ((type === "text" || type === "hidden") && (node.readOnly === true || node.disabled === true));
      })
      .map((node) => String(node.value || "").toLowerCase());
    // A masked recipient (`a***t@e***m`) counts as evidence only when every ASCII `*` mask
    // on the page is the same bounded mask, it fits the expected recipient, and no full
    // address it could also stand for is shown. Tokens are cut around each `@` with
    // bounded scans and matched without regular expressions built from page text.
    const recipientAt = recipient.lastIndexOf("@");
    const recipientLocal = recipient.slice(0, recipientAt);
    const recipientDomain = recipient.slice(recipientAt + 1);
    const tokensOf = (text: string): string[] | null => {
      const found: string[] = [];
      let scanned = 0;
      for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
        scanned += 1;
        if (found.length >= 64 || scanned > 1_024) return null;
        let start = at;
        while (start > 0 && at - start <= 64 && /^[a-z0-9._%+\-*]$/.test(text.charAt(start - 1))) start -= 1;
        let end = at + 1;
        while (end < text.length && end - at - 1 <= 255 && /^[a-z0-9.\-*]$/.test(text.charAt(end))) end += 1;
        while (end > at + 1 && text.charAt(end - 1) === ".") end -= 1;
        if (start < at && end > at + 1) found.push(text.slice(start, end));
      }
      return found;
    };
    // Each run of `*` hides one or more characters; literal segments match in order.
    const globMatch = (pattern: string, text: string): boolean => {
      const parts = pattern.split(/\*+/);
      if (parts.length === 1) return pattern === text;
      const head = parts[0];
      const tail = parts[parts.length - 1];
      if (!text.startsWith(head)) return false;
      let position = head.length;
      for (let index = 1; index < parts.length - 1; index += 1) {
        const found = text.indexOf(parts[index], position + 1);
        if (found < 0) return false;
        position = found + parts[index].length;
      }
      return text.length - tail.length >= position + 1 && text.endsWith(tail);
    };
    const maskFits = (mask: string, address: string): boolean => {
      const maskAt = mask.indexOf("@");
      const addressAt = address.lastIndexOf("@");
      return globMatch(mask.slice(0, maskAt), address.slice(0, addressAt)) &&
        globMatch(mask.slice(maskAt + 1), address.slice(addressAt + 1));
    };
    const maskEvidence = (): boolean => {
      const masks = new Set<string>();
      const addresses = new Set<string>();
      for (const source of [corpus, ...displayed]) {
        const tokens = tokensOf(source);
        if (tokens === null) return false;
        for (const token of tokens) {
          if (!token.includes("*")) {
            addresses.add(token);
            continue;
          }
          const at = token.indexOf("@");
          const local = token.slice(0, at);
          const domain = token.slice(at + 1);
          if (
            local.length > 64 || domain.length > 255 ||
            !/[a-z0-9]/.test(local) || !/[a-z0-9]/.test(domain) ||
            !globMatch(local, recipientLocal) || !globMatch(domain, recipientDomain)
          ) {
            return false;
          }
          masks.add(token);
        }
      }
      if (masks.size !== 1) return false;
      const [mask] = Array.from(masks);
      for (const address of addresses) {
        if (address !== recipient && maskFits(mask, address)) return false;
      }
      return true;
    };
    if (!namesRecipient(corpus) && !displayed.some(namesRecipient) && !maskEvidence()) {
      return refuse("recipient_unverified");
    }

    // The target document's own constructor, so main-world and isolated-world listeners both see a native event.
    const viewEvent: unknown = doc.defaultView ? Reflect.get(doc.defaultView, "Event") : undefined;
    const EventType: typeof Event = typeof viewEvent === "function" ? viewEvent as typeof Event : Event;
    const notify = (input: HTMLInputElement, type: string): void => {
      input.dispatchEvent(new EventType(type, { bubbles: true, composed: true }));
    };
    // Page listeners run synchronously inside every write and can navigate the history,
    // retype, move, or disable a box, so the location and every target are checked again
    // before each character and after the last one.
    const targetIntact = (input: HTMLInputElement): boolean =>
      String(input.tagName || "").toUpperCase() === "INPUT" && input.ownerDocument === doc &&
      input.isConnected !== false && (input.form ?? null) === form &&
      String(input.getAttribute("type") || "text").toLowerCase() === firstType &&
      input.disabled !== true && input.readOnly !== true;
    const writeRefusal = (): EmailCodePageRefusal | null =>
      locationRefusal() ?? (inputs.every(targetIntact) ? null : "target_invalid");
    const previousValues = inputs.map((input) => String(input.value ?? ""));
    let written = 0;
    let failure: EmailCodePageRefusal | null = null;
    try {
      for (let index = 0; index < inputs.length; index += 1) {
        failure = writeRefusal();
        if (failure !== null) break;
        const input = inputs[index];
        written = index + 1;
        setters[index].call(input, texts[index]);
        notify(input, "input");
        notify(input, "change");
      }
      if (failure === null) failure = writeRefusal();
      if (
        failure === null &&
        !inputs.every((input, index) => String(input.value ?? "").toLowerCase() === texts[index].toLowerCase())
      ) {
        failure = "write_failed";
      }
    } catch {
      failure = "write_failed";
    }
    if (failure === null) return { agenttab_email_code: { ok: true, filled: inputs.length } };
    // Takes the partial code back out of the page, even one that moved away from the approved path.
    for (let index = written - 1; index >= 0; index -= 1) {
      try {
        setters[index].call(inputs[index], previousValues[index]);
        notify(inputs[index], "input");
        notify(inputs[index], "change");
      } catch {
        // Best effort: the page refused the restore as well.
      }
    }
    return refuse(failure, written > 0);
  } catch {
    return refuse("target_invalid");
  }
}
