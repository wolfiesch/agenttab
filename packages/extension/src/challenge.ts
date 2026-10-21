/**
 * Challenge detection (ADR 0002): pure matcher, activity gate, precedence, and
 * episode state machine. This module touches no chrome.* API so it can run under
 * `bun test` and in smoke scripts. The one exception that looks like page access,
 * `collectChallengeFacts`, is a self-contained function that chrome.scripting
 * serializes into the page; it is never called from the extension context.
 */

// ---------------------------------------------------------------------------
// Catalog model
// ---------------------------------------------------------------------------

export type ChallengeKind = "interstitial" | "widget" | "puzzle" | "block" | "rate_limit";
export type ChallengeInteraction = "automatic" | "human" | "none";
export type ChallengeConfidence = "high" | "medium" | "low";
export type ActiveWhen = "document" | "visible_frame" | "visible_element" | "widget_unsolved" | "never";

export interface FrameLeaf {
  /** Exact lowercase hosts. A frame matches when it satisfies `host` or `host_suffix`. */
  host?: string[];
  /** Registrable-style suffixes without a leading dot: `hcaptcha.com` matches `hcaptcha.com` and `*.hcaptcha.com`. */
  host_suffix?: string[];
  path_prefix?: string[];
  /** The frame does NOT match when this query parameter has exactly this value. */
  query_absent?: { name: string; equals: string };
  /** The frame matches only when this query parameter has exactly this value. */
  query_equals?: { name: string; equals: string };
}

export type Condition =
  | { header: { name: string; equals: string } }
  | { status: { in: number[] } }
  | { frame: FrameLeaf }
  | { script: { host_suffix?: string[]; path_contains: string[] } }
  | { element: { selector: string } }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface SignalRule {
  signal: string;
  confidence: ChallengeConfidence;
  when: Condition;
}

export interface Signature {
  id: string;
  enabled: boolean;
  vendor: string;
  product: string;
  kind: ChallengeKind;
  interaction: ChallengeInteraction;
  active_when: ActiveWhen;
  wait_budget_ms?: number;
  token_field?: string;
  min_size?: { width: number; height: number };
  max_size?: { width?: number; height?: number };
  signals: SignalRule[];
}

export interface ChallengeCatalog {
  catalog_version: string;
  signatures: Signature[];
}

// ---------------------------------------------------------------------------
// Probe facts (internal only; never copied into events)
// ---------------------------------------------------------------------------

export interface UrlFact {
  host: string;
  path: string;
  query: Record<string, string>;
}

export interface FrameFact extends UrlFact {
  frame_id?: string;
  origin: string;
  visible: boolean;
  width: number;
  height: number;
}

export interface ElementFact {
  selector: string;
  count: number;
  visible: boolean;
  width: number;
  height: number;
}

export interface TokenFact {
  selector: string;
  present: boolean;
  non_empty: boolean;
}

export type ChallengeProbe = "debugger" | "scripting";

export interface ProbeFacts {
  probe: ChallengeProbe;
  page_origin: string;
  status?: number;
  headers?: Record<string, string>;
  scripts: UrlFact[];
  frames: FrameFact[];
  elements: ElementFact[];
  tokens: TokenFact[];
}

/** What the serialized page-side probe returns. */
export interface ChallengePageFacts {
  page_origin: string;
  scripts: UrlFact[];
  frames: FrameFact[];
  elements: ElementFact[];
  tokens: TokenFact[];
}

// ---------------------------------------------------------------------------
// Event model (schemas/rpc/v1/challenge.schema.json)
// ---------------------------------------------------------------------------

export type ChallengeState = "active" | "cleared" | "superseded";
export type ChallengeNext = "wait" | "handoff" | "retry_later" | "stop" | "none";
export type SurfaceScope = "document" | "frame" | "element";

export interface ChallengeSurface {
  scope: SurfaceScope;
  frame_id?: string;
  frame_origin?: string;
  visible: boolean;
}

export interface ChallengeEvent {
  spec_version: 1;
  challenge_id: string;
  tab_id: number;
  page_revision: number;
  first_page_revision: number;
  first_detected_at_ms: number;
  detected_at_ms: number;
  page_origin: string;
  vendor: string;
  product: string;
  kind: ChallengeKind;
  interaction: ChallengeInteraction;
  state: ChallengeState;
  confidence: ChallengeConfidence;
  surface: ChallengeSurface;
  token_present?: boolean;
  signals: string[];
  next: ChallengeNext;
  wait_budget_ms?: number;
  retry_after_ms?: number;
  detector: { catalog_version: string; probe: ChallengeProbe };
}

export type ScopeClass = "document" | "embedded";

