export interface SensitiveFieldState {
  sensitiveField: boolean;
  associated: string[];
  accessible: string[];
}

/**
 * Classifies a page node as a secret-bearing field (password, one-time code,
 * payment card, bank account) and returns its associated and accessible labels.
 *
 * Self-contained so it can run in either page route: serialized with
 * `toString()` into a debugger `Runtime.callFunctionOn` declaration, or bundled
 * into the scripting page agent. It must not reference module scope.
 */
export function sensitiveFieldState(this: Element): SensitiveFieldState {
  // Form controls and HTML elements carry these; other elements leave them undefined.
  const control = this as Partial<HTMLInputElement>;
  // Debugger refs can name text nodes, which have no attributes.
  const attr = (name: string): string | null =>
    typeof this.getAttribute === "function" ? this.getAttribute(name) : null;
  const type = String(attr("type") || "").toLowerCase();
  const autocomplete = String(attr("autocomplete") || "").toLowerCase().split(/\s+/);
  const text = (node: Node | null): string =>
    String(node && (((node as Partial<HTMLElement>).innerText ?? node.textContent) ?? "") || "").trim();
  const ids = String(attr("aria-labelledby") || "") + " " + String(attr("aria-describedby") || "");
  const associated: string[] = (control.labels ? Array.from(control.labels) : []).map(text).filter(Boolean);
  const root = this.ownerDocument || document;
  const accessible = [
    attr("aria-label"),
    ...ids.trim().split(/\s+/).filter(Boolean).map((id) => text(root.getElementById(id))),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const role = String(attr("role") || "").toLowerCase();
  const rawDescriptor = [
    attr("name"),
    this.id,
    attr("aria-label"),
    attr("title"),
    attr("placeholder"),
    ...associated,
    ...accessible,
  ].filter(Boolean).join(" ");
  const descriptor = rawDescriptor.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const compactDescriptor = descriptor.replace(/\s+/g, "");
  // Bare tokens without trailing digits, so "cid2" still reads as "cid".
  const tokens = descriptor.split(" ").map((token) => token.replace(/\d+$/, ""));
  const tag = String(this.tagName || "").toUpperCase();
  const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || control.isContentEditable === true ||
    role === "textbox" || role === "combobox" || role === "spinbutton";
  // Long terms are unambiguous, so they match inside joined names ("password2", "captchacode"). Short terms
  // occur inside ordinary words ("residual" contains "cid"), so they must be a whole token.
  const namedSecret =
    /\b(password|otp|totp|mfa(?: code|token)?|2fa(?: code)?|(?:two|multi) factor (?:authentication )?(?:code|token)|one time (?:code|password)|verification code|authentication code|auth code|(?:re ?|h ?)?captcha|(?:cvv|cvc|cvn)\d*|cid|security code|card security code|card verification (?:value|code|number)|card number|credit card number|cc number|card (?:expiration|expiry) (?:date|month|year)|bank account number|routing number|iban)\b/
      .test(descriptor) ||
    [
      "password", "onetimecode", "onetimepassword", "verificationcode", "authenticationcode", "authcode",
      "2facode", "twofactorcode", "twofactortoken", "twofactorauthenticationcode", "multifactorcode",
      "multifactortoken", "multifactorauthenticationcode", "captcha", "securitycode",
      "cardverificationvalue", "cardverificationcode", "cardverificationnumber", "cardnumber", "creditcardnumber",
      "ccnumber", "cardsecuritycode", "cardexpirationdate", "cardexpirationmonth", "cardexpirationyear",
      "cardexpirydate", "cardexpirymonth", "cardexpiryyear", "bankaccountnumber", "routingnumber",
    ].some((term) => compactDescriptor.includes(term)) ||
    ["cid", "2fa", "totp"].some((term) => tokens.includes(term));
  const tokenSecret = /\b(pin|passcode)\b/.test(descriptor);
  // `autocomplete="new-password"` is not a signal on its own: sites put it on ordinary text inputs to stop
  // browser autofill. A real new-password field is still caught by `type="password"` or its name.
  const sensitiveField = type === "password" ||
    autocomplete.some((token) =>
      token === "current-password" || token === "one-time-code" ||
      token === "webauthn" || token.startsWith("cc-")) ||
    (editable && (namedSecret || tokenSecret));
  return { sensitiveField, associated, accessible };
}
