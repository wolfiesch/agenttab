import { describe, expect, test } from "bun:test";
import { assertEmailCodeFilled, emailCodeError, sanitizeEmailCodeFailure } from "../src/email-code-fill";
import { fillEmailCodeInPage, type EmailCodePageExpectation, type EmailCodePageRefusal, type EmailCodePageResult } from "../src/email-code-page";
import { NATIVE_PROTOCOL, parseCommand, parseEmailCodeFillParams, PROTOCOL_VERSION } from "../src/protocol";
import { NotStartedError } from "../src/scheduler";
import { sensitiveFieldState } from "../src/sensitive-field";
import { ATLASSIAN, atlassianSplitPage, FakeDocument, singleCodePage, type FakeInput } from "./email-code-dom";

const ID = "018f47b8-2f80-7c20-9c77-f8a38c9e621e";
const CODE = "7K3Q9Z";
const EXPECTATION: EmailCodePageExpectation = { ...ATLASSIAN };
const MASK = "a***t@e***m";
const MASKED_TEXT = `To complete your account setup, enter the code we've sent to: ${MASK}`;

function fill(
  elements: unknown[],
  values: string[],
  expectation: EmailCodePageExpectation = EXPECTATION,
): EmailCodePageResult {
  return fillEmailCodeInPage(elements, values, expectation, sensitiveFieldState);
}

function refusal(reason: EmailCodePageRefusal, wrote = false): EmailCodePageResult {
  return { agenttab_email_code: { ok: false, reason, wrote } };
}

function untouched(inputs: FakeInput[]): void {
  for (const input of inputs) {
    expect(input.stored).toBe("");
    expect(input.events).toEqual([]);
  }
}

