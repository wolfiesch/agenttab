import { Type } from "typebox";
import {
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_DIMENSION,
  SNAPSHOT_TEXT_MAX_BYTES,
  STANDARD_ACTION_VALUE_MAX_CHARS,
  STANDARD_PRESS_KEYS,
} from "../../sdk-typescript/src/index";
import type { ToolMethod } from "./tool-method";

const stringEnum = (values: readonly string[]) => Type.String({ enum: [...values] });
const object = (properties: Record<string, unknown>) => {
  // TypeBox validates each property builder at construction; preserve that runtime contract across this dynamic schema map.
  const typedProperties = properties as unknown as Parameters<typeof Type.Object>[0];
  return Type.Object(typedProperties, { additionalProperties: false });
};
const ref = () => Type.String({ minLength: 1, maxLength: 256 });
const selector = () => Type.String({ minLength: 1, maxLength: 2048 });

const schemas: Record<ToolMethod, unknown> = {
  browser_open: Type.Union([
    object({
      mode: Type.Literal("create"),
      url: Type.Optional(Type.String({ pattern: "^(https?://|about:)[^\\s]+$" })),
      placement: Type.Optional(Type.Literal("task")),
      background: Type.Optional(Type.Boolean()),
    }),
    object({
      mode: Type.Literal("create"),
      url: Type.Optional(Type.String({ pattern: "^(https?://|about:)[^\\s]+$" })),
      placement: Type.Literal("new_window"),
      background: Type.Optional(Type.Literal(true)),
    }),
    object({ mode: Type.Literal("adopt_active") }),
  ]),
  browser_snapshot: Type.Union([
    object({ tab_id: Type.Integer({ minimum: 0 }), mode: Type.Literal("accessibility"), frame_id: Type.Optional(ref()), root_ref: Type.Optional(ref()), max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), max_nodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) }),
    object({ tab_id: Type.Integer({ minimum: 0 }), mode: stringEnum(["text", "html"]), frame_id: Type.Optional(ref()), selector: Type.Optional(selector()), match: Type.Optional(stringEnum(["first", "last"])), max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: SNAPSHOT_TEXT_MAX_BYTES })) }),
    object({ tab_id: Type.Integer({ minimum: 0 }), mode: Type.Literal("screenshot"), frame_id: Type.Optional(ref()), selector: Type.Optional(selector()), full_page: Type.Optional(Type.Boolean()), format: Type.Optional(stringEnum(["png", "jpeg", "webp"])), quality: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })), max_width: Type.Optional(Type.Integer({ minimum: 1, maximum: SCREENSHOT_MAX_DIMENSION })), max_height: Type.Optional(Type.Integer({ minimum: 1, maximum: SCREENSHOT_MAX_DIMENSION })), max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: SCREENSHOT_MAX_BYTES })) }),
  ]),
  browser_act: object({
    tab_id: Type.Integer({ minimum: 0 }),
    expected_page_revision: Type.Integer({ minimum: 0 }),
    actions: Type.Array(Type.Union([
      object({ kind: stringEnum(["click", "double_click", "context_click"]), ref: ref(), frame_id: Type.Optional(ref()), expect_download: Type.Optional(Type.Boolean()) }),
      object({ kind: stringEnum(["click", "double_click", "context_click"]), selector: selector(), frame_id: Type.Optional(ref()), expect_download: Type.Optional(Type.Boolean()) }),
      object({ kind: Type.Literal("hover"), ref: ref(), frame_id: Type.Optional(ref()) }),
      object({ kind: Type.Literal("hover"), selector: selector(), frame_id: Type.Optional(ref()) }),
      object({ kind: Type.Literal("press"), ref: ref(), frame_id: Type.Optional(ref()), expect_download: Type.Optional(Type.Boolean()), key: stringEnum(STANDARD_PRESS_KEYS), modifiers: Type.Optional(Type.Array(stringEnum(["Alt", "Control", "Meta", "Shift"]), { maxItems: 4, uniqueItems: true })) }),
      object({ kind: Type.Literal("press"), selector: selector(), frame_id: Type.Optional(ref()), expect_download: Type.Optional(Type.Boolean()), key: stringEnum(STANDARD_PRESS_KEYS), modifiers: Type.Optional(Type.Array(stringEnum(["Alt", "Control", "Meta", "Shift"]), { maxItems: 4, uniqueItems: true })) }),
      object({ kind: Type.Literal("type"), ref: ref(), frame_id: Type.Optional(ref()), text: Type.String({ maxLength: STANDARD_ACTION_VALUE_MAX_CHARS }) }),
      object({ kind: Type.Literal("type"), selector: selector(), frame_id: Type.Optional(ref()), text: Type.String({ maxLength: STANDARD_ACTION_VALUE_MAX_CHARS }) }),
      object({ kind: Type.Literal("fill"), ref: ref(), frame_id: Type.Optional(ref()), text: Type.String({ maxLength: STANDARD_ACTION_VALUE_MAX_CHARS }) }),
      object({ kind: Type.Literal("fill"), selector: selector(), frame_id: Type.Optional(ref()), text: Type.String({ maxLength: STANDARD_ACTION_VALUE_MAX_CHARS }) }),
      object({ kind: Type.Literal("select"), ref: ref(), frame_id: Type.Optional(ref()), value: Type.String({ maxLength: STANDARD_ACTION_VALUE_MAX_CHARS }) }),
      object({ kind: Type.Literal("scroll"), ref: Type.Optional(ref()), frame_id: Type.Optional(ref()), delta_x: Type.Integer({ minimum: -100_000, maximum: 100_000 }), delta_y: Type.Integer({ minimum: -100_000, maximum: 100_000 }) }),
      object({ kind: Type.Literal("drag"), ref: ref(), target_ref: ref(), frame_id: Type.Optional(ref()) }),
      object({ kind: Type.Literal("navigate"), url: Type.String({ maxLength: 2048, pattern: "^(https?://|about:)[^\\s]+$" }), expect_download: Type.Optional(Type.Boolean()) }),
      object({ kind: Type.Literal("go_back"), expect_download: Type.Optional(Type.Boolean()) }),
      object({ kind: Type.Literal("go_forward"), expect_download: Type.Optional(Type.Boolean()) }),
      object({ kind: Type.Literal("reload"), bypass_cache: Type.Optional(Type.Boolean()), expect_download: Type.Optional(Type.Boolean()) }),
      object({ kind: Type.Literal("close") }),
      object({ kind: Type.Literal("dialog"), decision: Type.Literal("accept"), prompt_text: Type.Optional(Type.String({ maxLength: 4096 })) }),
      object({ kind: Type.Literal("dialog"), decision: Type.Literal("dismiss") }),
      object({ kind: Type.Literal("upload_file"), ref: ref(), frame_id: Type.Optional(ref()), files: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 4 }) }),
      object({ kind: Type.Literal("upload_file"), selector: selector(), frame_id: Type.Optional(ref()), files: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 4 }) }),
    ]), { minItems: 1, maxItems: 64 }),
  }),
  browser_wait: object({
    tab_id: Type.Integer({ minimum: 0 }),
    condition: Type.Union([
      object({ kind: stringEnum(["load", "network_idle"]) }),
      object({ kind: Type.Literal("download"), after: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }),
      object({ kind: stringEnum(["url", "text"]), value: Type.String({ minLength: 1, maxLength: 2048 }) }),
      object({ kind: Type.Literal("selector"), value: Type.String({ minLength: 1, maxLength: 2048 }), state: Type.Optional(stringEnum(["attached", "detached", "visible", "hidden", "enabled"])), frame_id: Type.Optional(ref()) }),
      object({ kind: Type.Literal("value"), selector: selector(), value: Type.String({ maxLength: STANDARD_ACTION_VALUE_MAX_CHARS }), frame_id: Type.Optional(ref()) }),
    ]),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
  }),
  browser_tabs: object({}),
  browser_handoff: Type.Union([
    object({
      operation: Type.Literal("request"),
      tab_id: Type.Integer({ minimum: 0 }),
      expected_page_revision: Type.Integer({ minimum: 0 }),
      prompt: Type.String({ minLength: 1, maxLength: 2000 }),
      completion: Type.Optional(object({
        kind: stringEnum(["url", "selector"]),
        value: Type.String({ minLength: 1, maxLength: 65_536 }),
      })),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 900_000 })),
    }),
    object({
      operation: stringEnum(["status", "resolve", "dismiss"]),
      notice_id: Type.String({ minLength: 1, maxLength: 256 }),
    }),
  ]),
  browser_credentials: Type.Union([
    object({
      action: Type.Literal("prepare"),
      tab_id: Type.Integer({ minimum: 0 }),
      expected_page_revision: Type.Integer({ minimum: 0 }),
    }),
    object({
      action: stringEnum(["fill", "next"]),
      tab_id: Type.Integer({ minimum: 0 }),
      expected_page_revision: Type.Integer({ minimum: 0 }),
      credential_token: Type.String({ minLength: 32, maxLength: 256 }),
      username_ref: Type.Optional(ref()),
      password_ref: Type.Optional(ref()),
      otp_ref: Type.Optional(ref()),
    }),
  ]),
  browser_commit: object({ staged_token: Type.String({ minLength: 32, maxLength: 256 }) }),
  browser_finish: object({
    disposition: Type.Optional(stringEnum(["auto", "close", "keep"])),
    keep_tab_ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), {
      uniqueItems: true,
      default: [],
    })),
  }),
  browser_developer: object({
    action: Type.String({ minLength: 1, maxLength: 128 }),
    params: Type.Record(Type.String(), Type.Unknown()),
  }),
};

export function piSchema(method: ToolMethod): unknown {
  return schemas[method];
}