export interface ChallengeEpisode extends ChallengeEvent {
  task_id: string;
  scope_class: ScopeClass;
  /** Catalog automatic-clear budget of the signature that last matched. */
  budget_ms?: number;
  /** False when every matched rule was header/status-only, so a scripting scan cannot observe its absence. Never emitted. */
  observable_by_scripting?: boolean;
  terminal_reported: boolean;
}

export const CHALLENGE_SPEC_VERSION = 1;
export const CHALLENGE_EPISODE_TTL_MS = 15 * 60_000;
export const CHALLENGE_MAX_EPISODES_PER_TASK = 32;
export const CHALLENGE_MIN_WAIT_MS = 1_000;
export const CHALLENGE_MAX_RETRY_AFTER_MS = 86_400_000;

const MAX_SIGNALS = 16;
const ORIGIN_PATTERN = /^https?:\/\/[^/?#\s]+$/;
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuv";
const ID_PATTERN = /^chl_[0-9a-z]{20}$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function scopeClassOf(kind: ChallengeKind): ScopeClass {
  return kind === "interstitial" || kind === "block" || kind === "rate_limit" ? "document" : "embedded";
}

/** Returns `value` only when it is a bare http(s) origin that the schema accepts. */
export function sanitizeOrigin(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 2048 && ORIGIN_PATTERN.test(value) ? value : undefined;
}

/** `chl_` plus 20 characters of 5 random bits each (100 bits). */
export function newChallengeId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let id = "chl_";
  for (const byte of bytes) id += ID_ALPHABET[byte & 31];
  return id;
}

