import { describe, expect, test } from "bun:test";
import {
  activeEpisodeForTab,
  advance,
  catalogSelectors,
  catalogTokenSelectors,
  collectChallengeFacts,
  detect,
  episodeEvent,
  findEpisode,
  frameOfInterest,
  newChallengeId,
  parseChallengeEpisode,
  retryAfterMs,
  CHALLENGE_EPISODE_TTL_MS,
  CHALLENGE_MAX_EPISODES_PER_TASK,
  type ChallengeCatalog,
  type ChallengeConfidence,
  type ChallengeInteraction,
  type ChallengeKind,
  type SurfaceScope,
  type ChallengeEpisode,
  type ChallengeEvent,
  type ElementFact,
  type FrameFact,
  type ProbeFacts,
  type Signature,
} from "../src/challenge";
import { CHALLENGE_CATALOG } from "../src/challenge-catalog";

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const ORIGIN = "https://shop.example";
const CATALOG: ChallengeCatalog = CHALLENGE_CATALOG;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function facts(overrides: Partial<ProbeFacts> = {}): ProbeFacts {
  return {
    probe: "scripting",
    page_origin: ORIGIN,
    scripts: [],
    frames: [],
    elements: [],
    tokens: [],
    ...overrides,
  };
}

function frame(host: string, path: string, overrides: Partial<FrameFact> = {}): FrameFact {
  return {
    host,
    path,
    query: {},
    origin: `https://${host}`,
    visible: true,
    width: 300,
    height: 65,
    ...overrides,
  };
}

function element(selector: string, overrides: Partial<ElementFact> = {}): ElementFact {
  return { selector, count: 1, visible: true, width: 300, height: 65, ...overrides };
}

const TURNSTILE_TOKEN = 'input[name="cf-turnstile-response"]';
const RECAPTCHA_TOKEN = 'textarea[name="g-recaptcha-response"]';
const HCAPTCHA_TOKEN = 'textarea[name="h-captcha-response"]';
const TEXT_IMG = 'img[alt*="captcha" i], img[id*="captcha" i], img[src*="captcha" i]';
const TEXT_INPUT = 'input[name*="captcha" i], input[id*="captcha" i]';

const turnstileFrame = (overrides: Partial<FrameFact> = {}) =>
  frame("challenges.cloudflare.com", "/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv/", overrides);
const recaptchaAnchor = (overrides: Partial<FrameFact> = {}) =>
  frame("www.google.com", "/recaptcha/api2/anchor", { width: 304, height: 78, ...overrides });
const cloudflarePageScripts = [
  { host: "shop.example", path: "/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1", query: {} },
];

function primaryId(catalog: ChallengeCatalog, probe: ProbeFacts): string | undefined {
  return detect(catalog, probe).primary?.signature.id;
}

const REQUIRED_EVENT_KEYS = [
  "spec_version", "challenge_id", "tab_id", "page_revision", "first_page_revision",
  "first_detected_at_ms", "detected_at_ms", "page_origin", "vendor", "product", "kind",
  "interaction", "state", "confidence", "surface", "signals", "next", "detector",
];
const OPTIONAL_EVENT_KEYS = ["token_present", "wait_budget_ms", "retry_after_ms", "notice_id"];