describe("email code page function", () => {
  test("fills Atlassian's six split OTP boxes in order with native events", () => {
    const { inputs } = atlassianSplitPage();
    expect(fill(inputs, [...CODE])).toEqual({ agenttab_email_code: { ok: true, filled: 6 } });
    expect(inputs.map((input) => input.stored).join("")).toBe(CODE);
    for (const input of inputs) {
      expect(input.events).toEqual(["input", "change"]);
    }
  });

  test("fills one one-time-code box with the whole code", () => {
    const { input } = singleCodePage();
    expect(fill([input], ["482913"])).toEqual({ agenttab_email_code: { ok: true, filled: 1 } });
    expect(input.stored).toBe("482913");
  });

  test("refuses another page path, a foreign frame, and an unreadable parent before writing", () => {
    const moved = atlassianSplitPage({ path: "/login" });
    expect(fill(moved.inputs, [...CODE])).toEqual(refusal("url_mismatch"));
    untouched(moved.inputs);

    const framed = atlassianSplitPage({
      origin: "https://evil.example",
      top: { origin: ATLASSIAN.origin, pathname: ATLASSIAN.path },
    });
    expect(fill(framed.inputs, [...CODE])).toEqual(refusal("cross_origin_frame"));
    untouched(framed.inputs);

    const blocked = atlassianSplitPage({ top: "blocked" });
    expect(fill(blocked.inputs, [...CODE])).toEqual(refusal("cross_origin_frame"));
    untouched(blocked.inputs);
  });

  test("refuses password, MFA, and human challenge contexts", () => {
    const password = atlassianSplitPage();
    password.doc.input({ type: "password", name: "password" });
    expect(fill(password.inputs, [...CODE])).toEqual(refusal("password_present"));
    untouched(password.inputs);

    const mfa = atlassianSplitPage({ text: "Enter the code from your authenticator app sent for agent@example.com email" });
    expect(fill(mfa.inputs, [...CODE])).toEqual(refusal("mfa_context"));
    untouched(mfa.inputs);

    const captcha = atlassianSplitPage({ text: "Please verify you are human. We emailed a code to agent@example.com" });
    expect(fill(captcha.inputs, [...CODE])).toEqual(refusal("human_challenge"));
    untouched(captcha.inputs);

    const disclosure = atlassianSplitPage({
      text: "We emailed a code to agent@example.com. This site is protected by reCAPTCHA and the Google Privacy Policy applies.",
    });
    expect(fill(disclosure.inputs, [...CODE])).toEqual({ agenttab_email_code: { ok: true, filled: 6 } });
  });

  test("requires email verification wording and the exact recipient", () => {
    const noEmail = atlassianSplitPage({ text: "Enter the code we sent to agent@example.com", title: "Confirm" });
    // "agent@example.com" alone is not email wording; the corpus needs email or inbox.
    expect(fill(noEmail.inputs, [...CODE])).toEqual(refusal("context_unverified"));

    for (const text of [
      "We emailed a code to someone@example.com",
      "We emailed a code to xagent@example.com",
      "We emailed a code to agent@example.com.evil.test",
    ]) {
      const page = atlassianSplitPage({ text });
      expect(fill(page.inputs, [...CODE])).toEqual(refusal("recipient_unverified"));
      untouched(page.inputs);
    }

    const shown = atlassianSplitPage({ text: "We emailed you a verification code." });
    const echo = shown.doc.input({ type: "email" });
    echo.stored = "Agent@Example.com";
    expect(fill(shown.inputs, [...CODE])).toEqual({ agenttab_email_code: { ok: true, filled: 6 } });
  });

  test("fills directly when the page names the recipient by one compatible mask", () => {
    const page = atlassianSplitPage({ title: "We've emailed you a code", text: `${MASKED_TEXT}. Support: help@atlassian.com.` });
    expect(fill(page.inputs, [...CODE])).toEqual({ agenttab_email_code: { ok: true, filled: 6 } });
    expect(page.inputs.map((input) => input.stored).join("")).toBe(CODE);

    const single = singleCodePage({ title: "Check your email", text: `We emailed a verification code to ${MASK}.` });
    expect(fill([single.input], ["482913"])).toEqual({ agenttab_email_code: { ok: true, filled: 1 } });
    expect(single.input.stored).toBe("482913");

    // A displayed email field may carry the mask instead of the page text.
    const displayed = atlassianSplitPage({ title: "Check your email", text: "Enter the verification code we emailed you." });
    const echo = displayed.doc.input({ type: "email" });
    echo.stored = "A***T@E***M";
    expect(fill(displayed.inputs, [...CODE])).toEqual({ agenttab_email_code: { ok: true, filled: 6 } });

    // The same mask shown twice is still one mask.
    const repeated = atlassianSplitPage({ title: "Check your email", text: `${MASKED_TEXT}. Not ${MASK}? Resend email.` });
    expect(fill(repeated.inputs, [...CODE])).toEqual({ agenttab_email_code: { ok: true, filled: 6 } });
    expect(repeated.inputs.map((input) => input.stored).join("")).toBe(CODE);

    // A full recipient keeps filling even beside a mask that would not count on its own.
    const full = atlassianSplitPage({ text: "We emailed a code to agent@example.com, not b***@example.com." });
    expect(fill(full.inputs, [...CODE])).toEqual({ agenttab_email_code: { ok: true, filled: 6 } });
  });

  test("refuses a missing, incompatible, ambiguous, or contradicted mask without writing", () => {
    for (const text of [
      "We've emailed you a verification code to b***t@e***m",
      "We've emailed you a verification code to a***t@x***m",
      // Without any visible literal, a mask names no one.
      "We've emailed you a verification code to ***@***",
      // Two different compatible masks are ambiguous.
      `We've emailed you a verification code to ${MASK} or ag***@example.com`,
      // One incompatible mask contradicts a compatible one.
      `We've emailed you a verification code to ${MASK} and b***@example.com`,
      // A full address the mask also fits, other than the recipient, contradicts it.
      `We've emailed you a verification code to ${MASK} (ant@exam.com)`,
      // Unicode masking is not ASCII `*` evidence.
      "We've emailed you a verification code to a•••t@e•••m",
      `We've emailed you a verification code to ${"a".repeat(70)}***t@e***m`,
      "We've emailed you a verification code.",
    ]) {
      const page = atlassianSplitPage({ title: "Check your email", text });
      expect(fill(page.inputs, [...CODE])).toEqual(refusal("recipient_unverified"));
      untouched(page.inputs);
    }
  });

  test("never lets a compatible mask override password, MFA, or human challenge guards", () => {
    const password = atlassianSplitPage({ title: "Check your email", text: MASKED_TEXT });
    password.doc.input({ type: "password", name: "password" });
    expect(fill(password.inputs, [...CODE])).toEqual(refusal("password_present"));
    untouched(password.inputs);

    const mfa = atlassianSplitPage({ title: "Check your email", text: `${MASKED_TEXT}. Or use your authenticator app.` });
    expect(fill(mfa.inputs, [...CODE])).toEqual(refusal("mfa_context"));
    untouched(mfa.inputs);

    const captcha = atlassianSplitPage({ title: "Check your email", text: `${MASKED_TEXT}. Please verify you are human.` });
    expect(fill(captcha.inputs, [...CODE])).toEqual(refusal("human_challenge"));
    untouched(captcha.inputs);

    const backup = new FakeDocument({ title: "Check your email", text: MASKED_TEXT });
    const box = backup.input({ type: "text", "aria-label": "Backup code" });
    expect(fill([box], ["482913"])).toEqual(refusal("mfa_context"));
    expect(box.stored).toBe("");

    const moved = atlassianSplitPage({ title: "Check your email", text: MASKED_TEXT });
    moved.inputs[2].addEventListener("input", () => {
      moved.doc.location.pathname = "/signup/complete";
    });
    expect(fill(moved.inputs, [...CODE])).toEqual(refusal("url_mismatch", true));
    expect(moved.inputs.map((input) => input.stored)).toEqual(["", "", "", "", "", ""]);
  });

  test("refuses targets that are not one ordered code widget before writing", () => {
    const disabled = atlassianSplitPage();
    disabled.inputs[3].disabled = true;
    expect(fill(disabled.inputs, [...CODE])).toEqual(refusal("target_invalid"));
    untouched(disabled.inputs);

    const reversed = atlassianSplitPage();
    expect(fill([...reversed.inputs].reverse(), [...CODE])).toEqual(refusal("otp_mismatch"));
    untouched(reversed.inputs);

    const repeated = atlassianSplitPage();
    expect(fill([...repeated.inputs.slice(0, 5), repeated.inputs[0]], [...CODE])).toEqual(refusal("target_invalid"));

    const short = atlassianSplitPage();
    expect(fill(short.inputs.slice(0, 3), [..."7K3"])).toEqual(refusal("otp_mismatch"));

    const numeric = singleCodePage();
    numeric.input.attributes.set("inputmode", "numeric");
    expect(fill([numeric.input], [CODE])).toEqual(refusal("otp_mismatch"));
    untouched([numeric.input]);

    const tooLong = singleCodePage();
    expect(fill([tooLong.input], ["12345678"])).toEqual(refusal("otp_mismatch"));

    const username = new FakeDocument();
    const login = username.input({ type: "text", name: "username", "aria-label": "Username" });
    expect(fill([login], ["482913"])).toEqual(refusal("sensitive_target"));

    const recovery = new FakeDocument();
    const backup = recovery.input({ type: "text", "aria-label": "Backup code" });
    expect(fill([backup], ["482913"])).toEqual(refusal("mfa_context"));
  });

  test("rolls back every written box when the page rejects a character", () => {
    const { inputs } = atlassianSplitPage();
    for (const input of inputs) input.stored = "x";
    // The page drops the third character but accepts the restore.
    inputs[2].pageSetter = (value) => (value === CODE[2] ? "" : value);
    expect(fill(inputs, [...CODE])).toEqual(refusal("write_failed", true));
    expect(inputs.map((input) => input.stored)).toEqual(["x", "x", "x", "x", "x", "x"]);
  });

  test("stops and takes the code back when a listener moves the page or a box mid-fill", () => {
    const moved = atlassianSplitPage();
    moved.inputs[1].addEventListener("input", () => {
      moved.doc.location.pathname = "/signup/complete";
    });
    expect(fill(moved.inputs, [...CODE])).toEqual(refusal("url_mismatch", true));
    expect(moved.inputs.map((input) => input.stored)).toEqual(["", "", "", "", "", ""]);

    const retyped = atlassianSplitPage();
    retyped.inputs[2].addEventListener("change", () => {
      retyped.inputs[3].attributes.set("type", "password");
    });
    expect(fill(retyped.inputs, [...CODE])).toEqual(refusal("target_invalid", true));
    expect(retyped.inputs.map((input) => input.stored)).toEqual(["", "", "", "", "", ""]);

    const detached = atlassianSplitPage();
    detached.inputs[0].addEventListener("input", () => {
      detached.inputs[4].isConnected = false;
    });
    expect(fill(detached.inputs, [...CODE])).toEqual(refusal("target_invalid", true));
    expect(detached.inputs.map((input) => input.stored)).toEqual(["", "", "", "", "", ""]);

    const navigatedLast = atlassianSplitPage();
    navigatedLast.inputs[5].addEventListener("change", () => {
      navigatedLast.doc.location.pathname = "/signup/welcome";
    });
    expect(fill(navigatedLast.inputs, [...CODE])).toEqual(refusal("url_mismatch", true));
    expect(navigatedLast.inputs.map((input) => input.stored)).toEqual(["", "", "", "", "", ""]);
  });

  test("never reports a value a throwing page setter echoes", () => {
    const { inputs } = atlassianSplitPage();
    inputs[4].pageSetter = (value) => {
      throw new Error(`Rejected character ${value} of ${CODE}`);
    };
    const result = fill(inputs, [...CODE]);
    expect(result).toEqual(refusal("write_failed", true));
    expect(JSON.stringify(result)).not.toContain(CODE[4]);
    expect(inputs.slice(0, 4).map((input) => input.stored)).toEqual(["", "", "", ""]);
  });
});