/** Parses a `Retry-After` header: delta-seconds or an HTTP-date. Clamped to 0..24 h; undefined when absent or invalid. */
export function retryAfterMs(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else if (/[a-z]{3}/i.test(trimmed)) {
    const at = Date.parse(trimmed);
    if (!Number.isFinite(at)) return undefined;
    ms = at - nowMs;
  } else {
    return undefined;
  }
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(CHALLENGE_MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}

const CONFIDENCE_RANK: Record<ChallengeConfidence, number> = { high: 3, medium: 2, low: 1 };
const KIND_RANK: Record<ChallengeKind, number> = {
  block: 5,
  rate_limit: 4,
  interstitial: 3,
  puzzle: 2,
  widget: 1,
};

// ---------------------------------------------------------------------------
// Catalog traversal helpers for probes
// ---------------------------------------------------------------------------

function walk(condition: Condition, visit: (leaf: Condition) => void): void {
  if ("all" in condition) {
    for (const child of condition.all) walk(child, visit);
  } else if ("any" in condition) {
    for (const child of condition.any) walk(child, visit);
  } else if ("not" in condition) {
    walk(condition.not, visit);
  } else {
    visit(condition);
  }
}

/** Distinct element selectors of enabled signatures, in catalog order. */
export function catalogSelectors(catalog: ChallengeCatalog): string[] {
  const selectors = new Set<string>();
  for (const signature of catalog.signatures) {
    if (!signature.enabled) continue;
    for (const rule of signature.signals) {
      walk(rule.when, (leaf) => {
        if ("element" in leaf) selectors.add(leaf.element.selector);
      });
    }
  }
  return [...selectors];
}

/** Distinct token-field selectors of enabled signatures. */
export function catalogTokenSelectors(catalog: ChallengeCatalog): string[] {
  const selectors = new Set<string>();
  for (const signature of catalog.signatures) {
    if (signature.enabled && signature.token_field !== undefined) selectors.add(signature.token_field);
  }
  return [...selectors];
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  const normalized = suffix.toLowerCase().replace(/^\./, "");
  return normalized.length > 0 && (host === normalized || host.endsWith(`.${normalized}`));
}

function hostMatchesLeaf(host: string, leaf: { host?: string[]; host_suffix?: string[] }): boolean {
  if (leaf.host === undefined && leaf.host_suffix === undefined) return true;
  const lower = host.toLowerCase();
  return (
    (leaf.host?.some((candidate) => candidate.toLowerCase() === lower) ?? false) ||
    (leaf.host_suffix?.some((suffix) => hostMatchesSuffix(lower, suffix)) ?? false)
  );
}

/** True when an enabled signature has a frame leaf whose host constraint admits `host`. */
export function frameOfInterest(catalog: ChallengeCatalog, host: string): boolean {
  let interesting = false;
  for (const signature of catalog.signatures) {
    if (!signature.enabled) continue;
    for (const rule of signature.signals) {
      walk(rule.when, (leaf) => {
        if ("frame" in leaf && hostMatchesLeaf(host, leaf.frame)) interesting = true;
      });
    }
  }
  return interesting;
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

interface Evaluation {
  ok: boolean;
  frames: FrameFact[];
  elements: ElementFact[];
}

function evaluation(ok: boolean, frames: FrameFact[] = [], elements: ElementFact[] = []): Evaluation {
  return { ok, frames, elements };
}

function frameMatches(frame: FrameFact, leaf: FrameLeaf): boolean {
  if (!hostMatchesLeaf(frame.host, leaf)) return false;
  if (leaf.path_prefix !== undefined && !leaf.path_prefix.some((prefix) => frame.path.startsWith(prefix))) {
    return false;
  }
  if (leaf.query_absent !== undefined && frame.query[leaf.query_absent.name] === leaf.query_absent.equals) {
    return false;
  }
  if (leaf.query_equals !== undefined && frame.query[leaf.query_equals.name] !== leaf.query_equals.equals) {
    return false;
  }
  return true;
}

function union<T>(lists: T[][]): T[] {
  return [...new Set(lists.flat())];
}

function evaluate(condition: Condition, facts: ProbeFacts): Evaluation {
  if ("header" in condition) {
    const actual = facts.headers?.[condition.header.name.toLowerCase()];
    return evaluation(
      actual !== undefined && actual.trim().toLowerCase() === condition.header.equals.toLowerCase(),
    );
  }
  if ("status" in condition) {
    return evaluation(facts.status !== undefined && condition.status.in.includes(facts.status));
  }
  if ("frame" in condition) {
    const frames = facts.frames.filter((frame) => frameMatches(frame, condition.frame));
    return evaluation(frames.length > 0, frames);
  }
  if ("script" in condition) {
    const leaf = condition.script;
    const ok = facts.scripts.some(
      (script) =>
        (leaf.host_suffix === undefined || hostMatchesLeaf(script.host, { host_suffix: leaf.host_suffix })) &&
        leaf.path_contains.every((part) => script.path.includes(part)),
    );
    return evaluation(ok);
  }
  if ("element" in condition) {
    const elements = facts.elements.filter(
      (element) => element.selector === condition.element.selector && element.count > 0,
    );
    return evaluation(elements.length > 0, [], elements);
  }
  if ("all" in condition) {
    const parts = condition.all.map((child) => evaluate(child, facts));
    if (!parts.every((part) => part.ok)) return evaluation(false);
    return evaluation(true, union(parts.map((part) => part.frames)), union(parts.map((part) => part.elements)));
  }
  if ("any" in condition) {
    const parts = condition.any.map((child) => evaluate(child, facts)).filter((part) => part.ok);
    if (parts.length === 0) return evaluation(false);
    return evaluation(true, union(parts.map((part) => part.frames)), union(parts.map((part) => part.elements)));
  }
  return evaluation(!evaluate(condition.not, facts).ok);
}

// ---------------------------------------------------------------------------
// Detection: gate, suppression, precedence
// ---------------------------------------------------------------------------

export interface Detection {
  signature: Signature;
  signals: string[];
  confidence: ChallengeConfidence;
  surface: ChallengeSurface;
  token_present?: boolean;
  /** Raw `Retry-After` header; internal only, parsed by `advance`. Present for rate_limit detections. */
  retry_after_header?: string;
  /** True when a matched rule contains a frame, script, or element leaf. Internal only; never emitted. */
  observable_by_scripting: boolean;
}

export interface Presence {
  signature_id: string;
  vendor: string;
  token_present?: boolean;
}

export interface DetectResult {
  primary?: Detection;
  presence: Presence[];
}

function sizeFits(signature: Signature, width: number, height: number): boolean {
  const { min_size: min, max_size: max } = signature;
  if (min !== undefined && (width < min.width || height < min.height)) return false;
  if (max?.width !== undefined && width > max.width) return false;
  if (max?.height !== undefined && height > max.height) return false;
  return true;
}

function frameSurface(signature: Signature, frames: FrameFact[]): ChallengeSurface | undefined {
  for (const frame of frames) {
    if (!frame.visible || !sizeFits(signature, frame.width, frame.height)) continue;
    const origin = sanitizeOrigin(frame.origin);
    if (frame.frame_id !== undefined && frame.frame_id.length > 0 && frame.frame_id.length <= 256 && origin !== undefined) {
      return { scope: "frame", frame_id: frame.frame_id, frame_origin: origin, visible: true };
    }
    // A light-DOM iframe the scripting probe could not tie to a CDP frame id: the iframe element is the surface.
    return { scope: "element", ...(origin !== undefined ? { frame_origin: origin } : {}), visible: true };
  }
  return undefined;
}

/** Every distinct selector must have a visible, size-conforming match. */
function elementSurface(signature: Signature, elements: ElementFact[]): ChallengeSurface | undefined {
  if (elements.length === 0) return undefined;
  const qualifies = new Map<string, boolean>();
  for (const element of elements) {
    const ok = element.visible && sizeFits(signature, element.width, element.height);
    qualifies.set(element.selector, (qualifies.get(element.selector) ?? false) || ok);
  }
  return [...qualifies.values()].every(Boolean) ? { scope: "element", visible: true } : undefined;
}

/** True when the condition holds a frame, script, or element leaf: something the scripting probe can observe. */
function hasPageLeaf(condition: Condition): boolean {
  let found = false;
  walk(condition, (leaf) => {
    if ("frame" in leaf || "script" in leaf || "element" in leaf) found = true;
  });
  return found;
}

interface Match {
  signature: Signature;
  signals: string[];
  confidence: ChallengeConfidence;
  observable: boolean;
  frames: FrameFact[];
  elements: ElementFact[];
}

function isGeneric(signature: Signature): boolean {
  return signature.id.startsWith("generic.");
}

function tokenState(signature: Signature, facts: ProbeFacts): boolean | undefined {
  if (signature.token_field === undefined) return undefined;
  return facts.tokens.some((token) => token.selector === signature.token_field && token.non_empty);
}

function gate(match: Match, facts: ProbeFacts): ChallengeSurface | undefined {
  const { signature } = match;
  let surface: ChallengeSurface | undefined;
  switch (signature.active_when) {
    case "never":
      return undefined;
    case "document":
      surface = { scope: "document", visible: true };
      break;
    case "visible_frame":
      surface = frameSurface(signature, match.frames);
      break;
    case "visible_element":
      surface = elementSurface(signature, match.elements);
      break;
    case "widget_unsolved":
      surface = frameSurface(signature, match.frames) ?? elementSurface(signature, match.elements);
      if (surface !== undefined && tokenState(signature, facts) === true) return undefined;
      break;
  }
  if (surface === undefined) return undefined;
  return scopeClassOf(signature.kind) === "document" ? { scope: "document", visible: true } : surface;
}

export function detect(catalog: ChallengeCatalog, facts: ProbeFacts): DetectResult {
  const matches: Match[] = [];
  for (const signature of catalog.signatures) {
    if (!signature.enabled) continue;
    const held = signature.signals
      .map((rule) => ({ rule, result: evaluate(rule.when, facts) }))
      .filter((entry) => entry.result.ok);
    if (held.length === 0) continue;
    matches.push({
      signature,
      signals: [...new Set(held.map((entry) => entry.rule.signal))],
      confidence: held.reduce<ChallengeConfidence>(
        (best, entry) => (CONFIDENCE_RANK[entry.rule.confidence] > CONFIDENCE_RANK[best] ? entry.rule.confidence : best),
        "low",
      ),
      frames: union(held.map((entry) => entry.result.frames)),
      elements: union(held.map((entry) => entry.result.elements)),
      observable: held.some((entry) => hasPageLeaf(entry.rule.when)),
    });
  }

  const presence: Presence[] = matches.map(({ signature }) => {
    const token = tokenState(signature, facts);
    return {
      signature_id: signature.id,
      vendor: signature.vendor,
      ...(token !== undefined ? { token_present: token } : {}),
    };
  });

  const vendorMatched = matches.some((match) => !isGeneric(match.signature));
  const candidates: Array<{ match: Match; index: number; surface: ChallengeSurface }> = [];
  matches.forEach((match, index) => {
    if (vendorMatched && isGeneric(match.signature)) return;
    const surface = gate(match, facts);
    if (surface !== undefined) candidates.push({ match, index, surface });
  });
  if (candidates.length === 0) return { presence };

  candidates.sort(
    (a, b) =>
      KIND_RANK[b.match.signature.kind] - KIND_RANK[a.match.signature.kind] ||
      CONFIDENCE_RANK[b.match.confidence] - CONFIDENCE_RANK[a.match.confidence] ||
      a.index - b.index,
  );
  const best = candidates[0]!;
  const token = tokenState(best.match.signature, facts);
  const retryAfter = best.match.signature.kind === "rate_limit" ? facts.headers?.["retry-after"] : undefined;
  return {
    primary: {
      signature: best.match.signature,
      signals: best.match.signals,
      confidence: best.match.confidence,
      surface: best.surface,
      ...(token !== undefined ? { token_present: token } : {}),
      ...(retryAfter !== undefined ? { retry_after_header: retryAfter } : {}),
      observable_by_scripting: best.match.observable,
    },
    presence,
  };
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export interface ChallengeContext {
  taskId: string;
  tabId: number;
  pageRevision: number;
  pageOrigin: string;
  now: number;
  probe: ChallengeProbe;
  catalogVersion: string;
  newId: () => string;
}

export interface AdvanceResult {
  episodes: ChallengeEpisode[];
  event?: ChallengeEvent;
}

function refreshNext(episode: ChallengeEpisode, now: number): void {
  delete episode.wait_budget_ms;
  if (episode.state !== "active") {
    episode.next = "none";
    delete episode.retry_after_ms;
    return;
  }
  if (episode.kind === "block") {
    episode.next = "stop";
  } else if (episode.kind === "rate_limit") {
    episode.next = "retry_later";
  } else if (episode.interaction === "automatic") {
    const remaining =
      episode.budget_ms === undefined ? 0 : episode.budget_ms - (now - episode.first_detected_at_ms);
    if (remaining >= CHALLENGE_MIN_WAIT_MS) {
      episode.next = "wait";
      episode.wait_budget_ms = Math.min(120_000, Math.floor(remaining));
    } else {
      episode.next = "handoff";
    }
  } else {
    episode.next = "handoff";
  }
  if (episode.kind !== "rate_limit") delete episode.retry_after_ms;
}

function applyDetection(
  episode: ChallengeEpisode,
  detection: Detection,
  ctx: ChallengeContext,
): void {
  const { signature } = detection;
  episode.page_revision = ctx.pageRevision;
  episode.detected_at_ms = ctx.now;
  episode.page_origin = ctx.pageOrigin;
  episode.vendor = signature.vendor;
  episode.product = signature.product;
  episode.kind = signature.kind;
  episode.interaction = signature.interaction;
  episode.state = "active";
  episode.confidence = detection.confidence;
  episode.surface = { ...detection.surface };
  episode.signals = detection.signals.slice(0, MAX_SIGNALS);
  episode.scope_class = scopeClassOf(signature.kind);
  episode.detector = { catalog_version: ctx.catalogVersion, probe: ctx.probe };
  if (signature.wait_budget_ms !== undefined) episode.budget_ms = signature.wait_budget_ms;
  else delete episode.budget_ms;
  if (signature.kind === "widget" && detection.token_present !== undefined) {
    episode.token_present = detection.token_present;
  } else {
    delete episode.token_present;
  }
  const retry = signature.kind === "rate_limit" ? retryAfterMs(detection.retry_after_header, ctx.now) : undefined;
  if (retry !== undefined) episode.retry_after_ms = retry;
  else delete episode.retry_after_ms;
  episode.observable_by_scripting = detection.observable_by_scripting;
  refreshNext(episode, ctx.now);
}

function createEpisode(detection: Detection, ctx: ChallengeContext): ChallengeEpisode {
  const episode = {
    spec_version: 1,
    challenge_id: ctx.newId(),
    tab_id: ctx.tabId,
    page_revision: ctx.pageRevision,
    first_page_revision: ctx.pageRevision,
    first_detected_at_ms: ctx.now,
    detected_at_ms: ctx.now,
    task_id: ctx.taskId,
    terminal_reported: false,
  } as ChallengeEpisode;
  applyDetection(episode, detection, ctx);
  return episode;
}

/** Moves an episode to a terminal state. `touch` stamps the observation onto it, for episodes whose end is reported. */
function settle(
  episode: ChallengeEpisode,
  state: "cleared" | "superseded",
  ctx: ChallengeContext,
  touch: boolean,
): void {
  episode.state = state;
  episode.surface = { ...episode.surface, visible: false };
  if (touch) {
    episode.page_revision = ctx.pageRevision;
    episode.detected_at_ms = ctx.now;
    episode.detector = { catalog_version: ctx.catalogVersion, probe: ctx.probe };
  }
  refreshNext(episode, ctx.now);
}

export function episodeEvent(episode: ChallengeEpisode): ChallengeEvent {
  const surface: ChallengeSurface = {
    scope: episode.surface.scope,
    ...(episode.surface.frame_id !== undefined ? { frame_id: episode.surface.frame_id } : {}),
    ...(episode.surface.frame_origin !== undefined ? { frame_origin: episode.surface.frame_origin } : {}),
    visible: episode.surface.visible,
  };
  return {
    spec_version: 1,
    challenge_id: episode.challenge_id,
    tab_id: episode.tab_id,
    page_revision: episode.page_revision,
    first_page_revision: episode.first_page_revision,
    first_detected_at_ms: episode.first_detected_at_ms,
    detected_at_ms: episode.detected_at_ms,
    page_origin: episode.page_origin,
    vendor: episode.vendor,
    product: episode.product,
    kind: episode.kind,
    interaction: episode.interaction,
    state: episode.state,
    confidence: episode.confidence,
    surface,
    ...(episode.kind === "widget" && episode.token_present !== undefined
      ? { token_present: episode.token_present }
      : {}),
    signals: episode.signals.slice(0, MAX_SIGNALS),
    next: episode.next,
    ...(episode.wait_budget_ms !== undefined ? { wait_budget_ms: episode.wait_budget_ms } : {}),
    ...(episode.kind === "rate_limit" && episode.retry_after_ms !== undefined
      ? { retry_after_ms: episode.retry_after_ms }
      : {}),
    detector: {
      catalog_version: episode.detector.catalog_version,
      probe: episode.detector.probe,
    },
  };
}

function enforceCap(episodes: ChallengeEpisode[], taskId: string): ChallengeEpisode[] {
  const own = episodes.filter((episode) => episode.task_id === taskId);
  let excess = own.length - CHALLENGE_MAX_EPISODES_PER_TASK;
  if (excess <= 0) return episodes;
  const dropped = new Set<ChallengeEpisode>();
  const byAge = (a: ChallengeEpisode, b: ChallengeEpisode) => a.detected_at_ms - b.detected_at_ms;
  for (const pool of [own.filter((e) => e.state !== "active").sort(byAge), own.filter((e) => e.state === "active").sort(byAge)]) {
    for (const episode of pool) {
      if (excess <= 0) break;
      dropped.add(episode);
      excess -= 1;
    }
  }
  return episodes.filter((episode) => !dropped.has(episode));
}

/**
 * Folds one detection result into a task's episode list. `episodes` may hold the
 * task's episodes for several tabs; only `ctx.tabId` episodes are transitioned.
 * Returns the new list and at most one event: the primary's active event, else the
 * first newly ended episode (document scope before embedded). Ended episodes whose
 * event could not be reported are marked reported anyway; they never surface later.
 */
export function advance(
  episodes: readonly ChallengeEpisode[],
  result: DetectResult,
  ctx: ChallengeContext,
): AdvanceResult {
  const list = episodes.map((episode) => ({ ...episode }));

  for (const episode of list) {
    if (episode.state === "active" && ctx.now - episode.detected_at_ms > CHALLENGE_EPISODE_TTL_MS) {
      settle(episode, "superseded", ctx, false);
      episode.terminal_reported = true;
    }
  }

  const active = (scopeClass: ScopeClass) =>
    list.filter((e) => e.tab_id === ctx.tabId && e.state === "active" && e.scope_class === scopeClass);
  const silentlySupersede = (episode: ChallengeEpisode) => {
    settle(episode, "superseded", ctx, false);
    episode.terminal_reported = true;
  };

  const primary = result.primary;
  const primaryClass = primary === undefined ? undefined : scopeClassOf(primary.signature.kind);
  const ended: ChallengeEpisode[] = [];
  const endAndQueue = (episode: ChallengeEpisode, state: "cleared" | "superseded") => {
    settle(episode, state, ctx, true);
    if (state === "cleared" && episode.kind === "widget") episode.token_present = true;
    episode.terminal_reported = true;
    ended.push(episode);
  };

  // Document scope.
  if (primaryClass !== "document") {
    for (const episode of active("document")) {
      if (
        ctx.probe === "scripting" &&
        ctx.pageOrigin === episode.page_origin &&
        episode.observable_by_scripting === false
      ) {
        // Its evidence was header/status only; the scripting probe cannot see those, so a clean
        // scan proves nothing. Keep the episode active and re-emit it (detected_at and
        // page_revision stay at the last real observation; only the derived next step refreshes).
        refreshNext(episode, ctx.now);
        ended.push(episode);
        continue;
      }
      endAndQueue(episode, ctx.pageOrigin === episode.page_origin ? "cleared" : "superseded");
    }
  }
  // Embedded scope.
  if (primaryClass === "document") {
    for (const episode of active("embedded")) silentlySupersede(episode);
  } else if (primaryClass === undefined) {
    for (const episode of active("embedded")) {
      const solved =
        ctx.pageOrigin === episode.page_origin &&
        result.presence.some((entry) => entry.vendor === episode.vendor && entry.token_present === true);
      endAndQueue(episode, solved ? "cleared" : "superseded");
    }
  }

  let current: ChallengeEpisode | undefined;
  if (primary !== undefined && primaryClass !== undefined) {
    const inClass = active(primaryClass);
    const same = inClass.find(
      (episode) => episode.vendor === primary.signature.vendor && episode.page_origin === ctx.pageOrigin,
    );
    for (const episode of inClass) {
      if (episode !== same) silentlySupersede(episode);
    }
    if (same !== undefined) {
      applyDetection(same, primary, ctx);
      current = same;
    } else {
      current = createEpisode(primary, ctx);
      list.push(current);
    }
  }

  const reported = current ?? ended[0];
  const trimmed = enforceCap(list, ctx.taskId);
  return {
    episodes: trimmed,
    ...(reported !== undefined ? { event: episodeEvent(reported) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Persistence validation
// ---------------------------------------------------------------------------

const KINDS: readonly string[] = ["interstitial", "widget", "puzzle", "block", "rate_limit"];
const INTERACTIONS: readonly string[] = ["automatic", "human", "none"];
const STATES: readonly string[] = ["active", "cleared", "superseded"];
const CONFIDENCES: readonly string[] = ["high", "medium", "low"];
const NEXTS: readonly string[] = ["wait", "handoff", "retry_later", "stop", "none"];
const SCOPES: readonly string[] = ["document", "frame", "element"];
const PROBES: readonly string[] = ["debugger", "scripting"];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function nonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Rebuilds an episode from untrusted storage, or returns undefined when any field is malformed. */
export function parseChallengeEpisode(value: unknown): ChallengeEpisode | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const surfaceRaw = record(raw.surface);
  const detectorRaw = record(raw.detector);
  if (
    raw.spec_version !== 1 ||
    typeof raw.challenge_id !== "string" || !ID_PATTERN.test(raw.challenge_id) ||
    typeof raw.task_id !== "string" || raw.task_id.length === 0 ||
    !nonNegativeInt(raw.tab_id) ||
    !nonNegativeInt(raw.page_revision) ||
    !nonNegativeInt(raw.first_page_revision) ||
    !nonNegativeInt(raw.first_detected_at_ms) ||
    !nonNegativeInt(raw.detected_at_ms) ||
    sanitizeOrigin(raw.page_origin) === undefined ||
    typeof raw.vendor !== "string" || typeof raw.product !== "string" ||
    !oneOf(raw.kind, KINDS) || !oneOf(raw.interaction, INTERACTIONS) ||
    !oneOf(raw.state, STATES) || !oneOf(raw.confidence, CONFIDENCES) ||
    !oneOf(raw.next, NEXTS) ||
    !oneOf(raw.scope_class, ["document", "embedded"]) ||
    typeof raw.terminal_reported !== "boolean" ||
    surfaceRaw === undefined || !oneOf(surfaceRaw.scope, SCOPES) || typeof surfaceRaw.visible !== "boolean" ||
    (surfaceRaw.frame_id !== undefined && typeof surfaceRaw.frame_id !== "string") ||
    (surfaceRaw.frame_origin !== undefined && sanitizeOrigin(surfaceRaw.frame_origin) === undefined) ||
    !Array.isArray(raw.signals) || raw.signals.length === 0 || raw.signals.length > MAX_SIGNALS ||
    !raw.signals.every((signal) => typeof signal === "string") ||
    detectorRaw === undefined || typeof detectorRaw.catalog_version !== "string" || !oneOf(detectorRaw.probe, PROBES) ||
    (raw.token_present !== undefined && typeof raw.token_present !== "boolean") ||
    (raw.wait_budget_ms !== undefined && !nonNegativeInt(raw.wait_budget_ms)) ||
    (raw.retry_after_ms !== undefined && !nonNegativeInt(raw.retry_after_ms)) ||
    (raw.budget_ms !== undefined && !nonNegativeInt(raw.budget_ms)) ||
    (raw.observable_by_scripting !== undefined && typeof raw.observable_by_scripting !== "boolean")
  ) {
    return undefined;
  }
  const episode = {
    spec_version: 1,
    challenge_id: raw.challenge_id,
    tab_id: raw.tab_id,
    page_revision: raw.page_revision,
    first_page_revision: raw.first_page_revision,
    first_detected_at_ms: raw.first_detected_at_ms,
    detected_at_ms: raw.detected_at_ms,
    page_origin: raw.page_origin,
    vendor: raw.vendor,
    product: raw.product,
    kind: raw.kind,
    interaction: raw.interaction,
    state: raw.state,
    confidence: raw.confidence,
    surface: {
      scope: surfaceRaw.scope,
      ...(typeof surfaceRaw.frame_id === "string" ? { frame_id: surfaceRaw.frame_id } : {}),
      ...(typeof surfaceRaw.frame_origin === "string" ? { frame_origin: surfaceRaw.frame_origin } : {}),
      visible: surfaceRaw.visible,
    },
    ...(typeof raw.token_present === "boolean" ? { token_present: raw.token_present } : {}),
    signals: [...(raw.signals as string[])],
    next: raw.next,
    ...(typeof raw.wait_budget_ms === "number" ? { wait_budget_ms: raw.wait_budget_ms } : {}),
    ...(typeof raw.retry_after_ms === "number" ? { retry_after_ms: raw.retry_after_ms } : {}),
    detector: { catalog_version: detectorRaw.catalog_version, probe: detectorRaw.probe },
    task_id: raw.task_id,
    scope_class: raw.scope_class,
    ...(typeof raw.budget_ms === "number" ? { budget_ms: raw.budget_ms } : {}),
    observable_by_scripting: raw.observable_by_scripting !== false,
    terminal_reported: raw.terminal_reported,
  } as ChallengeEpisode;
  return episode;
}

// ---------------------------------------------------------------------------
// Page-side probe
// ---------------------------------------------------------------------------

/**
 * Runs inside the page (isolated world, top frame) through chrome.scripting.executeScript.
 * It is serialized, so it MUST NOT reference anything outside its own body. Read-only:
 * no input, focus, scroll, or DOM writes. Only URLs' host/path/query, selector counts,
 * sizes, visibility, and token-field emptiness booleans leave the page; token values never do.
 */
export function collectChallengeFacts(selectors: string[], tokenSelectors: string[]): ChallengePageFacts {
  const maxScripts = 128;
  const maxFrames = 64;
  const maxMatches = 64;
  const maxQuery = 32;
  const root = document.documentElement;
  const maxX = Math.max(root ? root.scrollWidth : 0, window.innerWidth);
  const maxY = Math.max(root ? root.scrollHeight : 0, window.innerHeight);
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  const measure = (element: Element): { visible: boolean; width: number; height: number } => {
    let shown = true;
    try {
      shown =
        typeof element.checkVisibility === "function"
          ? element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
          : (() => {
              const style = window.getComputedStyle(element);
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number.parseFloat(style.opacity) > 0
              );
            })();
    } catch {
      shown = false;
    }
    const rect = element.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (!shown || !(rect.width > 0) || !(rect.height > 0)) return { visible: false, width, height };
    const left = rect.left + scrollX;
    const top = rect.top + scrollY;
    const inside = left + rect.width > 0 && top + rect.height > 0 && left < maxX && top < maxY;
    return { visible: inside, width, height };
  };

  const parse = (raw: string | null): { host: string; path: string; query: Record<string, string>; origin: string } | null => {
    if (!raw) return null;
    try {
      const url = new URL(raw, document.baseURI);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      const query: Record<string, string> = Object.create(null);
      let count = 0;
      url.searchParams.forEach((value, key) => {
        if (count >= maxQuery || Object.prototype.hasOwnProperty.call(query, key)) return;
        query[key] = value.slice(0, 64);
        count += 1;
      });
      return { host: url.hostname.toLowerCase(), path: url.pathname, query, origin: url.origin };
    } catch {
      return null;
    }
  };

  const scripts: UrlFact[] = [];
  const scriptNodes = document.scripts;
  for (let index = 0; index < scriptNodes.length && scripts.length < maxScripts; index += 1) {
    const parsed = parse(scriptNodes[index]!.src);
    if (parsed) scripts.push({ host: parsed.host, path: parsed.path, query: {} });
  }

  const frames: FrameFact[] = [];
  const frameNodes = document.querySelectorAll("iframe");
  for (let index = 0; index < frameNodes.length && frames.length < maxFrames; index += 1) {
    const node = frameNodes[index]!;
    const parsed = parse(node.src || node.getAttribute("src"));
    if (!parsed) continue;
    const box = measure(node);
    frames.push({
      host: parsed.host,
      path: parsed.path,
      query: { ...parsed.query },
      origin: parsed.origin,
      visible: box.visible,
      width: box.width,
      height: box.height,
    });
  }

  const elements: ElementFact[] = selectors.map((selector) => {
    let matches: NodeListOf<Element> | null = null;
    try {
      matches = document.querySelectorAll(selector);
    } catch {
      matches = null;
    }
    if (!matches || matches.length === 0) return { selector, count: 0, visible: false, width: 0, height: 0 };
    for (let index = 0; index < matches.length && index < maxMatches; index += 1) {
      const box = measure(matches[index]!);
      if (box.visible) return { selector, count: matches.length, visible: true, width: box.width, height: box.height };
    }
    return { selector, count: matches.length, visible: false, width: 0, height: 0 };
  });

  const tokens: TokenFact[] = tokenSelectors.map((selector) => {
    let matches: NodeListOf<Element> | null = null;
    try {
      matches = document.querySelectorAll(selector);
    } catch {
      matches = null;
    }
    let nonEmpty = false;
    if (matches) {
      for (let index = 0; index < matches.length && index < maxMatches; index += 1) {
        const value = (matches[index] as HTMLInputElement | HTMLTextAreaElement).value;
        if (typeof value === "string" && value.length > 0) nonEmpty = true;
      }
    }
    return { selector, present: Boolean(matches && matches.length > 0), non_empty: nonEmpty };
  });

  return { page_origin: window.location.origin, scripts, frames, elements, tokens };
}
