import { fillEmailCodeInPage, type EmailCodePageRefusal } from "./email-code-page";
import { NotStartedError } from "./scheduler";
import { sensitiveFieldState } from "./sensitive-field";
import { isRecord } from "./type-guards";

/**
 * Debugger declaration for the email code fill. Called on the first target with
 * the expectation, the values, then every target element as remote objects.
 */
export const EMAIL_CODE_FILL_DECLARATION =
  `function(expectation,values,...elements){return (${fillEmailCodeInPage.toString()})(elements,values,expectation,${sensitiveFieldState.toString()})}`;

const EMAIL_CODE_HANDOFF_RECOVERY =
  "Do not retry the email code fill on this page. Start browser_handoff for this tab and let the human complete the verification.";
const EMAIL_CODE_SNAPSHOT_RECOVERY =
  "Take a fresh browser_snapshot of the approved verification page, then retry with its current refs and page revision.";

/**
 * Fixed text for every failure the email code fill reports. A failure never
 * carries the original message, which may come from the page and echo the code.
 */
const EMAIL_CODE_FAILURES: Readonly<Record<string, { message: string; recovery?: string }>> = {
  invalid_request: { message: "The email code fill request is invalid" },
  stale_revision: { message: "The page changed since the snapshot", recovery: EMAIL_CODE_SNAPSHOT_RECOVERY },
  stale_ref: { message: "A code field ref no longer resolves", recovery: EMAIL_CODE_SNAPSHOT_RECOVERY },
  email_code_page_mismatch: {
    message: "The tab is not on the approved email verification page",
    recovery: EMAIL_CODE_SNAPSHOT_RECOVERY,
  },
  email_code_target_invalid: {
    message: "The refs do not name the verification code inputs of one email code form",
    recovery: EMAIL_CODE_SNAPSHOT_RECOVERY,
  },
  email_code_context_unverified: {
    message: "The page does not show an email code verification",
  },
  email_code_recipient_unverified: {
    message: "The verification page does not identify the exact intended email recipient",
    recovery: "Use a verification page that identifies the full recipient or one compatible masked recipient, or let the human complete this step.",
  },
  email_code_context_forbidden: {
    message: "The page asks for multi-factor, passkey, or human verification",
    recovery: EMAIL_CODE_HANDOFF_RECOVERY,
  },
  email_code_fill_failed: {
    message: "The page did not accept the email verification code",
    recovery: EMAIL_CODE_SNAPSHOT_RECOVERY,
  },
  challenge_active: {
    message: "A human verification challenge is active on this tab",
    recovery: EMAIL_CODE_HANDOFF_RECOVERY,
  },
  cross_origin_credentials_forbidden: {
    message: "Email codes cannot be filled in a frame from another origin",
  },
  browser_restricted_origin: { message: "AgentTab cannot fill an email code on a browser-restricted origin" },
  debugger_unavailable: { message: "Chrome refused AgentTab's debugger for this tab" },
  frame_unavailable: { message: "The code field's frame is unavailable" },
  frame_not_found: { message: "The code field's frame is unavailable" },
  debugger_detached: { message: "AgentTab's debugger detached from the tab" },
  extension_disconnected: { message: "The AgentTab extension disconnected" },
  ownership_denied: { message: "Tab is not owned by this AgentTab task" },
  ownership_revoked: { message: "Tab ownership changed before the email code fill" },
  permissions_required: {
    message: "AgentTab automation permissions have not been enabled",
    recovery: "Open the AgentTab popup and choose Enable automation.",
  },
  paused: { message: "AgentTab is paused" },
  origin_denied: { message: "AgentTab policy denies the tab's origin" },
  origin_not_allowed: { message: "AgentTab policy does not allow the tab's origin" },
  origin_unavailable: { message: "AgentTab cannot determine the target tab's current origin" },
  origin_policy_mismatch: { message: "origin_policy.tab_id does not match the command target" },
  scheme_denied: { message: "AgentTab Standard mode does not allow the tab's URL scheme" },
  origin_policy_unverifiable: { message: "AgentTab cannot verify the target tab's origin policy" },
};
const EMAIL_CODE_FAILURE_FALLBACK = "AgentTab could not fill the email verification code";

const REFUSAL_CODES: Readonly<Record<string, string>> = {
  target_invalid: "email_code_target_invalid",
  sensitive_target: "email_code_target_invalid",
  otp_mismatch: "email_code_target_invalid",
  password_present: "email_code_target_invalid",
  url_mismatch: "email_code_page_mismatch",
  cross_origin_frame: "cross_origin_credentials_forbidden",
  context_unverified: "email_code_context_unverified",
  recipient_unverified: "email_code_recipient_unverified",
  mfa_context: "email_code_context_forbidden",
  human_challenge: "email_code_context_forbidden",
  write_failed: "email_code_fill_failed",
} satisfies Record<EmailCodePageRefusal, string>;

/** A coded email code failure with fixed text; `outcome` is set when it is known. */
export function emailCodeError(code: string, outcome?: "not_started" | "unknown"): Error {
  const known = EMAIL_CODE_FAILURES[code];
  return Object.assign(new Error(known?.message ?? EMAIL_CODE_FAILURE_FALLBACK), {
    code,
    ...(known?.recovery !== undefined ? { recovery: known.recovery } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
  });
}

/**
 * Interprets the page result. A refusal before any character reached the page did
 * not start; a failed write was rolled back, but page listeners already ran.
 */
export function assertEmailCodeFilled(value: unknown, expectedFields: number): void {
  const verdict = isRecord(value) && isRecord(value.agenttab_email_code) ? value.agenttab_email_code : null;
  if (verdict === null) throw emailCodeError("email_code_fill_failed", "unknown");
  if (verdict.ok === true && verdict.filled === expectedFields) return;
  const reason = typeof verdict.reason === "string" && Object.hasOwn(REFUSAL_CODES, verdict.reason)
    ? REFUSAL_CODES[verdict.reason]
    : "email_code_fill_failed";
  throw emailCodeError(reason, verdict.ok === false && verdict.wrote === false ? "not_started" : "unknown");
}

/**
 * Rebuilds any failure of the email code operation from a known code alone, so no
 * page, Chrome, or nested message or unrecognized code can carry the code into a
 * response.
 */
export function sanitizeEmailCodeFailure(error: unknown, outcome?: "not_started" | "unknown"): Error {
  const rawCode = isRecord(error) ? error.code : undefined;
  const code = typeof rawCode === "string" && Object.hasOwn(EMAIL_CODE_FAILURES, rawCode)
    ? rawCode
    : "email_code_fill_failed";
  const rawOutcome = isRecord(error) ? error.outcome : undefined;
  const knownOutcome = rawOutcome === "not_started" || rawOutcome === "unknown"
    ? rawOutcome
    : error instanceof NotStartedError
      ? "not_started"
      : outcome;
  const sanitized = emailCodeError(code, knownOutcome);
  if (isRecord(error) && typeof error.currentPageRevision === "number") {
    return Object.assign(sanitized, { currentPageRevision: error.currentPageRevision });
  }
  return sanitized;
}
