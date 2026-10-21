import type { ChallengeCatalog } from "./challenge";

const RECAPTCHA_HOSTS = ["www.google.com", "www.recaptcha.net"];
const RECAPTCHA_ANCHOR_PATHS = ["/recaptcha/api2/anchor", "/recaptcha/enterprise/anchor"];
const RECAPTCHA_BFRAME_PATHS = ["/recaptcha/api2/bframe", "/recaptcha/enterprise/bframe"];
const CHALLENGE_PLATFORM = "/cdn-cgi/challenge-platform/";

/**
 * Bundled signature catalog. Catalog changes ship only in extension releases and
 * AgentTab never fetches signatures remotely. A signature needs a recorded positive
 * fixture and a look-alike negative before it ships `enabled: true`.
 */
export const CHALLENGE_CATALOG = {
  catalog_version: "2026.10.0",
  signatures: [
    {
      id: "cloudflare.challenge_page",
      enabled: true,
      vendor: "cloudflare",
      product: "challenge_page",
      kind: "interstitial",
      interaction: "automatic",
      active_when: "document",
      wait_budget_ms: 15_000,
      signals: [
        {
          signal: "cloudflare.header.cf_mitigated",
          confidence: "high",
          when: { header: { name: "cf-mitigated", equals: "challenge" } },
        },
        {
          signal: "cloudflare.script.challenge_page",
          confidence: "medium",
          when: {
            all: [
              { script: { path_contains: [CHALLENGE_PLATFORM] } },
              {
                any: [
                  { script: { path_contains: ["/orchestrate/chl_page/"] } },
                  { script: { path_contains: ["/orchestrate/jsch/"] } },
                ],
              },
            ],
          },
        },
      ],
    },
    {
      // Cloudflare JavaScript Detections load from /cdn-cgi/challenge-platform/ on ordinary pages.
      id: "cloudflare.jsd",
      enabled: true,
      vendor: "cloudflare",
      product: "jsd",
      kind: "widget",
      interaction: "automatic",
      active_when: "never",
      signals: [
        {
          signal: "cloudflare.script.jsd",
          confidence: "low",
          when: { script: { path_contains: [CHALLENGE_PLATFORM, "/scripts/jsd/"] } },
        },
      ],
    },
    {
      id: "cloudflare.turnstile",
      enabled: true,
      vendor: "cloudflare",
      product: "turnstile",
      kind: "widget",
      interaction: "automatic",
      active_when: "widget_unsolved",
      wait_budget_ms: 15_000,
      token_field: 'input[name="cf-turnstile-response"]',
      min_size: { width: 100, height: 40 },
      signals: [
        {
          signal: "cloudflare.frame.challenges_host",
          confidence: "high",
          when: { frame: { host: ["challenges.cloudflare.com"] } },
        },
        {
          signal: "cloudflare.dom.turnstile_container",
          confidence: "medium",
          when: { element: { selector: ".cf-turnstile" } },
        },
      ],
    },
    {
      id: "google_recaptcha.checkbox",
      enabled: true,
      vendor: "google_recaptcha",
      product: "checkbox",
      kind: "widget",
      interaction: "human",
      active_when: "widget_unsolved",
      token_field: 'textarea[name="g-recaptcha-response"]',
      signals: [
        {
          signal: "google_recaptcha.frame.anchor",
          confidence: "medium",
          when: {
            frame: {
              host: RECAPTCHA_HOSTS,
              path_prefix: RECAPTCHA_ANCHOR_PATHS,
              query_absent: { name: "size", equals: "invisible" },
            },
          },
        },
      ],
    },
    {
      id: "google_recaptcha.image_puzzle",
      enabled: false,
      vendor: "google_recaptcha",
      product: "image_puzzle",
      kind: "puzzle",
      interaction: "human",
      active_when: "visible_frame",
      min_size: { width: 300, height: 300 },
      signals: [
        {
          signal: "google_recaptcha.frame.bframe",
          confidence: "medium",
          when: { frame: { host: RECAPTCHA_HOSTS, path_prefix: RECAPTCHA_BFRAME_PATHS } },
        },
      ],
    },
    {
      // Passive: prevents the invisible badge and size=invisible anchor from matching the checkbox signature.
      id: "google_recaptcha.v3",
      enabled: true,
      vendor: "google_recaptcha",
      product: "v3",
      kind: "widget",
      interaction: "automatic",
      active_when: "never",
      signals: [
        {
          signal: "google_recaptcha.dom.badge",
          confidence: "low",
          when: { element: { selector: ".grecaptcha-badge" } },
        },
        {
          signal: "google_recaptcha.frame.invisible_anchor",
          confidence: "low",
          when: {
            frame: {
              host: RECAPTCHA_HOSTS,
              path_prefix: RECAPTCHA_ANCHOR_PATHS,
              query_equals: { name: "size", equals: "invisible" },
            },
          },
        },
      ],
    },
    {
      id: "hcaptcha.checkbox",
      enabled: true,
      vendor: "hcaptcha",
      product: "checkbox",
      kind: "widget",
      interaction: "human",
      active_when: "widget_unsolved",
      token_field: 'textarea[name="h-captcha-response"]',
      max_size: { height: 149 },
      signals: [
        {
          signal: "hcaptcha.frame.hcaptcha_host",
          confidence: "medium",
          when: { frame: { host_suffix: ["hcaptcha.com"] } },
        },
      ],
    },
    {
      id: "hcaptcha.puzzle",
      enabled: false,
      vendor: "hcaptcha",
      product: "puzzle",
      kind: "puzzle",
      interaction: "human",
      active_when: "visible_frame",
      min_size: { width: 300, height: 300 },
      signals: [
        {
          signal: "hcaptcha.frame.puzzle",
          confidence: "medium",
          when: { frame: { host_suffix: ["hcaptcha.com"] } },
        },
      ],
    },
    {
      id: "arkose.enforcement",
      enabled: true,
      vendor: "arkose",
      product: "enforcement",
      kind: "puzzle",
      interaction: "human",
      active_when: "visible_frame",
      min_size: { width: 300, height: 250 },
      signals: [
        {
          signal: "arkose.frame.enforcement_host",
          confidence: "medium",
          when: { frame: { host_suffix: ["arkoselabs.com", "funcaptcha.com"] } },
        },
      ],
    },
    {
      // Activity needs a visible response-page frame, but the frame is the whole challenge page: document scope.
      id: "datadome.response_page",
      enabled: true,
      vendor: "datadome",
      product: "response_page",
      kind: "interstitial",
      interaction: "human",
      active_when: "visible_frame",
      signals: [
        {
          signal: "datadome.frame.captcha_delivery",
          confidence: "medium",
          when: { frame: { host_suffix: ["captcha-delivery.com"] } },
        },
      ],
    },
    {
      id: "aws_waf.captcha",
      enabled: true,
      vendor: "aws_waf",
      product: "captcha",
      kind: "interstitial",
      interaction: "human",
      active_when: "document",
      signals: [
        {
          signal: "aws_waf.header.waf_action_captcha",
          confidence: "high",
          when: {
            all: [
              { header: { name: "x-amzn-waf-action", equals: "captcha" } },
              { status: { in: [405] } },
            ],
          },
        },
      ],
    },
    {
      id: "aws_waf.challenge",
      enabled: true,
      vendor: "aws_waf",
      product: "challenge",
      kind: "interstitial",
      interaction: "automatic",
      active_when: "document",
      wait_budget_ms: 10_000,
      signals: [
        {
          signal: "aws_waf.header.waf_action_challenge",
          confidence: "high",
          when: {
            all: [
              { header: { name: "x-amzn-waf-action", equals: "challenge" } },
              { status: { in: [202] } },
            ],
          },
        },
      ],
    },
    {
      id: "human_security.press_hold",
      enabled: false,
      vendor: "human_security",
      product: "press_hold",
      kind: "puzzle",
      interaction: "human",
      active_when: "visible_element",
      signals: [
        {
          signal: "human_security.dom.px_captcha",
          confidence: "medium",
          when: { element: { selector: "#px-captcha" } },
        },
      ],
    },
    {
      id: "geetest.captcha",
      enabled: false,
      vendor: "geetest",
      product: "captcha",
      kind: "puzzle",
      interaction: "human",
      active_when: "visible_element",
      signals: [
        {
          signal: "geetest.dom.container",
          confidence: "low",
          when: {
            all: [
              { script: { host_suffix: ["geetest.com"], path_contains: [] } },
              { element: { selector: '[class^="geetest_"]' } },
            ],
          },
        },
      ],
    },
    {
      id: "friendly_captcha.widget",
      enabled: false,
      vendor: "friendly_captcha",
      product: "widget",
      kind: "widget",
      interaction: "automatic",
      active_when: "visible_element",
      wait_budget_ms: 20_000,
      signals: [
        {
          signal: "friendly_captcha.dom.widget",
          confidence: "low",
          when: { element: { selector: ".frc-captcha" } },
        },
      ],
    },
    {
      id: "altcha.widget",
      enabled: false,
      vendor: "altcha",
      product: "widget",
      kind: "widget",
      interaction: "automatic",
      active_when: "visible_element",
      wait_budget_ms: 20_000,
      signals: [
        {
          signal: "altcha.dom.widget",
          confidence: "low",
          when: { element: { selector: "altcha-widget" } },
        },
      ],
    },
    {
      id: "anubis.interstitial",
      enabled: false,
      vendor: "anubis",
      product: "interstitial",
      kind: "interstitial",
      interaction: "automatic",
      active_when: "document",
      wait_budget_ms: 20_000,
      signals: [
        {
          signal: "anubis.script.within_website",
          confidence: "low",
          when: { script: { path_contains: ["/.within.website/"] } },
        },
      ],
    },
    {
      id: "generic.rate_limit",
      enabled: true,
      vendor: "generic",
      product: "rate_limit",
      kind: "rate_limit",
      interaction: "none",
      active_when: "document",
      signals: [
        {
          signal: "generic.status.too_many_requests",
          confidence: "high",
          when: { status: { in: [429] } },
        },
      ],
    },
    {
      id: "generic.text_captcha",
      enabled: true,
      vendor: "generic",
      product: "text_captcha",
      kind: "puzzle",
      interaction: "human",
      active_when: "visible_element",
      signals: [
        {
          signal: "generic.dom.text_captcha",
          confidence: "low",
          when: {
            all: [
              {
                element: {
                  selector: 'img[alt*="captcha" i], img[id*="captcha" i], img[src*="captcha" i]',
                },
              },
              {
                element: {
                  selector: 'input[name*="captcha" i], input[id*="captcha" i]',
                },
              },
            ],
          },
        },
      ],
    },
  ],
} satisfies ChallengeCatalog;
