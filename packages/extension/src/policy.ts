import {
  policyAllowanceKey,
  type ExtensionState,
  type PolicyAllowance,
  type PolicyAllowanceScope,
  type PolicyEffect,
} from "./storage";

export type PolicyRememberScope = "once" | PolicyAllowanceScope;

const EFFECT_PATTERNS: ReadonlyArray<readonly [PolicyEffect, RegExp]> = [
  // Financial wins when a control has multiple verbs (for example,
  // "Send payment"), so a communication allowance cannot authorize money movement.
  ["financial", /\b(buy|purchase|pay|payment|transfer|place order|checkout|submit order|confirm order)\b/i],
  ["destructive", /\b(delete|remove|revoke|unsubscribe|cancel subscription)\b/i],
  ["authorization", /\b(approve|authorize|grant|permission)\b/i],
  ["external_communication", /\b(send|publish|post|deploy|merge)\b/i],
];

export function classifyControlEffect(label: string): PolicyEffect | null {
  for (const [effect, pattern] of EFFECT_PATTERNS) {
    if (pattern.test(label)) return effect;
  }
  return null;
}

export function policyOrigin(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function hasAllowance(
  state: ExtensionState,
  taskId: string,
  origin: string | undefined,
  effect: PolicyEffect,
): boolean {
  return (
    Object.hasOwn(state.policyAllowances, policyAllowanceKey("task", effect, taskId)) ||
    (origin !== undefined &&
      Object.hasOwn(state.policyAllowances, policyAllowanceKey("domain", effect, undefined, origin))) ||
    Object.hasOwn(state.policyAllowances, policyAllowanceKey("effect", effect))
  );
}

export function policyRequiresReview(
  state: ExtensionState,
  taskId: string,
  origin: string | undefined,
  effect: PolicyEffect,
): boolean {
  if (state.policyProfile === "autopilot") return false;
  if (hasAllowance(state, taskId, origin, effect)) return false;
  return state.policyProfile === "strict" || effect !== "owned_tab_close";
}

export function rememberPolicyAllowance(
  state: ExtensionState,
  scope: Exclude<PolicyRememberScope, "once">,
  taskId: string,
  origin: string | undefined,
  effect: PolicyEffect,
  createdAt = Date.now(),
): PolicyAllowance {
  if (scope === "domain" && origin === undefined) {
    throw Object.assign(new Error("This review has no HTTP or HTTPS site to remember"), {
      code: "policy_scope_unavailable",
    });
  }
  const allowance: PolicyAllowance = {
    scope,
    effect,
    createdAt,
    ...(scope === "task" ? { taskId } : {}),
    ...(scope === "domain" ? { origin } : {}),
  };
  const key = policyAllowanceKey(scope, effect, allowance.taskId, allowance.origin);
  if (!Object.hasOwn(state.policyAllowances, key) && Object.keys(state.policyAllowances).length >= 256) {
    const oldest = Object.entries(state.policyAllowances)
      .sort(([, left], [, right]) => left.createdAt - right.createdAt)[0];
    if (oldest) delete state.policyAllowances[oldest[0]];
  }
  state.policyAllowances[key] = allowance;
  return allowance;
}
