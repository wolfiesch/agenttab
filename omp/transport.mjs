import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class BridgeError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "BridgeError";
    this.details = details;
  }
}

export class BridgeTransport {
  constructor(options = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? Number(process.env.BRIDGE_PORT ?? 9223);
    this.tokenFile = options.tokenFile;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.socket = undefined;
    this.queue = Promise.resolve();
  }

  async close() {
    this.socket?.destroy();
    this.socket = undefined;
  }

  async ready(timeoutMs = 5_000, pollIntervalMs = 250) {
    const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 30_000));
    let attempts = 0;
    let reason = "browser unavailable";
    do {
      attempts += 1;
      try {
        const result = await this.call("ping", {}, { timeoutMs: Math.max(100, deadline - Date.now()) });
        if (result === "pong") {
          return {
            ready: true,
            endpoint: `${this.host}:${this.port}`,
            extension: "connected",
            attempts,
          };
        }
        reason = `unexpected ping response: ${JSON.stringify(result)}`;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        await this.close();
      }
      if (Date.now() < deadline) {
        await new Promise((accept) => setTimeout(accept, Math.min(pollIntervalMs, deadline - Date.now())));
      }
    } while (Date.now() < deadline);
    return {
      ready: false,
      endpoint: `${this.host}:${this.port}`,
      extension: "unavailable",
      attempts,
      reason,
    };
  }

  call(action, payload = {}, options = {}) {
    const pending = this.queue.then(() => this.#call(action, payload, options));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async #call(action, payload, options) {
    const token = await this.#loadToken();
    const socket = await this.#connect();
    const command = {
      action,
      payload,
      token,
      traceparent: traceparent(),
      ...(options.confirmationToken ? { confirmationToken: options.confirmationToken } : {}),
      ...(options.dryRun ? { dryRun: true } : {}),
    };
    const timeoutMs = Math.max(100, options.timeoutMs ?? payload.timeoutMs ?? 30_000);
    const response = await this.#exchange(socket, command, timeoutMs);
    if (response.success !== true) {
      if (response.error === "unauthorized" || response.status === "browser_unavailable") {
        await this.close();
      }
      const denial = response.policyDenial;
      const remediation = denial && typeof denial.remediation === "string" ? ` ${denial.remediation}` : "";
      throw new BridgeError(`${response.error ?? "Bridge reported failure."}${remediation}`, denial);
    }
    if (response.dryRun === true) {
      const { success: _success, ...result } = response;
      return result;
    }
    const result = response.result;
    if (result && typeof result === "object" && result.success === false) {
      throw new BridgeError(result.err ?? "Extension action failed.", result);
    }
    return result;
  }

  async #loadToken() {
    const configured = this.tokenFile ?? process.env.BRIDGE_TOKEN_FILE;
    const root = await realpath(MODULE_ROOT);
    const path = configured ?? resolve(root, "bridge_token.txt");
    let token;
    try {
      token = (await readFile(path, "utf8")).trim();
    } catch (error) {
      throw new BridgeError(`Could not read Chrome Bridge token at ${path}: ${error.message}`);
    }
    if (!token) throw new BridgeError(`Chrome Bridge token is empty at ${path}.`);
    return token;
  }

  async #connect() {
    if (this.socket && !this.socket.destroyed) return this.socket;
    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    await new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new BridgeError(`Timed out connecting to Chrome Bridge at ${this.host}:${this.port}.`));
      }, this.connectTimeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        accept();
      });
      const onError = (error) => {
        clearTimeout(timer);
        reject(new BridgeError(`Chrome Bridge is unavailable at ${this.host}:${this.port}: ${error.message}`));
      };
      socket.once("error", onError);
    });
    socket.on("error", () => {
      socket.destroy();
      if (this.socket === socket) this.socket = undefined;
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
    });
    this.socket = socket;
    return socket;
  }

  #exchange(socket, command, timeoutMs) {
    return new Promise((accept, reject) => {
      const chunks = [];
      let total = 0;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const fail = (message) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        if (this.socket === socket) this.socket = undefined;
        reject(new BridgeError(message));
      };
      const onError = (error) => fail(`Chrome Bridge connection failed after send; the action was not replayed: ${error.message}`);
      const onClose = () => fail("Chrome Bridge closed the connection after send; the action was not replayed.");
      const onData = (chunk) => {
        const newline = chunk.indexOf(10);
        if (newline === -1) {
          chunks.push(chunk);
          total += chunk.length;
          return;
        }
        chunks.push(chunk.subarray(0, newline));
        total += newline;
        if (chunk.subarray(newline + 1).some((byte) => byte > 32)) {
          fail("Chrome Bridge returned more than one response for a single request.");
          return;
        }
        let response;
        try {
          response = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
        } catch (error) {
          fail(`Chrome Bridge returned invalid JSON: ${error.message}`);
          return;
        }
        settled = true;
        cleanup();
        accept(response);
      };
      const timer = setTimeout(
        () => fail(`Timed out after ${timeoutMs}ms waiting for Chrome Bridge; the action was not replayed.`),
        timeoutMs,
      );
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) fail(`Could not send to Chrome Bridge; the action was not replayed: ${error.message}`);
      });
    });
  }
}

function traceparent() {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