/** Structural equivalent of the schema invariants that are cheap to express. */
function expectSchemaConformant(event: ChallengeEvent): void {
  const keys = Object.keys(event);
  for (const key of REQUIRED_EVENT_KEYS) expect(keys).toContain(key);
  for (const key of keys) {
    expect([...REQUIRED_EVENT_KEYS, ...OPTIONAL_EVENT_KEYS]).toContain(key);
    expect((event as unknown as Record<string, unknown>)[key]).not.toBeUndefined();
  }
  expect(event.spec_version).toBe(1);
  expect(event.challenge_id).toMatch(/^chl_[0-9a-z]{20}$/);
  expect(event.page_origin).toMatch(/^https?:\/\/[^/?#\s]+$/);
  expect(event.vendor).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
  expect(event.product).toMatch(/^[a-z][a-z0-9_]{0,47}$/);
  expect(event.detector.catalog_version).toMatch(/^[0-9]{4}\.[0-9]{2}\.[0-9]+$/);
  expect(Object.keys(event.detector).sort()).toEqual(["catalog_version", "probe"]);
  expect(event.first_detected_at_ms).toBeLessThanOrEqual(event.detected_at_ms);
  expect(event.first_page_revision).toBeLessThanOrEqual(event.page_revision);
  expect(event.signals.length).toBeGreaterThanOrEqual(1);
  expect(event.signals.length).toBeLessThanOrEqual(16);
  expect(new Set(event.signals).size).toBe(event.signals.length);
  for (const signal of event.signals) expect(signal).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);

  // Surface.
  const surfaceKeys = Object.keys(event.surface);
  for (const key of surfaceKeys) expect(["scope", "frame_id", "frame_origin", "visible"]).toContain(key);
  if (event.surface.scope === "frame") {
    expect(event.surface.frame_id).toBeTruthy();
    expect(event.surface.frame_origin).toBeTruthy();
  }
  if (event.surface.scope === "document") expect(event.surface.frame_origin).toBeUndefined();
  if (event.surface.frame_origin !== undefined) {
    expect(event.surface.frame_origin).toMatch(/^https?:\/\/[^/?#\s]+$/);
  }

  // Kind / interaction.
  if (event.kind === "interstitial" || event.kind === "block" || event.kind === "rate_limit") {
    expect(event.surface.scope).toBe("document");
  }
  if (event.kind === "block" || event.kind === "rate_limit") expect(event.interaction).toBe("none");
  if (event.kind === "widget" || event.kind === "puzzle" || event.kind === "interstitial") {
    expect(["automatic", "human"]).toContain(event.interaction);
  }
  if (event.kind === "puzzle") expect(event.interaction).toBe("human");
  if (event.token_present !== undefined) expect(event.kind).toBe("widget");
  if (event.retry_after_ms !== undefined) expect(event.kind).toBe("rate_limit");

  // Next.
  if (event.state !== "active") {
    expect(event.next).toBe("none");
    expect(event.wait_budget_ms).toBeUndefined();
    expect(event.retry_after_ms).toBeUndefined();
  } else {
    if (event.interaction === "automatic") expect(["wait", "handoff"]).toContain(event.next);
    if (event.interaction === "human") expect(event.next).toBe("handoff");
    if (event.kind === "block") expect(event.next).toBe("stop");
    if (event.kind === "rate_limit") expect(event.next).toBe("retry_later");
    expect(event.next).not.toBe("none");
  }
  if (event.next === "wait") {
    expect(event.wait_budget_ms).toBeGreaterThanOrEqual(1000);
    expect(event.wait_budget_ms).toBeLessThanOrEqual(120_000);
  } else {
    expect(event.wait_budget_ms).toBeUndefined();
  }
  if (event.retry_after_ms !== undefined) {
    expect(event.retry_after_ms).toBeGreaterThanOrEqual(0);
    expect(event.retry_after_ms).toBeLessThanOrEqual(86_400_000);
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("catalog", () => {
  test("v0 shape", () => {
    expect(CHALLENGE_CATALOG.catalog_version).toBe("2026.10.0");
    const ids = CATALOG.signatures.map((signature) => signature.id);
    expect(new Set(ids).size).toBe(ids.length);
    const disabled = CATALOG.signatures.filter((signature) => !signature.enabled).map((s) => s.id).sort();
    expect(disabled).toEqual([
      "altcha.widget",
      "anubis.interstitial",
      "friendly_captcha.widget",
      "geetest.captcha",
      "google_recaptcha.image_puzzle",
      "hcaptcha.puzzle",
      "human_security.press_hold",
    ]);
    expect(CATALOG.signatures.filter((signature) => signature.enabled).length).toBe(12);
  });

  test("signatures satisfy the schema's kind and interaction rules", () => {
    const signals = new Set<string>();
    for (const signature of CATALOG.signatures) {
      expect(signature.id.startsWith(`${signature.vendor}.`)).toBe(true);
      if (signature.kind === "block" || signature.kind === "rate_limit") expect(signature.interaction).toBe("none");
      else expect(["automatic", "human"]).toContain(signature.interaction);
      if (signature.kind === "puzzle") expect(signature.interaction).toBe("human");
      if (signature.active_when !== "never" && signature.interaction === "automatic") {
        expect(signature.wait_budget_ms).toBeGreaterThanOrEqual(1000);
      }
      if (signature.active_when === "widget_unsolved") expect(signature.token_field).toBeDefined();
      expect(signature.signals.length).toBeGreaterThan(0);
      for (const rule of signature.signals) {
        expect(rule.signal).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
        expect(signals.has(rule.signal)).toBe(false);
        signals.add(rule.signal);
      }
    }
  });

  test("probe inputs come from enabled signatures only", () => {
    const selectors = catalogSelectors(CATALOG);
    expect(selectors).toContain(".cf-turnstile");
    expect(selectors).toContain(".grecaptcha-badge");
    expect(selectors).toContain(TEXT_IMG);
    expect(selectors).toContain(TEXT_INPUT);
    expect(selectors).not.toContain("#px-captcha");
    expect(selectors).not.toContain("altcha-widget");
    expect(new Set(selectors).size).toBe(selectors.length);
    expect(catalogTokenSelectors(CATALOG).sort()).toEqual([HCAPTCHA_TOKEN, RECAPTCHA_TOKEN, TURNSTILE_TOKEN].sort());
  });

  test("frameOfInterest follows host constraints of enabled frame leaves", () => {
    expect(frameOfInterest(CATALOG, "challenges.cloudflare.com")).toBe(true);
    expect(frameOfInterest(CATALOG, "newassets.hcaptcha.com")).toBe(true);
    expect(frameOfInterest(CATALOG, "HCAPTCHA.com")).toBe(true);
    expect(frameOfInterest(CATALOG, "client-api.arkoselabs.com")).toBe(true);
    expect(frameOfInterest(CATALOG, "www.google.com")).toBe(true);
    expect(frameOfInterest(CATALOG, "nothcaptcha.com")).toBe(false);
    expect(frameOfInterest(CATALOG, "example.org")).toBe(false);
  });
});

describe("ids", () => {
  test("challenge ids match the schema pattern and do not repeat", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const id = newChallengeId();
      expect(id).toMatch(/^chl_[0-9a-z]{20}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface PositiveCase {
  name: string;
  facts: ProbeFacts;
  signature: string;
  kind: ChallengeKind;
  interaction: ChallengeInteraction;
  confidence: ChallengeConfidence;
  scope: SurfaceScope;
  signal: string;
  token?: boolean;
}

const positives: PositiveCase[] = [
  {
    name: "Cloudflare challenge page by header",
    facts: facts({ probe: "debugger", status: 403, headers: { "cf-mitigated": "challenge" } }),
    signature: "cloudflare.challenge_page", kind: "interstitial", interaction: "automatic",
    confidence: "high", scope: "document", signal: "cloudflare.header.cf_mitigated",
  },
  {
    name: "Cloudflare challenge page by orchestrate script",
    facts: facts({ scripts: cloudflarePageScripts }),
    signature: "cloudflare.challenge_page", kind: "interstitial", interaction: "automatic",
    confidence: "medium", scope: "document", signal: "cloudflare.script.challenge_page",
  },
  {
    name: "Cloudflare challenge page by jsch script",
    facts: facts({
      scripts: [{ host: "shop.example", path: "/cdn-cgi/challenge-platform/h/g/orchestrate/jsch/v1", query: {} }],
    }),
    signature: "cloudflare.challenge_page", kind: "interstitial", interaction: "automatic",
    confidence: "medium", scope: "document", signal: "cloudflare.script.challenge_page",
  },
  {
    name: "Turnstile frame",
    facts: facts({ frames: [turnstileFrame()] }),
    signature: "cloudflare.turnstile", kind: "widget", interaction: "automatic",
    confidence: "high", scope: "element", signal: "cloudflare.frame.challenges_host", token: false,
  },
  {
    name: "Turnstile frame with a CDP frame id",
    facts: facts({ probe: "debugger", frames: [turnstileFrame({ frame_id: "F1" })] }),
    signature: "cloudflare.turnstile", kind: "widget", interaction: "automatic",
    confidence: "high", scope: "frame", signal: "cloudflare.frame.challenges_host", token: false,
  },
  {
    name: "Turnstile container",
    facts: facts({ elements: [element(".cf-turnstile")] }),
    signature: "cloudflare.turnstile", kind: "widget", interaction: "automatic",
    confidence: "medium", scope: "element", signal: "cloudflare.dom.turnstile_container", token: false,
  },
  {
    name: "reCAPTCHA v2 checkbox",
    facts: facts({ frames: [recaptchaAnchor()] }),
    signature: "google_recaptcha.checkbox", kind: "widget", interaction: "human",
    confidence: "medium", scope: "element", signal: "google_recaptcha.frame.anchor", token: false,
  },
  {
    name: "reCAPTCHA enterprise checkbox on recaptcha.net",
    facts: facts({ frames: [recaptchaAnchor({ host: "www.recaptcha.net", origin: "https://www.recaptcha.net", path: "/recaptcha/enterprise/anchor", query: { size: "normal" } })] }),
    signature: "google_recaptcha.checkbox", kind: "widget", interaction: "human",
    confidence: "medium", scope: "element", signal: "google_recaptcha.frame.anchor", token: false,
  },
  {
    name: "hCaptcha checkbox",
    facts: facts({ frames: [frame("newassets.hcaptcha.com", "/captcha/v1/abc/static/hcaptcha.html", { width: 303, height: 78 })] }),
    signature: "hcaptcha.checkbox", kind: "widget", interaction: "human",
    confidence: "medium", scope: "element", signal: "hcaptcha.frame.hcaptcha_host", token: false,
  },
  {
    name: "Arkose enforcement",
    facts: facts({ frames: [frame("client-api.arkoselabs.com", "/v2/api/enforcement", { width: 400, height: 500 })] }),
    signature: "arkose.enforcement", kind: "puzzle", interaction: "human",
    confidence: "medium", scope: "element", signal: "arkose.frame.enforcement_host",
  },
  {
    name: "Arkose enforcement on funcaptcha.com",
    facts: facts({ frames: [frame("api.funcaptcha.com", "/fc/api/", { width: 320, height: 270 })] }),
    signature: "arkose.enforcement", kind: "puzzle", interaction: "human",
    confidence: "medium", scope: "element", signal: "arkose.frame.enforcement_host",
  },
  {
    name: "DataDome response page",
    facts: facts({ frames: [frame("geo.captcha-delivery.com", "/captcha/", { width: 1280, height: 720 })] }),
    signature: "datadome.response_page", kind: "interstitial", interaction: "human",
    confidence: "medium", scope: "document", signal: "datadome.frame.captcha_delivery",
  },
  {
    name: "AWS WAF captcha",
    facts: facts({ probe: "debugger", status: 405, headers: { "x-amzn-waf-action": "captcha" } }),
    signature: "aws_waf.captcha", kind: "interstitial", interaction: "human",
    confidence: "high", scope: "document", signal: "aws_waf.header.waf_action_captcha",
  },
  {
    name: "AWS WAF challenge",
    facts: facts({ probe: "debugger", status: 202, headers: { "x-amzn-waf-action": "challenge" } }),
    signature: "aws_waf.challenge", kind: "interstitial", interaction: "automatic",
    confidence: "high", scope: "document", signal: "aws_waf.header.waf_action_challenge",
  },
  {
    name: "generic rate limit",
    facts: facts({ probe: "debugger", status: 429, headers: {} }),
    signature: "generic.rate_limit", kind: "rate_limit", interaction: "none",
    confidence: "high", scope: "document", signal: "generic.status.too_many_requests",
  },
  {
    name: "generic text captcha",
    facts: facts({ elements: [element(TEXT_IMG, { width: 120, height: 40 }), element(TEXT_INPUT, { width: 160, height: 30 })] }),
    signature: "generic.text_captcha", kind: "puzzle", interaction: "human",
    confidence: "low", scope: "element", signal: "generic.dom.text_captcha",
  },
];

describe("detect: positives", () => {
  test("every enabled signature has a positive case", () => {
    const covered = new Set(positives.map((entry) => entry.signature));
    for (const signature of CATALOG.signatures) {
      if (signature.enabled && signature.active_when !== "never") expect(covered.has(signature.id)).toBe(true);
    }
  });

  for (const entry of positives) {
    test(entry.name, () => {
      const result = detect(CATALOG, entry.facts);
      const primary = result.primary;
      expect(primary?.signature.id).toBe(entry.signature);
      expect(primary?.signature.kind).toBe(entry.kind);
      expect(primary?.signature.interaction).toBe(entry.interaction);
      expect(primary?.confidence).toBe(entry.confidence);
      expect(primary?.surface.scope).toBe(entry.scope);
      expect(primary?.surface.visible).toBe(true);
      expect(primary?.signals).toContain(entry.signal);
      expect(primary?.token_present).toBe(entry.token);
      // The same facts must also survive the full episode path as a schema-conformant event.
      const { event } = advance([], result, ctx());
      expect(event).toBeDefined();
      expectSchemaConformant(event!);
    });
  }

  test("frame surfaces carry origins only", () => {
    const primary = detect(CATALOG, facts({
      probe: "debugger",
      frames: [turnstileFrame({ frame_id: "F1", origin: "https://challenges.cloudflare.com" })],
    })).primary!;
    expect(primary.surface).toEqual({
      scope: "frame",
      frame_id: "F1",
      frame_origin: "https://challenges.cloudflare.com",
      visible: true,
    });
  });

  test("a frame whose origin is not a bare http(s) origin never becomes a frame surface", () => {
    const primary = detect(CATALOG, facts({ frames: [turnstileFrame({ frame_id: "F1", origin: "null" })] })).primary!;
    expect(primary.surface).toEqual({ scope: "element", visible: true });
  });

  test("disabled signatures never match", () => {
    expect(primaryId(CATALOG, facts({ elements: [element("#px-captcha")] }))).toBeUndefined();
    expect(primaryId(CATALOG, facts({ elements: [element("altcha-widget")] }))).toBeUndefined();
    expect(primaryId(CATALOG, facts({ scripts: [{ host: "x.example", path: "/.within.website/x.js", query: {} }] }))).toBeUndefined();
    expect(
      detect(CATALOG, facts({ frames: [frame("www.google.com", "/recaptcha/api2/bframe", { width: 400, height: 580 })] })).presence,
    ).toEqual([]);
  });

  test("header and status leaves are false when the probe has no response facts", () => {
    expect(primaryId(CATALOG, facts())).toBeUndefined();
    expect(primaryId(CATALOG, facts({ status: 405 }))).toBeUndefined();
    expect(primaryId(CATALOG, facts({ headers: { "x-amzn-waf-action": "captcha" } }))).toBeUndefined();
  });
});

describe("detect: look-alike negatives", () => {
  test("Cloudflare JavaScript Detections page emits nothing", () => {
    const jsd = [{ host: "shop.example", path: "/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js", query: {} }];
    const result = detect(CATALOG, facts({ scripts: jsd }));
    expect(result.primary).toBeUndefined();
    expect(result.presence.map((entry) => entry.signature_id)).toEqual(["cloudflare.jsd"]);
    // The bare /cdn-cgi/challenge-platform/ prefix alone is also not a challenge page.
    expect(primaryId(CATALOG, facts({ scripts: [{ host: "shop.example", path: "/cdn-cgi/challenge-platform/h/g/other.js", query: {} }] }))).toBeUndefined();
  });

  test("a JSD page's text-captcha lookalike is suppressed", () => {
    const jsd = [{ host: "shop.example", path: "/cdn-cgi/challenge-platform/scripts/jsd/main.js", query: {} }];
    const lookalike = [element(TEXT_IMG), element(TEXT_INPUT)];
    expect(primaryId(CATALOG, facts({ scripts: jsd, elements: lookalike }))).toBeUndefined();
    expect(primaryId(CATALOG, facts({ elements: lookalike }))).toBe("generic.text_captcha");
  });

  test("invisible reCAPTCHA badge emits nothing", () => {
    const result = detect(CATALOG, facts({ elements: [element(".grecaptcha-badge", { width: 256, height: 60 })] }));
    expect(result.primary).toBeUndefined();
    expect(result.presence.map((entry) => entry.signature_id)).toEqual(["google_recaptcha.v3"]);
  });

  test("reCAPTCHA anchor with size=invisible emits nothing and does not match the checkbox", () => {
    const result = detect(CATALOG, facts({ frames: [recaptchaAnchor({ query: { size: "invisible" }, width: 256, height: 60 })] }));
    expect(result.primary).toBeUndefined();
    expect(result.presence.map((entry) => entry.signature_id)).toEqual(["google_recaptcha.v3"]);
  });

  test("a reCAPTCHA v3 page (badge, invisible anchor, empty response field, text lookalike) emits nothing", () => {
    expect(primaryId(CATALOG, facts({
      frames: [recaptchaAnchor({ query: { size: "invisible" } })],
      elements: [element(".grecaptcha-badge"), element(TEXT_IMG), element(TEXT_INPUT)],
      tokens: [{ selector: RECAPTCHA_TOKEN, present: true, non_empty: false }],
    }))).toBeUndefined();
  });

  test("a visible v2 anchor next to an invisible one is still a checkbox", () => {
    expect(primaryId(CATALOG, facts({
      frames: [recaptchaAnchor({ query: { size: "invisible" } }), recaptchaAnchor()],
    }))).toBe("google_recaptcha.checkbox");
  });

  test("hidden Turnstile container and frame emit nothing but are present", () => {
    const hidden = facts({
      frames: [turnstileFrame({ visible: false, width: 0, height: 0 })],
      elements: [element(".cf-turnstile", { visible: false, width: 0, height: 0 })],
      tokens: [{ selector: TURNSTILE_TOKEN, present: true, non_empty: false }],
    });
    const result = detect(CATALOG, hidden);
    expect(result.primary).toBeUndefined();
    expect(result.presence).toEqual([{ signature_id: "cloudflare.turnstile", vendor: "cloudflare", token_present: false }]);
  });

  test("a Turnstile tracking-pixel frame below min_size emits nothing", () => {
    expect(primaryId(CATALOG, facts({ frames: [turnstileFrame({ width: 1, height: 1 })] }))).toBeUndefined();
  });

  test("Turnstile with a non-empty token is not active but reports token_present", () => {
    const solved = facts({
      frames: [turnstileFrame()],
      tokens: [{ selector: TURNSTILE_TOKEN, present: true, non_empty: true }],
    });
    const result = detect(CATALOG, solved);
    expect(result.primary).toBeUndefined();
    expect(result.presence).toEqual([{ signature_id: "cloudflare.turnstile", vendor: "cloudflare", token_present: true }]);
  });

  test("hCaptcha frame taller than 149 does not match the checkbox", () => {
    const tall = facts({ frames: [frame("newassets.hcaptcha.com", "/captcha/v1/x/static/hcaptcha.html", { width: 400, height: 150 })] });
    expect(primaryId(CATALOG, tall)).toBeUndefined();
    const edge = facts({ frames: [frame("newassets.hcaptcha.com", "/captcha/v1/x/static/hcaptcha.html", { width: 303, height: 149 })] });
    expect(primaryId(CATALOG, edge)).toBe("hcaptcha.checkbox");
  });

  test("a frame on a look-alike host does not match vendor suffixes", () => {
    expect(primaryId(CATALOG, facts({ frames: [frame("nothcaptcha.com", "/x", { height: 78 })] }))).toBeUndefined();
    expect(primaryId(CATALOG, facts({ frames: [frame("hcaptcha.com.evil.example", "/x", { height: 78 })] }))).toBeUndefined();
  });

  test("Arkose frame below min_size and non-visible frames emit nothing", () => {
    expect(primaryId(CATALOG, facts({ frames: [frame("client-api.arkoselabs.com", "/e", { width: 299, height: 250 })] }))).toBeUndefined();
    expect(primaryId(CATALOG, facts({ frames: [frame("client-api.arkoselabs.com", "/e", { width: 400, height: 500, visible: false })] }))).toBeUndefined();
  });

  test("text captcha needs both a visible image and a visible input", () => {
    expect(primaryId(CATALOG, facts({ elements: [element(TEXT_IMG), element(TEXT_INPUT, { visible: false })] }))).toBeUndefined();
    expect(primaryId(CATALOG, facts({ elements: [element(TEXT_IMG)] }))).toBeUndefined();
  });

  test("AWS WAF markers need header and status together", () => {
    expect(primaryId(CATALOG, facts({ status: 200, headers: { "x-amzn-waf-action": "captcha" } }))).toBeUndefined();
    expect(primaryId(CATALOG, facts({ status: 405, headers: { "x-amzn-waf-action": "challenge" } }))).toBeUndefined();
  });

  test("Cloudflare challenge header with another value is not a challenge", () => {
    expect(primaryId(CATALOG, facts({ status: 200, headers: { "cf-mitigated": "block" } }))).toBeUndefined();
  });
});

describe("detect: precedence and suppression", () => {
  test("a Cloudflare interstitial with an embedded Turnstile frame is one interstitial", () => {
    const result = detect(CATALOG, facts({
      probe: "debugger",
      status: 403,
      headers: { "cf-mitigated": "challenge" },
      scripts: cloudflarePageScripts,
      frames: [turnstileFrame({ frame_id: "F1" })],
    }));
    expect(result.primary?.signature.id).toBe("cloudflare.challenge_page");
    expect(result.primary?.surface).toEqual({ scope: "document", visible: true });
    expect(result.primary?.signals).toEqual(["cloudflare.header.cf_mitigated", "cloudflare.script.challenge_page"]);
    expect(result.presence.map((entry) => entry.signature_id)).toEqual(["cloudflare.challenge_page", "cloudflare.turnstile"]);
    const { episodes, event } = advance([], result, ctx());
    expect(episodes).toHaveLength(1);
    expect(event?.kind).toBe("interstitial");
  });

  test("a vendor match suppresses generic.text_captcha, even a passive one", () => {
    const lookalike = [element(TEXT_IMG), element(TEXT_INPUT)];
    expect(primaryId(CATALOG, facts({ elements: lookalike, frames: [recaptchaAnchor()] }))).toBe("google_recaptcha.checkbox");
    expect(primaryId(CATALOG, facts({ elements: [...lookalike, element(".grecaptcha-badge")] }))).toBeUndefined();
  });

  test("a vendor match whose gate fails still suppresses generics", () => {
    expect(primaryId(CATALOG, facts({
      probe: "debugger",
      status: 429,
      frames: [turnstileFrame({ visible: false })],
    }))).toBeUndefined();
  });

  test("generic.rate_limit yields to a vendor interstitial on a 429", () => {
    expect(primaryId(CATALOG, facts({
      probe: "debugger", status: 429, headers: { "cf-mitigated": "challenge" },
    }))).toBe("cloudflare.challenge_page");
  });

  test("kind order block > rate_limit > interstitial > puzzle > widget, then confidence, then catalog order", () => {
    const make = (id: string, kind: Signature["kind"], confidence: "high" | "medium" | "low"): Signature => ({
      id: `acme.${id}`,
      enabled: true,
      vendor: "acme",
      product: id,
      kind,
      interaction: kind === "block" || kind === "rate_limit" ? "none" : "human",
      active_when: "document",
      signals: [{ signal: `acme.status.${id}`, confidence, when: { status: { in: [500] } } }],
    });
    const all = [
      make("widget", "widget", "high"),
      make("puzzle", "puzzle", "high"),
      make("interstitial_low", "interstitial", "low"),
      make("interstitial_high", "interstitial", "high"),
      make("interstitial_high_later", "interstitial", "high"),
      make("rate_limit", "rate_limit", "low"),
      make("block", "block", "low"),
    ];
    const probe = facts({ status: 500 });
    const order: string[] = [];
    let remaining = all;
    while (remaining.length > 0) {
      const primary = primaryId({ catalog_version: "2026.10.1", signatures: remaining }, probe);
      order.push(primary!);
      remaining = remaining.filter((signature) => signature.id !== primary);
    }
    expect(order).toEqual([
      "acme.block",
      "acme.rate_limit",
      "acme.interstitial_high",
      "acme.interstitial_high_later",
      "acme.interstitial_low",
      "acme.puzzle",
      "acme.widget",
    ]);
  });

  test("confidence of a signature is the highest of its matched rules, and all matched signals are listed", () => {
    const result = detect(CATALOG, facts({
      probe: "debugger",
      status: 403,
      headers: { "cf-mitigated": "challenge" },
      scripts: cloudflarePageScripts,
    }));
    expect(result.primary?.confidence).toBe("high");
    expect(result.primary?.signals).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

let idCounter = 0;
const nextId = () => `chl_${(++idCounter).toString(32).padStart(20, "0")}`;

function ctx(overrides: Partial<Parameters<typeof advance>[2]> = {}): Parameters<typeof advance>[2] {
  return {
    taskId: "task-1",
    tabId: 7,
    pageRevision: 3,
    pageOrigin: ORIGIN,
    now: T0,
    probe: "scripting",
    catalogVersion: CHALLENGE_CATALOG.catalog_version,
    newId: nextId,
    ...overrides,
  };
}

interface Step {
  episodes: ChallengeEpisode[];
  event?: ChallengeEvent;
}

function scan(
  episodes: readonly ChallengeEpisode[],
  probe: ProbeFacts,
  overrides: Partial<Parameters<typeof advance>[2]> = {},
  catalog: ChallengeCatalog = CATALOG,
): Step {
  const status = probe.document_status === undefined ? {} : { documentStatus: probe.document_status };
  const step = advance(
    episodes,
    detect(catalog, probe),
    ctx({ pageOrigin: probe.page_origin, probe: probe.probe, ...status, ...overrides }),
  );
  if (step.event) expectSchemaConformant(step.event);
  return step;
}

const cloudflareInterstitial = () => facts({ scripts: cloudflarePageScripts });
const turnstileActive = () => facts({ frames: [turnstileFrame()] });
const clean = (origin = ORIGIN, probe: ProbeFacts["probe"] = "scripting") => facts({ page_origin: origin, probe });

describe("episodes: interstitial", () => {
  test("self-reload keeps the id and first_* fields while the revision advances", () => {
    const first = scan([], cloudflareInterstitial(), { now: T0, pageRevision: 3 });
    expect(first.event).toMatchObject({
      state: "active", kind: "interstitial", next: "wait", wait_budget_ms: 15_000,
      first_page_revision: 3, page_revision: 3, first_detected_at_ms: T0, detected_at_ms: T0,
    });
    const second = scan(first.episodes, cloudflareInterstitial(), { now: T0 + 2_000, pageRevision: 4 });
    expect(second.event?.challenge_id).toBe(first.event?.challenge_id);
    expect(second.event).toMatchObject({
      state: "active", first_page_revision: 3, page_revision: 4,
      first_detected_at_ms: T0, detected_at_ms: T0 + 2_000, wait_budget_ms: 13_000,
    });
    expect(second.episodes).toHaveLength(1);
  });

  test("a same-origin clean scan reports cleared exactly once", () => {
    const active = scan([], cloudflareInterstitial());
    const cleared = scan(active.episodes, clean(), { now: T0 + 4_000, pageRevision: 5 });
    expect(cleared.event).toMatchObject({
      state: "cleared", next: "none", challenge_id: active.event?.challenge_id,
      page_revision: 5, first_page_revision: 3,
    });
    expect(cleared.event?.surface.visible).toBe(false);
    expect(cleared.event?.wait_budget_ms).toBeUndefined();
    const later = scan(cleared.episodes, clean(), { now: T0 + 5_000, pageRevision: 5 });
    expect(later.event).toBeUndefined();
    expect(later.episodes).toHaveLength(1);
    expect(later.episodes[0]).toMatchObject({ state: "cleared", terminal_reported: true });
  });

  test("a clean scan on another origin reports superseded", () => {
    const active = scan([], cloudflareInterstitial());
    const left = scan(active.episodes, clean("https://other.example"), { now: T0 + 1_000, pageRevision: 4 });
    expect(left.event).toMatchObject({ state: "superseded", next: "none", challenge_id: active.event?.challenge_id });
    // The event keeps the origin of the episode it ends, not the origin the tab moved to.
    expect(left.event?.page_origin).toBe(ORIGIN);
    expect(scan(left.episodes, clean("https://other.example")).event).toBeUndefined();
  });

  test("the same vendor on a different origin is a new episode", () => {
    const active = scan([], cloudflareInterstitial());
    const other = facts({ page_origin: "https://other.example", scripts: cloudflarePageScripts });
    const moved = scan(active.episodes, other, { now: T0 + 1_000, pageRevision: 4 });
    expect(moved.event?.challenge_id).not.toBe(active.event?.challenge_id);
    expect(moved.event?.state).toBe("active");
    expect(moved.episodes.map((episode) => episode.state)).toEqual(["superseded", "active"]);
  });

  test("automatic budget: wait with the remaining ms, then handoff once it is spent", () => {
    const first = scan([], cloudflareInterstitial(), { now: T0 });
    expect(first.event).toMatchObject({ next: "wait", wait_budget_ms: 15_000 });
    const mid = scan(first.episodes, cloudflareInterstitial(), { now: T0 + 5_000 });
    expect(mid.event).toMatchObject({ next: "wait", wait_budget_ms: 10_000 });
    const edge = scan(mid.episodes, cloudflareInterstitial(), { now: T0 + 14_000 });
    expect(edge.event).toMatchObject({ next: "wait", wait_budget_ms: 1_000 });
    const spent = scan(edge.episodes, cloudflareInterstitial(), { now: T0 + 14_001 });
    expect(spent.event?.next).toBe("handoff");
    expect(spent.event?.wait_budget_ms).toBeUndefined();
    const long = scan(spent.episodes, cloudflareInterstitial(), { now: T0 + 60_000 });
    expect(long.event?.next).toBe("handoff");
  });

  test("a human interstitial hands off immediately", () => {
    const step = scan([], facts({ frames: [frame("geo.captcha-delivery.com", "/captcha/", { width: 1280, height: 720 })] }));
    expect(step.event).toMatchObject({ vendor: "datadome", interaction: "human", next: "handoff" });
  });
});

describe("episodes: rate limit", () => {
  const limited = (headers: Record<string, string>) => facts({ probe: "debugger", status: 429, headers });

  test("Retry-After in seconds", () => {
    expect(scan([], limited({ "retry-after": "120" })).event).toMatchObject({
      kind: "rate_limit", next: "retry_later", retry_after_ms: 120_000,
    });
  });

  test("Retry-After as an HTTP-date", () => {
    const header = new Date(T0 + 90_000).toUTCString();
    expect(scan([], limited({ "retry-after": header }), { now: T0 }).event?.retry_after_ms).toBe(90_000);
  });

  test("absent, invalid, and out-of-range Retry-After", () => {
    expect(scan([], limited({})).event?.retry_after_ms).toBeUndefined();
    expect(scan([], limited({ "retry-after": "soon" })).event?.retry_after_ms).toBeUndefined();
    expect(scan([], limited({ "retry-after": "99999999999" })).event?.retry_after_ms).toBe(86_400_000);
    expect(scan([], limited({ "retry-after": new Date(T0 - 5_000).toUTCString() }), { now: T0 }).event?.retry_after_ms).toBe(0);
  });

  test("a later clean scan on the same origin clears it", () => {
    const active = scan([], limited({ "retry-after": "30" }));
    const cleared = scan(active.episodes, clean(ORIGIN, "debugger"), { now: T0 + 31_000 });
    expect(cleared.event).toMatchObject({ state: "cleared", next: "none", kind: "rate_limit" });
    expect(cleared.event?.retry_after_ms).toBeUndefined();
  });

  test("retryAfterMs parses and clamps", () => {
    expect(retryAfterMs("0", T0)).toBe(0);
    expect(retryAfterMs(" 7 ", T0)).toBe(7_000);
    expect(retryAfterMs("-3", T0)).toBeUndefined();
    expect(retryAfterMs("1.5", T0)).toBeUndefined();
    expect(retryAfterMs("", T0)).toBeUndefined();
    expect(retryAfterMs(undefined, T0)).toBeUndefined();
    expect(retryAfterMs("86401", T0)).toBe(86_400_000);
    expect(retryAfterMs(new Date(T0 + 2_000).toUTCString(), T0)).toBe(2_000);
  });
});

describe("episodes: evidence the scripting probe cannot observe", () => {
  const awsCaptcha = () => facts({ probe: "debugger", status: 405, headers: { "x-amzn-waf-action": "captcha" } });

  test("detect marks observability per matched rule", () => {
    expect(detect(CATALOG, awsCaptcha()).primary?.observable_by_scripting).toBe(false);
    expect(detect(CATALOG, facts({ probe: "debugger", status: 429, headers: {} })).primary?.observable_by_scripting).toBe(false);
    expect(detect(CATALOG, facts({ probe: "debugger", headers: { "cf-mitigated": "challenge" } })).primary?.observable_by_scripting).toBe(false);
    expect(detect(CATALOG, cloudflareInterstitial()).primary?.observable_by_scripting).toBe(true);
    const both = facts({ probe: "debugger", headers: { "cf-mitigated": "challenge" }, scripts: cloudflarePageScripts });
    expect(detect(CATALOG, both).primary?.observable_by_scripting).toBe(true);
    expect(detect(CATALOG, facts({ frames: [turnstileFrame()] })).primary?.observable_by_scripting).toBe(true);
  });

  test("a header-only AWS WAF captcha survives a scripting clean scan and clears on a debugger one", () => {
    const active = scan([], awsCaptcha(), { now: T0, pageRevision: 3 });
    expect(active.event).toMatchObject({ vendor: "aws_waf", state: "active", next: "handoff" });
    const blind = scan(active.episodes, clean(), { now: T0 + 5_000, pageRevision: 4 });
    expect(blind.event).toEqual(active.event!);
    expect(blind.episodes).toEqual(active.episodes);
    const sighted = scan(blind.episodes, clean(ORIGIN, "debugger"), { now: T0 + 6_000, pageRevision: 4 });
    expect(sighted.event).toMatchObject({
      state: "cleared", next: "none", challenge_id: active.event?.challenge_id, page_revision: 4,
    });
    expect(scan(sighted.episodes, clean(ORIGIN, "debugger"), { now: T0 + 7_000 }).event).toBeUndefined();
    expect(scan(sighted.episodes, clean(), { now: T0 + 7_000 }).event).toBeUndefined();
  });

  test("a kept automatic episode re-emits with a refreshed wait budget and untouched observation fields", () => {
    const active = scan([], facts({ probe: "debugger", status: 202, headers: { "x-amzn-waf-action": "challenge" } }), { now: T0 });
    expect(active.event).toMatchObject({ next: "wait", wait_budget_ms: 10_000 });
    const blind = scan(active.episodes, clean(), { now: T0 + 4_000, pageRevision: 9 });
    expect(blind.event).toMatchObject({
      challenge_id: active.event?.challenge_id, state: "active", next: "wait", wait_budget_ms: 6_000,
      detected_at_ms: T0, page_revision: 3,
    });
    const spent = scan(blind.episodes, clean(), { now: T0 + 10_500 });
    expect(spent.event).toMatchObject({ state: "active", next: "handoff" });
    expect(spent.event?.wait_budget_ms).toBeUndefined();
  });

  test("a header-only rate limit stays active under a scripting scan", () => {
    const active = scan([], facts({ probe: "debugger", status: 429, headers: { "retry-after": "60" } }));
    const blind = scan(active.episodes, clean(), { now: T0 + 1_000 });
    expect(blind.event).toMatchObject({ kind: "rate_limit", state: "active", retry_after_ms: 60_000 });
  });

  test("Cloudflare detected by header AND script is observable, so a scripting clean scan clears it", () => {
    const both = facts({ probe: "debugger", status: 403, headers: { "cf-mitigated": "challenge" }, scripts: cloudflarePageScripts });
    const active = scan([], both);
    const cleared = scan(active.episodes, clean(), { now: T0 + 3_000 });
    expect(cleared.event).toMatchObject({ state: "cleared", challenge_id: active.event?.challenge_id });
  });

  test("Cloudflare detected by header alone is not cleared by a scripting scan", () => {
    const active = scan([], facts({ probe: "debugger", status: 403, headers: { "cf-mitigated": "challenge" } }));
    expect(scan(active.episodes, clean(), { now: T0 + 3_000 }).event?.state).toBe("active");
  });

  test("a scripting scan of a document with another status ends a header-only episode", () => {
    // A handoff detaches the debugger, so the scan after a human clears the gate is a scripting scan.
    const cf = facts({ probe: "debugger", status: 403, headers: { "cf-mitigated": "challenge" }, document_status: 403 });
    const active = scan([], cf, { now: T0, pageRevision: 3 });
    const same = scan(active.episodes, facts({ document_status: 403 }), { now: T0 + 1_000, pageRevision: 4 });
    expect(same.event).toMatchObject({ state: "active", challenge_id: active.event?.challenge_id, page_revision: 3 });
    const unknown = scan(same.episodes, clean(), { now: T0 + 2_000, pageRevision: 4 });
    expect(unknown.event?.state).toBe("active");
    const reloaded = scan(unknown.episodes, facts({ document_status: 200 }), { now: T0 + 3_000, pageRevision: 5 });
    expect(reloaded.event).toMatchObject({
      state: "cleared", next: "none", challenge_id: active.event?.challenge_id, page_revision: 5,
    });
  });

  test("the detection status persists and never appears in events", () => {
    const active = scan([], { ...awsCaptcha(), document_status: 405 });
    expect(JSON.stringify(active.event)).not.toContain("405");
    const stored = JSON.parse(JSON.stringify(active.episodes[0]));
    expect(parseChallengeEpisode(stored)?.document_status).toBe(405);
    expect(parseChallengeEpisode({ ...stored, document_status: "405" })).toBeUndefined();
    const restored = [parseChallengeEpisode(stored)!];
    expect(scan(restored, facts({ document_status: 405 }), { now: T0 + 1_000 }).event?.state).toBe("active");
    expect(scan(restored, facts({ document_status: 200 }), { now: T0 + 1_000 }).event?.state).toBe("cleared");
  });

  test("a cross-origin scripting scan still supersedes a header-only episode", () => {
    const active = scan([], awsCaptcha());
    const left = scan(active.episodes, clean("https://other.example"), { now: T0 + 1_000 });
    expect(left.event).toMatchObject({ state: "superseded", challenge_id: active.event?.challenge_id });
  });

  test("TTL expiry still applies to a kept episode", () => {
    const active = scan([], awsCaptcha(), { now: T0 });
    const stale = scan(active.episodes, clean(), { now: T0 + CHALLENGE_EPISODE_TTL_MS + 1 });
    expect(stale.event).toBeUndefined();
    expect(stale.episodes[0]).toMatchObject({ state: "superseded", terminal_reported: true });
  });

  test("the flag persists, defaults to true when missing, and never appears in events", () => {
    const active = scan([], awsCaptcha());
    const stored = JSON.parse(JSON.stringify(active.episodes[0]));
    expect(stored.observable_by_scripting).toBe(false);
    expect(parseChallengeEpisode(stored)?.observable_by_scripting).toBe(false);
    delete stored.observable_by_scripting;
    expect(parseChallengeEpisode(stored)?.observable_by_scripting).toBe(true);
    expect(parseChallengeEpisode({ ...stored, observable_by_scripting: "no" })).toBeUndefined();
    expect(Object.keys(active.event!)).not.toContain("observable_by_scripting");
  });
});

describe("episodes: embedded", () => {
  test("a widget clears when its token appears, once", () => {
    const active = scan([], turnstileActive());
    expect(active.event).toMatchObject({ kind: "widget", state: "active", token_present: false, next: "wait" });
    const solved = facts({
      frames: [turnstileFrame()],
      tokens: [{ selector: TURNSTILE_TOKEN, present: true, non_empty: true }],
    });
    const cleared = scan(active.episodes, solved, { now: T0 + 3_000, pageRevision: 3 });
    expect(cleared.event).toMatchObject({
      state: "cleared", next: "none", token_present: true, challenge_id: active.event?.challenge_id,
    });
    expect(scan(cleared.episodes, solved, { now: T0 + 4_000 }).event).toBeUndefined();
  });

  test("a widget that hides itself after success still clears through its container", () => {
    const active = scan([], turnstileActive());
    const hidden = facts({
      frames: [],
      elements: [element(".cf-turnstile", { visible: false, width: 0, height: 0 })],
      tokens: [{ selector: TURNSTILE_TOKEN, present: true, non_empty: true }],
    });
    expect(scan(active.episodes, hidden, { now: T0 + 2_000 }).event).toMatchObject({ state: "cleared", token_present: true });
  });

  test("a widget that disappears with an empty token is superseded", () => {
    const active = scan([], turnstileActive());
    const gone = scan(active.episodes, clean(), { now: T0 + 1_000 });
    expect(gone.event).toMatchObject({ state: "superseded", next: "none", challenge_id: active.event?.challenge_id });
  });

  test("a token for a different vendor does not clear the widget", () => {
    const active = scan([], turnstileActive());
    const other = facts({
      frames: [],
      elements: [element(".cf-turnstile", { visible: false })],
      tokens: [{ selector: TURNSTILE_TOKEN, present: true, non_empty: false }],
    });
    expect(scan(active.episodes, other).event?.state).toBe("superseded");
  });

  test("an origin change supersedes the widget even if a token is visible", () => {
    const active = scan([], turnstileActive());
    const moved = facts({
      page_origin: "https://other.example",
      elements: [element(".cf-turnstile", { visible: false })],
      tokens: [{ selector: TURNSTILE_TOKEN, present: true, non_empty: true }],
    });
    expect(scan(active.episodes, moved).event?.state).toBe("superseded");
  });

  test("a new vendor in the embedded class supersedes the old one silently", () => {
    const first = scan([], turnstileActive());
    const second = scan(first.episodes, facts({ frames: [recaptchaAnchor()] }), { now: T0 + 1_000 });
    expect(second.event).toMatchObject({ vendor: "google_recaptcha", state: "active" });
    expect(second.event?.challenge_id).not.toBe(first.event?.challenge_id);
    expect(second.episodes.map((episode) => [episode.vendor, episode.state, episode.terminal_reported])).toEqual([
      ["cloudflare", "superseded", true],
      ["google_recaptcha", "active", false],
    ]);
  });

  test("a document challenge silently supersedes an active embedded episode", () => {
    const widget = scan([], facts({ frames: [recaptchaAnchor()] }));
    const both = facts({ scripts: cloudflarePageScripts, frames: [recaptchaAnchor()] });
    const step = scan(widget.episodes, both, { now: T0 + 1_000 });
    expect(step.event).toMatchObject({ kind: "interstitial", vendor: "cloudflare" });
    expect(step.episodes.find((episode) => episode.vendor === "google_recaptcha")).toMatchObject({
      state: "superseded", terminal_reported: true,
    });
  });

  test("widget -> puzzle keeps the id and changes kind; a hidden puzzle returns it to the widget", () => {
    const acme: ChallengeCatalog = {
      catalog_version: "2026.10.1",
      signatures: [
        {
          id: "acme.widget", enabled: true, vendor: "acme", product: "widget", kind: "widget",
          interaction: "automatic", active_when: "widget_unsolved", wait_budget_ms: 10_000,
          token_field: 'input[name="acme"]',
          signals: [{ signal: "acme.frame.widget", confidence: "medium", when: { frame: { host: ["acme.example"], path_prefix: ["/widget"] } } }],
        },
        {
          id: "acme.puzzle", enabled: true, vendor: "acme", product: "puzzle", kind: "puzzle",
          interaction: "human", active_when: "visible_frame", min_size: { width: 300, height: 300 },
          signals: [{ signal: "acme.frame.puzzle", confidence: "medium", when: { frame: { host: ["acme.example"], path_prefix: ["/puzzle"] } } }],
        },
      ],
    };
    const widgetFrame = frame("acme.example", "/widget");
    const puzzleFrame = frame("acme.example", "/puzzle", { width: 400, height: 500 });
    const first = scan([], facts({ frames: [widgetFrame] }), {}, acme);
    expect(first.event).toMatchObject({ kind: "widget", interaction: "automatic", next: "wait", token_present: false });
    expect(first.episodes[0]!.signature_id).toBe("acme.widget");
    const opened = scan(first.episodes, facts({ frames: [widgetFrame, puzzleFrame] }), { now: T0 + 2_000, pageRevision: 4 }, acme);
    expect(opened.event).toMatchObject({
      kind: "puzzle", interaction: "human", next: "handoff", product: "puzzle",
      challenge_id: first.event?.challenge_id, first_page_revision: 3, page_revision: 4,
    });
    expect(opened.event?.token_present).toBeUndefined();
    expect(opened.event?.wait_budget_ms).toBeUndefined();
    expect(opened.episodes[0]!.signature_id).toBe("acme.puzzle");
    const hidden = scan(
      opened.episodes,
      facts({ frames: [widgetFrame, { ...puzzleFrame, visible: false }] }),
      { now: T0 + 3_000, pageRevision: 4 },
      acme,
    );
    expect(hidden.event).toMatchObject({ kind: "widget", challenge_id: first.event?.challenge_id, state: "active" });
    const solved = scan(
      hidden.episodes,
      facts({
        frames: [widgetFrame],
        tokens: [{ selector: 'input[name="acme"]', present: true, non_empty: true }],
      }),
      { now: T0 + 4_000 },
      acme,
    );
    expect(solved.event).toMatchObject({ state: "cleared", challenge_id: first.event?.challenge_id });
    expect(solved.episodes).toHaveLength(1);
  });

  test("a puzzle that clears with its parent widget's token reports cleared", () => {
    const acme: ChallengeCatalog = {
      catalog_version: "2026.10.1",
      signatures: [
        {
          id: "acme.puzzle", enabled: true, vendor: "acme", product: "puzzle", kind: "puzzle",
          interaction: "human", active_when: "visible_frame", token_field: 'input[name="acme"]',
          signals: [{ signal: "acme.frame.puzzle", confidence: "medium", when: { frame: { host: ["acme.example"] } } }],
        },
      ],
    };
    const active = scan([], facts({ frames: [frame("acme.example", "/p", { width: 400, height: 400 })] }), {}, acme);
    expect(active.event?.kind).toBe("puzzle");
    const done = scan(
      active.episodes,
      facts({
        frames: [frame("acme.example", "/p", { visible: false })],
        tokens: [{ selector: 'input[name="acme"]', present: true, non_empty: true }],
      }),
      {},
      acme,
    );
    expect(done.event).toMatchObject({ state: "cleared", kind: "puzzle" });
    expect(done.event?.token_present).toBeUndefined();
  });
});

describe("episodes: retention", () => {
  test("an active episode older than 15 minutes is superseded without a report", () => {
    const first = scan([], cloudflareInterstitial(), { now: T0 });
    const stale = scan(first.episodes, clean(), { now: T0 + CHALLENGE_EPISODE_TTL_MS + 1 });
    expect(stale.event).toBeUndefined();
    expect(stale.episodes[0]).toMatchObject({ state: "superseded", terminal_reported: true });
  });

  test("an expired episode is not extended by a new detection of the same vendor", () => {
    const first = scan([], cloudflareInterstitial(), { now: T0 });
    const again = scan(first.episodes, cloudflareInterstitial(), { now: T0 + CHALLENGE_EPISODE_TTL_MS + 1 });
    expect(again.event?.challenge_id).not.toBe(first.event?.challenge_id);
    expect(again.event?.first_detected_at_ms).toBe(T0 + CHALLENGE_EPISODE_TTL_MS + 1);
    expect(again.episodes.map((episode) => episode.state)).toEqual(["superseded", "active"]);
  });

  test("a detection exactly at the boundary still belongs to the episode", () => {
    const first = scan([], cloudflareInterstitial(), { now: T0 });
    const again = scan(first.episodes, cloudflareInterstitial(), { now: T0 + CHALLENGE_EPISODE_TTL_MS });
    expect(again.event?.challenge_id).toBe(first.event?.challenge_id);
  });

  test("at most 32 episodes per task are kept, dropping the oldest terminal first", () => {
    let episodes: ChallengeEpisode[] = [];
    const ids: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const probe = facts({ page_origin: `https://site${index}.example`, scripts: cloudflarePageScripts });
      const step = scan(episodes, probe, { now: T0 + index * 1_000 });
      episodes = step.episodes;
      ids.push(step.event!.challenge_id);
    }
    expect(CHALLENGE_MAX_EPISODES_PER_TASK).toBe(32);
    expect(episodes).toHaveLength(32);
    expect(episodes.map((episode) => episode.challenge_id)).toEqual(ids.slice(-32));
    expect(episodes.filter((episode) => episode.state === "active").map((e) => e.challenge_id)).toEqual([ids[39]!]);
  });

  test("the cap drops terminal episodes before active ones on other tabs", () => {
    const other = scan([], cloudflareInterstitial(), { tabId: 99, now: T0 }).episodes[0]!;
    let episodes: ChallengeEpisode[] = [other];
    for (let index = 0; index < 40; index += 1) {
      const probe = facts({ page_origin: `https://site${index}.example`, scripts: cloudflarePageScripts });
      episodes = scan(episodes, probe, { now: T0 + 1 + index * 1_000 }).episodes;
    }
    expect(episodes).toHaveLength(32);
    expect(episodes.some((episode) => episode.challenge_id === other.challenge_id)).toBe(true);
  });

  test("episodes on other tabs are left alone", () => {
    const other = scan([], cloudflareInterstitial(), { tabId: 99, now: T0 });
    const step = scan(other.episodes, clean(), { tabId: 7, now: T0 + 1_000 });
    expect(step.event).toBeUndefined();
    expect(step.episodes[0]).toMatchObject({ tab_id: 99, state: "active" });
  });

  test("advance does not mutate its input", () => {
    const first = scan([], cloudflareInterstitial());
    const frozen = structuredClone(first.episodes);
    scan(first.episodes, clean(), { now: T0 + 1_000 });
    expect(first.episodes).toEqual(frozen);
  });
});

describe("episode persistence", () => {
  test("round-trips through JSON and rejects malformed records", () => {
    const step = scan([], turnstileActive());
    const stored = JSON.parse(JSON.stringify(step.episodes[0]));
    expect(parseChallengeEpisode(stored)).toEqual(step.episodes[0]);
    expect(episodeEvent(parseChallengeEpisode(stored)!)).toEqual(step.event!);

    const broken: unknown[] = [
      null,
      "x",
      {},
      { ...stored, challenge_id: "chl_short" },
      { ...stored, kind: "other" },
      { ...stored, page_origin: "https://shop.example/path" },
      { ...stored, signals: [] },
      { ...stored, surface: { scope: "frame", visible: "yes" } },
      { ...stored, tab_id: -1 },
      { ...stored, terminal_reported: "no" },
      { ...stored, detector: { catalog_version: "x", probe: "magic" } },
    ];
    for (const value of broken) expect(parseChallengeEpisode(value)).toBeUndefined();
  });

  test("unknown stored keys are dropped", () => {
    const step = scan([], turnstileActive());
    const parsed = parseChallengeEpisode({ ...JSON.parse(JSON.stringify(step.episodes[0])), cookie: "secret", url: "https://x/y" });
    expect(parsed).toBeDefined();
    expect(Object.keys(parsed!)).not.toContain("cookie");
    expect(Object.keys(parsed!)).not.toContain("url");
  });

  test("the signature id persists, is required on read, and is never emitted", () => {
    const step = scan([], turnstileActive());
    const stored = JSON.parse(JSON.stringify(step.episodes[0]));
    expect(stored.signature_id).toBe("cloudflare.turnstile");
    expect(parseChallengeEpisode(stored)?.signature_id).toBe("cloudflare.turnstile");
    const { signature_id: _dropped, ...withoutSignature } = stored;
    expect(parseChallengeEpisode(withoutSignature)).toBeUndefined();
    expect(parseChallengeEpisode({ ...stored, signature_id: "" })).toBeUndefined();
    expect(Object.keys(step.event!)).not.toContain("signature_id");
  });

  test("lookup helpers find episodes by id and prefer document scope", () => {
    const widget = scan([], turnstileActive());
    const document = scan([], cloudflareInterstitial(), { now: T0 + 1_000 });
    const merged = [...widget.episodes, ...document.episodes];
    const documentEpisode = merged.find((episode) => episode.scope_class === "document")!;
    expect(findEpisode(merged, "task-1", documentEpisode.challenge_id)).toBe(documentEpisode);
    expect(findEpisode(merged, "other-task", documentEpisode.challenge_id)).toBeUndefined();
    expect(activeEpisodeForTab(merged, "task-1", 7)).toBe(documentEpisode);
    expect(activeEpisodeForTab(widget.episodes, "task-1", 7)).toBe(widget.episodes[0]);
    expect(activeEpisodeForTab(merged, "task-1", 8)).toBeUndefined();
    expect(activeEpisodeForTab(merged, "other-task", 7)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Page-side probe
// ---------------------------------------------------------------------------

interface FakeBox { width: number; height: number; left?: number; top?: number }

describe("collectChallengeFacts", () => {
  const TOKEN_VALUE = "example-response-token-123";

  function run(selectors: string[], tokenSelectors: string[], navigation: unknown[] = []): unknown {
    const node = (box: FakeBox, extra: Record<string, unknown> = {}, shown = true) => ({
      checkVisibility: () => shown,
      getBoundingClientRect: () => ({ width: box.width, height: box.height, left: box.left ?? 10, top: box.top ?? 10 }),
      ...extra,
    });
    const byselector: Record<string, unknown[]> = {
      ".cf-turnstile": [node({ width: 300, height: 65 })],
      ".grecaptcha-badge": [node({ width: 256, height: 60 }, {}, false)],
      "#px-captcha": [node({ width: 300, height: 100, left: -9999 })],
      "altcha-widget": [node({ width: 0, height: 0 })],
      [TURNSTILE_TOKEN]: [node({ width: 0, height: 0 }, { value: TOKEN_VALUE })],
      [RECAPTCHA_TOKEN]: [node({ width: 10, height: 10 }, { value: "" })],
    };
    const iframes = [
      node({ width: 300, height: 65 }, { src: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile?k=SITEKEY&size=normal" }),
      node({ width: 256, height: 60, left: -10_000 }, { src: "https://www.google.com/recaptcha/api2/anchor?size=invisible" }),
      node({ width: 10, height: 10 }, { src: "about:blank", getAttribute: () => null }),
      node({ width: 10, height: 10 }, { src: "", getAttribute: () => "javascript:void(0)" }),
    ];
    const fakeDocument = {
      baseURI: "https://shop.example/page",
      documentElement: { scrollWidth: 1280, scrollHeight: 4000 },
      scripts: [
        { src: "https://shop.example/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?x=1" },
        { src: "" },
        { src: "https://cdn.example/app.js" },
      ],
      querySelectorAll(selector: string) {
        if (selector === "iframe") return iframes;
        if (selector.startsWith("[[")) throw new SyntaxError("invalid selector");
        return byselector[selector] ?? [];
      },
    };
    const fakeWindow = {
      innerWidth: 1280,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      location: { origin: "https://shop.example" },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    };
    const fakePerformance = { getEntriesByType: (type: string) => (type === "navigation" ? navigation : []) };
    // Re-create the function from its source in a scope that has no module bindings: any
    // reference to something outside its body surfaces as a ReferenceError here, exactly as it
    // would in the page after chrome.scripting serializes it.
    const probe = new Function("document", "window", "performance", `return (${collectChallengeFacts.toString()});`)(
      fakeDocument, fakeWindow, fakePerformance,
    );
    return probe(selectors, tokenSelectors);
  }

  test("reports the main document's response status only when the page has one", () => {
    expect((run([], [], [{ responseStatus: 403 }]) as ProbeFactsPage).document_status).toBe(403);
    expect(run([], [], [{ responseStatus: 0 }])).not.toHaveProperty("document_status");
    expect(run([], [])).not.toHaveProperty("document_status");
  });

  test("is self-contained and reports script, frame, element, and token facts", () => {
    const result = run(
      [".cf-turnstile", ".grecaptcha-badge", "#px-captcha", "altcha-widget", "[[invalid", ".missing"],
      [TURNSTILE_TOKEN, RECAPTCHA_TOKEN, "textarea[name=none]"],
    ) as ProbeFactsPage;
    expect(result.page_origin).toBe("https://shop.example");
    expect(result.scripts).toEqual([
      { host: "shop.example", path: "/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1", query: {} },
      { host: "cdn.example", path: "/app.js", query: {} },
    ]);
    expect(result.frames).toEqual([
      {
        host: "challenges.cloudflare.com",
        path: "/cdn-cgi/challenge-platform/h/g/turnstile",
        query: { k: "SITEKEY", size: "normal" },
        origin: "https://challenges.cloudflare.com",
        visible: true, width: 300, height: 65,
      },
      {
        host: "www.google.com",
        path: "/recaptcha/api2/anchor",
        query: { size: "invisible" },
        origin: "https://www.google.com",
        visible: false, width: 256, height: 60,
      },
    ]);
    expect(result.elements).toEqual([
      { selector: ".cf-turnstile", count: 1, visible: true, width: 300, height: 65 },
      { selector: ".grecaptcha-badge", count: 1, visible: false, width: 0, height: 0 },
      { selector: "#px-captcha", count: 1, visible: false, width: 0, height: 0 },
      { selector: "altcha-widget", count: 1, visible: false, width: 0, height: 0 },
      { selector: "[[invalid", count: 0, visible: false, width: 0, height: 0 },
      { selector: ".missing", count: 0, visible: false, width: 0, height: 0 },
    ]);
    expect(result.tokens).toEqual([
      { selector: TURNSTILE_TOKEN, present: true, non_empty: true },
      { selector: RECAPTCHA_TOKEN, present: true, non_empty: false },
      { selector: "textarea[name=none]", present: false, non_empty: false },
    ]);
  });

  test("never returns token values or sitekeys through detection", () => {
    const page = run([".cf-turnstile"], [TURNSTILE_TOKEN]) as ProbeFactsPage;
    expect(JSON.stringify(page)).not.toContain(TOKEN_VALUE);
    const probe = facts({ ...page, probe: "scripting" });
    const result = detect(CATALOG, probe);
    // The Turnstile container is visible but its token is non-empty: present, not active. The
    // fake page's challenge-platform script still makes the document a Cloudflare interstitial.
    expect(result.presence).toContainEqual({ signature_id: "cloudflare.turnstile", vendor: "cloudflare", token_present: true });
    expect(result.primary?.signature.id).toBe("cloudflare.challenge_page");
    const step = scan([], probe);
    expect(step.event?.kind).toBe("interstitial");
    const serialized = JSON.stringify([step.event, step.episodes]);
    expect(serialized).not.toContain("SITEKEY");
    expect(serialized).not.toContain(TOKEN_VALUE);
  });
});

type ProbeFactsPage = Omit<ProbeFacts, "probe">;
