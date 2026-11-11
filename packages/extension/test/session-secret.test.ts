import { describe, expect, test } from "bun:test";
import { parseSessionSecretReadParams } from "../src/protocol";

const VALID = {
  tab_id: 4,
  expected_page_revision: 9,
  allowed_origins: ["https://api.stage.example", "https://stage.example"],
  timeout_ms: 15_000,
};

describe("parseSessionSecretReadParams", () => {
  test("accepts the exact internal read the host issues", () => {
    expect(parseSessionSecretReadParams(VALID)).toEqual(VALID);
  });

  test("rejects extra fields, bad identities, and out-of-range timeouts", () => {
    for (const params of [
      { ...VALID, ref: "e4" },
      { ...VALID, tab_id: -1 },
      { ...VALID, expected_page_revision: 1.5 },
      { ...VALID, timeout_ms: 999 },
      { ...VALID, timeout_ms: 60_001 },
      { ...VALID, timeout_ms: 15_000.5 },
      { ...VALID, allowed_origins: [] },
      { ...VALID, allowed_origins: ["https://api.stage.example/path"] },
      { ...VALID, allowed_origins: ["not-an-origin"] },
      { ...VALID, expected_origin: "https://stage.example" },
    ]) {
      expect(() => parseSessionSecretReadParams(params)).toThrow();
    }
    const { timeout_ms: _omitted, ...withoutTimeout } = VALID;
    expect(() => parseSessionSecretReadParams(withoutTimeout)).toThrow();
  });
});
