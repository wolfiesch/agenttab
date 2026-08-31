import type { RpcMethod } from "../../sdk-typescript/src/index";

export type ToolMethod = Exclude<RpcMethod, "agenttab.status" | "agenttab.close">;