describe("email code result and failure text", () => {
  test("maps page refusals to fixed coded failures with known outcomes", () => {
    const failure = (value: unknown, fields = 6): unknown => {
      try {
        assertEmailCodeFilled(value, fields);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(failure({ agenttab_email_code: { ok: true, filled: 6 } })).toBeUndefined();
    expect(failure({ agenttab_email_code: { ok: true, filled: 5 } })).toMatchObject({
      code: "email_code_fill_failed",
      outcome: "unknown",
    });
    expect(failure(refusal("url_mismatch"))).toMatchObject({ code: "email_code_page_mismatch", outcome: "not_started" });
    expect(failure(refusal("cross_origin_frame"))).toMatchObject({
      code: "cross_origin_credentials_forbidden",
      outcome: "not_started",
    });
    expect(failure(refusal("mfa_context"))).toMatchObject({ code: "email_code_context_forbidden", outcome: "not_started" });
    expect(failure(refusal("recipient_unverified"))).toMatchObject({
      code: "email_code_recipient_unverified",
      outcome: "not_started",
    });
    expect(failure(refusal("context_unverified"))).toMatchObject({
      code: "email_code_context_unverified",
      outcome: "not_started",
    });
    expect(failure(refusal("write_failed", true))).toMatchObject({ code: "email_code_fill_failed", outcome: "unknown" });
    expect(failure({ result: CODE })).toMatchObject({ code: "email_code_fill_failed", outcome: "unknown" });
  });

  test("rebuilds failures from known codes only", () => {
    const echoed = sanitizeEmailCodeFailure(
      Object.assign(new Error(`Uncaught: invalid code ${CODE}`), { code: "action_failed", recovery: CODE, cause: CODE }),
      "unknown",
    );
    expect(echoed).toMatchObject({ code: "email_code_fill_failed", outcome: "unknown" });
    expect(JSON.stringify({ ...echoed, message: echoed.message })).not.toContain(CODE);

    expect(sanitizeEmailCodeFailure(Object.assign(new Error(CODE), { code: "qx7k2m" }))).toMatchObject({
      code: "email_code_fill_failed",
    });

    const stale = sanitizeEmailCodeFailure(
      Object.assign(new Error(`stale ${CODE}`), { code: "stale_revision", currentPageRevision: 9 }),
      "not_started",
    );
    expect(stale).toMatchObject({ code: "stale_revision", currentPageRevision: 9, outcome: "not_started" });
    expect(stale.message).not.toContain(CODE);

    expect(sanitizeEmailCodeFailure(new NotStartedError("paused", `paused ${CODE}`), "unknown")).toMatchObject({
      code: "paused",
      outcome: "not_started",
      message: "AgentTab is paused",
    });
    expect(sanitizeEmailCodeFailure(emailCodeError("stale_ref", "not_started"), "unknown")).toMatchObject({
      code: "stale_ref",
      outcome: "not_started",
    });
  });
});

describe("browser_email_code_fill parameters", () => {
  const valid = {
    tab_id: 7,
    expected_page_revision: 3,
    expected_origin: ATLASSIAN.origin,
    expected_path: ATLASSIAN.path,
    recipient: ATLASSIAN.recipient,
    purpose: "signup",
    fields: [...CODE].map((value, index) => ({ kind: "otp", ref: `rt1.code-${index}`, value })),
  };

  function command(params: unknown): unknown {
    return {
      protocol: NATIVE_PROTOCOL,
      version: PROTOCOL_VERSION,
      kind: "command",
      request_id: ID,
      connection_id: ID,
      task_id: ID,
      method: "browser_email_code_fill",
      params,
    };
  }

  test("accepts split and single code fields", () => {
    expect(() => parseCommand(command(valid))).not.toThrow();
    expect(parseEmailCodeFillParams({
      ...valid,
      purpose: "email_sign_in",
      expected_origin: "http://127.0.0.1:8080",
      expected_path: "/verify",
      fields: [{ kind: "otp", ref: "rt1.one", value: "482913" }],
    })).toMatchObject({ purpose: "email_sign_in", fields: [{ kind: "otp", ref: "rt1.one", value: "482913" }] });
  });

  test("rejects malformed requests without naming the code", () => {
    for (const params of [
      { ...valid, extra: true },
      { ...valid, purpose: "password_reset" },
      { ...valid, expected_origin: "http://id.atlassian.com" },
      { ...valid, expected_origin: "https://id.atlassian.com/" },
      { ...valid, expected_path: "signup" },
      { ...valid, expected_path: "/signup?step=otp" },
      { ...valid, recipient: "agent@example.com, other@example.com" },
      { ...valid, recipient: "@example.com" },
      { ...valid, fields: [] },
      { ...valid, fields: valid.fields.slice(0, 3) },
      { ...valid, fields: valid.fields.map((field) => ({ ...field, kind: "password" })) },
      { ...valid, fields: valid.fields.map((field) => ({ ...field, ref: "rt1.same" })) },
      { ...valid, fields: valid.fields.map((field, index) => (index === 0 ? { ...field, value: "7K" } : field)) },
      { ...valid, fields: [{ kind: "otp", ref: "rt1.one", value: "12 34 56" }] },
      { ...valid, fields: [{ kind: "otp", ref: "rt1.one", value: "123" }] },
    ]) {
      let message = "";
      try {
        parseEmailCodeFillParams(params);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(CODE);
      expect(message).not.toContain("12 34 56");
    }
  });

  test("keeps browser_credentials_fill at three unique kinds", () => {
    const credentials = (fields: unknown[]): unknown => ({
      ...(command({ tab_id: 7, expected_page_revision: 3, fields }) as Record<string, unknown>),
      method: "browser_credentials_fill",
    });
    expect(() => parseCommand(credentials([
      { kind: "username", ref: "a", value: "u" },
      { kind: "password", ref: "b", value: "p" },
      { kind: "otp", ref: "c", value: "1" },
    ]))).not.toThrow();
    expect(() => parseCommand(credentials([
      { kind: "otp", ref: "a", value: "1" },
      { kind: "otp", ref: "b", value: "2" },
    ]))).toThrow("unique");
    expect(() => parseCommand(credentials([
      { kind: "username", ref: "a", value: "u" },
      { kind: "password", ref: "b", value: "p" },
      { kind: "otp", ref: "c", value: "1" },
      { kind: "otp", ref: "d", value: "2" },
    ]))).toThrow("between 1 and 3");
  });
});
