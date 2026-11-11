/** Result of reading one element's displayed secret: the value or a fixed refusal code. */
export type SecretReadResult = { value: string } | { agenttab_secret_error: string };

/**
 * Reads the secret an element displays: an input or textarea value, or the
 * element's rendered text. Runs as `this` on the debugger route through
 * `toString()`, and in the page agent, so it must not reference module scope.
 * Refuses frames that are not same-origin with the top frame, and editable
 * password fields, which hold the account's own password rather than a
 * displayed key.
 */
export function readSecretSource(this: Element): SecretReadResult {
  let sameOrigin = false;
  try {
    const doc = this.ownerDocument;
    sameOrigin = doc.defaultView?.top?.location.origin === doc.location.origin;
  } catch {
    // A cross-origin or sandboxed parent is not authorized for capture.
  }
  if (!sameOrigin) return { agenttab_secret_error: "cross_origin_credentials_forbidden" };
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    const autocomplete = (this.getAttribute("autocomplete") || "").toLowerCase();
    const editablePassword = this instanceof HTMLInputElement &&
      this.type.toLowerCase() === "password" && !this.readOnly && !this.disabled;
    if (editablePassword || autocomplete.includes("password")) {
      return { agenttab_secret_error: "secret_capture_source_forbidden" };
    }
    return { value: this.value.trim() };
  }
  if (this instanceof HTMLSelectElement || !(this instanceof HTMLElement)) {
    return { agenttab_secret_error: "secret_capture_source_invalid" };
  }
  return { value: this.innerText.trim() };
}
