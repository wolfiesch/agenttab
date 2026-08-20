//! Chrome Native Messaging host for chrome-native-bridge — Zig prototype.
//!
//! Scope: the native-host TRANSPORT layer only, matching the contract that
//! `verify_rust_host.py` certifies for `host-rs`:
//!
//!   - Chrome native-messaging framing on stdin/stdout
//!     (4-byte native-endian u32 length prefix + UTF-8 JSON).
//!   - Token-gated TCP API on 127.0.0.1:$BRIDGE_PORT (default 9223),
//!     newline-delimited JSON requests: {"action", "payload", "token"}.
//!   - Token registry parity with host-rs: legacy single token
//!     ($BRIDGE_TOKEN_FILE, default <host_dir>/bridge_token.txt) as client
//!     "default", plus optional named tokens ($BRIDGE_TOKENS_FILE, default
//!     <host_dir>/bridge_tokens.txt) with `name:token` lines, `#` comments.
//!     Deviation: token files are re-read per auth attempt instead of
//!     mtime-cached (files are <1KB; strictly fresher).
//!   - Host-only fields (`token`, `confirmationToken`, `dryRun`,
//!     `traceparent`) are stripped before forwarding; a UUIDv4 `id` is
//!     attached; responses from the extension are routed back to the
//!     originating TCP client by that id, raw bytes + '\n'.
//!   - Invalid token -> {"success": false, "error": "unauthorized"} and the
//!     connection is closed (host-rs behavior).
//!
//! NOT in scope (lives in bridge.py / host-rs): policy engine, leases,
//! confirmations, DLP, audit, OTel tracing, dry-run verdicts.
//!
//! Deliberately built on `std.c` (sockets, files, pthreads) rather than
//! `std.Io`: the C ABI surface is stable across Zig releases and needs no
//! event-loop instance for a thread-per-client blocking design.

const std = @import("std");
const builtin = @import("builtin");
const c = std.c;

const native_endian = builtin.target.cpu.arch.endian();
const gpa = std.heap.smp_allocator;

const max_frame_len: u32 = 64 * 1024 * 1024; // defensive bound on framed messages
const max_line_len: usize = 64 * 1024 * 1024; // defensive bound on TCP request lines
const read_chunk = 64 * 1024;

// ---------------------------------------------------------------------------
// Small pthread wrappers (std.Thread.Mutex moved behind std.Io in 0.16).
// ---------------------------------------------------------------------------

const PtMutex = struct {
    // `.{}` matches PTHREAD_MUTEX_INITIALIZER (std.c defines correct
    // per-OS default field values, including the darwin signature).
    m: c.pthread_mutex_t = .{},

    fn lock(self: *PtMutex) void {
        _ = c.pthread_mutex_lock(&self.m);
    }
    fn unlock(self: *PtMutex) void {
        _ = c.pthread_mutex_unlock(&self.m);
    }
};

fn nowMs() i64 {
    var ts: c.timespec = undefined;
    _ = c.clock_gettime(.REALTIME, &ts);
    return @as(i64, ts.sec) * 1000 + @divTrunc(@as(i64, ts.nsec), 1_000_000);
}

// ---------------------------------------------------------------------------
// Logging: append-only file, never stdout (stdout is the Chrome channel).
// ---------------------------------------------------------------------------

const Logger = struct {
    fd: c_int,
    mu: PtMutex = .{},

    fn open(path: [*:0]const u8) Logger {
        const fd = c.open(path, .{ .ACCMODE = .WRONLY, .CREAT = true, .APPEND = true }, @as(c.mode_t, 0o644));
        return .{ .fd = fd };
    }

    fn log(self: *Logger, level: []const u8, msg: []const u8) void {
        if (self.fd < 0) return;
        var buf: [1024]u8 = undefined;
        const line = std.fmt.bufPrint(&buf, "{d} - {s} - {s}\n", .{ nowMs(), level, msg }) catch return;
        self.mu.lock();
        defer self.mu.unlock();
        _ = c.write(self.fd, line.ptr, line.len);
    }
};

var logger: Logger = undefined;

// ---------------------------------------------------------------------------
// fd I/O helpers.
// ---------------------------------------------------------------------------

fn writeAllFd(fd: c_int, bytes: []const u8) !void {
    var off: usize = 0;
    while (off < bytes.len) {
        const n = c.write(fd, bytes.ptr + off, bytes.len - off);
        if (n <= 0) return error.WriteFailed;
        off += @intCast(n);
    }
}

/// Read exactly buf.len bytes; error.Eof on clean close at a boundary.
fn readExactFd(fd: c_int, buf: []u8) !void {
    var off: usize = 0;
    while (off < buf.len) {
        const n = c.read(fd, buf.ptr + off, buf.len - off);
        if (n == 0) return if (off == 0) error.Eof else error.UnexpectedEof;
        if (n < 0) return error.ReadFailed;
        off += @intCast(n);
    }
}

/// Read the whole file into gpa-owned memory, or null.
fn readFileAlloc(path: [*:0]const u8) ?[]u8 {
    const fd = c.open(path, .{ .ACCMODE = .RDONLY }, @as(c.mode_t, 0));
    if (fd < 0) return null;
    defer _ = c.close(fd);
    var list: std.ArrayList(u8) = .empty;
    var chunk: [4096]u8 = undefined;
    while (true) {
        const n = c.read(fd, &chunk, chunk.len);
        if (n < 0) {
            list.deinit(gpa);
            return null;
        }
        if (n == 0) break;
        list.appendSlice(gpa, chunk[0..@intCast(n)]) catch {
            list.deinit(gpa);
            return null;
        };
    }
    return list.toOwnedSlice(gpa) catch null;
}

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

fn env(name: [*:0]const u8) ?[]const u8 {
    const v = c.getenv(name) orelse return null;
    return std.mem.span(v);
}

/// Env override or <host_dir>/<default_name>, NUL-terminated, gpa-owned.
fn cfgPathZ(env_name: [*:0]const u8, host_dir: []const u8, default_name: []const u8) [:0]u8 {
    if (env(env_name)) |v| {
        return gpa.dupeZ(u8, v) catch @panic("oom");
    }
    return std.fmt.allocPrintSentinel(gpa, "{s}/{s}", .{ host_dir, default_name }, 0) catch @panic("oom");
}

const Config = struct {
    port: u16,
    token_file: [:0]u8,
    tokens_file: [:0]u8,
    log_file: [:0]u8,
    resp_timeout_s: u32,
};

fn loadConfig() Config {
    // Default paths are relative to the executable's directory, like host-rs.
    // Env vars always take precedence; setup scripts export them via the
    // launch wrapper, so the "." fallback is a dev-run convenience only.
    const host_dir: []const u8 = ".";
    var port: u16 = 9223;
    if (env("BRIDGE_PORT")) |p| {
        port = std.fmt.parseInt(u16, p, 10) catch 9223;
    }
    var timeout: u32 = 120;
    if (env("BRIDGE_RESP_TIMEOUT_SECONDS")) |t| {
        timeout = std.fmt.parseInt(u32, t, 10) catch 120;
    }
    return .{
        .port = port,
        .token_file = cfgPathZ("BRIDGE_TOKEN_FILE", host_dir, "bridge_token.txt"),
        .tokens_file = cfgPathZ("BRIDGE_TOKENS_FILE", host_dir, "bridge_tokens.txt"),
        .log_file = cfgPathZ("BRIDGE_LOG_FILE", host_dir, "bridge_debug.log"),
        .resp_timeout_s = timeout,
    };
}

var config: Config = undefined;

// ---------------------------------------------------------------------------
// Token registry. Re-read per auth attempt (files are tiny; always fresh).
// Returns the client name for a valid token.
// ---------------------------------------------------------------------------

fn verifyToken(token: []const u8, name_buf: []u8) ?[]const u8 {
    if (token.len == 0) return null;
    // Legacy single token -> client "default".
    if (readFileAlloc(config.token_file)) |contents| {
        defer gpa.free(contents);
        const legacy = std.mem.trim(u8, contents, " \t\r\n");
        if (legacy.len > 0 and std.mem.eql(u8, legacy, token)) {
            @memcpy(name_buf[0..7], "default");
            return name_buf[0..7];
        }
    }
    // Named tokens: `name:token` per line, `#` comments.
    if (readFileAlloc(config.tokens_file)) |contents| {
        defer gpa.free(contents);
        var lines = std.mem.splitScalar(u8, contents, '\n');
        while (lines.next()) |raw| {
            const line = std.mem.trim(u8, raw, " \t\r");
            if (line.len == 0 or line[0] == '#') continue;
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
            const name = std.mem.trim(u8, line[0..colon], " \t");
            const tok = std.mem.trim(u8, line[colon + 1 ..], " \t");
            if (name.len == 0 or tok.len == 0 or name.len > name_buf.len) continue;
            if (std.mem.eql(u8, tok, token)) {
                @memcpy(name_buf[0..name.len], name);
                return name_buf[0..name.len];
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Pending request registry: request id -> response slot + condvar.
// ---------------------------------------------------------------------------

const Pending = struct {
    cond: c.pthread_cond_t = .{}, // PTHREAD_COND_INITIALIZER equivalent
    response: ?[]u8 = null, // gpa-owned; freed by the requesting client thread
    done: bool = false,
};

var pending_mu: PtMutex = .{};
var pending_map: std.StringHashMap(*Pending) = undefined;

// ---------------------------------------------------------------------------
// Framed stdout writes (to Chrome).
// ---------------------------------------------------------------------------

var stdout_mu: PtMutex = .{};

fn writeFrame(payload: []const u8) !void {
    const total = gpa.alloc(u8, 4 + payload.len) catch return error.Oom;
    defer gpa.free(total);
    std.mem.writeInt(u32, total[0..4], @intCast(payload.len), native_endian);
    @memcpy(total[4..], payload);
    stdout_mu.lock();
    defer stdout_mu.unlock();
    try writeAllFd(1, total);
}

// ---------------------------------------------------------------------------
// UUID v4 (lowercase, dashed) — matches uuid.uuid4() string form.
// Randomness: /dev/urandom (opened once at startup); if unavailable, a
// splitmix64 stream seeded from time+pid — ids then only guarantee
// uniqueness for request correlation, which is all the transport needs.
// ---------------------------------------------------------------------------

var rand_fd: c_int = -1;
var fallback_state: u64 = 0; // guarded by rand_mu
var rand_mu: PtMutex = .{};

fn randInit() void {
    rand_fd = c.open("/dev/urandom", .{ .ACCMODE = .RDONLY }, @as(c.mode_t, 0));
    fallback_state = @as(u64, @bitCast(nowMs())) ^ (@as(u64, @intCast(c.getpid())) << 32);
}

fn randBytes(buf: []u8) void {
    if (rand_fd >= 0) {
        var off: usize = 0;
        while (off < buf.len) {
            const n = c.read(rand_fd, buf.ptr + off, buf.len - off);
            if (n <= 0) break;
            off += @intCast(n);
        }
        if (off == buf.len) return;
    }
    rand_mu.lock();
    defer rand_mu.unlock();
    var i: usize = 0;
    while (i < buf.len) : (i += 8) {
        fallback_state +%= 0x9E3779B97F4A7C15;
        var z = fallback_state;
        z = (z ^ (z >> 30)) *% 0xBF58476D1CE4E5B9;
        z = (z ^ (z >> 27)) *% 0x94D049BB133111EB;
        z ^= z >> 31;
        const take = @min(8, buf.len - i);
        @memcpy(buf[i .. i + take], std.mem.asBytes(&z)[0..take]);
    }
}

fn uuid4(out: *[36]u8) void {
    var b: [16]u8 = undefined;
    randBytes(&b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = "0123456789abcdef";
    var o: usize = 0;
    for (b, 0..) |byte, i| {
        if (i == 4 or i == 6 or i == 8 or i == 10) {
            out[o] = '-';
            o += 1;
        }
        out[o] = hex[byte >> 4];
        out[o + 1] = hex[byte & 0x0f];
        o += 2;
    }
}

// ---------------------------------------------------------------------------
// TCP client handling.
// ---------------------------------------------------------------------------

fn sendLine(fd: c_int, json_bytes: []const u8) void {
    writeAllFd(fd, json_bytes) catch return;
    writeAllFd(fd, "\n") catch return;
}

const unauthorized_resp = "{\"success\": false, \"error\": \"unauthorized\"}";
const invalid_resp = "{\"success\": false, \"error\": \"invalid request\"}";
const timeout_resp = "{\"success\": false, \"error\": \"timeout waiting for extension response\"}";

/// Handle one JSON request line. Returns false when the connection must close.
fn handleLine(fd: c_int, line: []const u8) bool {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, line, .{}) catch {
        sendLine(fd, invalid_resp);
        return false;
    };
    if (parsed != .object) {
        sendLine(fd, invalid_resp);
        return false;
    }
    var obj = parsed.object;

    // --- Token gate (before anything is forwarded). ---
    const token: []const u8 = blk: {
        const v = obj.get("token") orelse break :blk "";
        break :blk if (v == .string) v.string else "";
    };
    var name_buf: [256]u8 = undefined;
    const client_name = verifyToken(token, &name_buf) orelse {
        logger.log("WARNING", "Rejected unauthenticated/invalid-token request.");
        sendLine(fd, unauthorized_resp);
        return false;
    };
    _ = client_name;

    // --- Strip host-only fields; attach request id. ---
    _ = obj.orderedRemove("token");
    _ = obj.orderedRemove("confirmationToken");
    _ = obj.orderedRemove("dryRun");
    _ = obj.orderedRemove("traceparent");

    var id_buf: [36]u8 = undefined;
    uuid4(&id_buf);
    obj.put(arena, "id", .{ .string = &id_buf }) catch return false;

    const fwd = std.json.Stringify.valueAlloc(arena, std.json.Value{ .object = obj }, .{}) catch return false;
    if (fwd.len > max_frame_len) {
        sendLine(fd, invalid_resp);
        return true;
    }

    // --- Register pending slot, then forward. ---
    const id_key = gpa.dupe(u8, &id_buf) catch return false;
    const slot = gpa.create(Pending) catch {
        gpa.free(id_key);
        return false;
    };
    slot.* = .{};

    pending_mu.lock();
    pending_map.put(id_key, slot) catch {
        pending_mu.unlock();
        _ = c.pthread_cond_destroy(&slot.cond);
        gpa.destroy(slot);
        gpa.free(id_key);
        return false;
    };
    pending_mu.unlock();

    var forwarded = true;
    writeFrame(fwd) catch {
        forwarded = false;
    };

    // --- Await the extension response (or timeout). ---
    // The timeout verdict, response-ownership transfer, and map removal
    // happen under ONE mutex hold: stdinLoop delivers only to slots it can
    // still find in the map (under the same mutex), so after remove() no
    // late response can be inserted, misreported as a timeout, or leaked.
    var response: ?[]u8 = null;
    {
        pending_mu.lock();
        defer pending_mu.unlock();
        if (forwarded) {
            var abstime: c.timespec = undefined;
            _ = c.clock_gettime(.REALTIME, &abstime);
            abstime.sec += config.resp_timeout_s;
            while (!slot.done) {
                const rc = c.pthread_cond_timedwait(&slot.cond, &pending_mu.m, &abstime);
                if (rc == .TIMEDOUT) break;
            }
        }
        // Harvest whatever arrived, even on the TIMEDOUT return path: a
        // signal that raced the timeout already published its response
        // under this mutex before we reacquired it.
        response = slot.response;
        slot.response = null;
        _ = pending_map.remove(id_key);
    }
    _ = c.pthread_cond_destroy(&slot.cond);
    gpa.destroy(slot);
    gpa.free(id_key);

    if (response) |resp| {
        sendLine(fd, resp);
        gpa.free(resp);
    } else {
        sendLine(fd, timeout_resp);
    }
    return true;
}

fn clientThread(fd: c_int) void {
    defer _ = c.close(fd);
    var buffer: std.ArrayList(u8) = .empty;
    defer buffer.deinit(gpa);
    var scanned: usize = 0;

    outer: while (true) {
        // Serve complete lines already buffered.
        while (std.mem.indexOfScalarPos(u8, buffer.items, scanned, '\n')) |nl| {
            const line = buffer.items[0..nl];
            if (line.len > 0) {
                if (!handleLine(fd, line)) return;
            }
            buffer.replaceRange(gpa, 0, nl + 1, &.{}) catch return;
            scanned = 0;
        }
        scanned = buffer.items.len;
        if (buffer.items.len > max_line_len) return;

        // Need more bytes.
        const old_len = buffer.items.len;
        buffer.resize(gpa, old_len + read_chunk) catch return;
        const n = c.read(fd, buffer.items.ptr + old_len, read_chunk);
        if (n <= 0) break :outer;
        buffer.shrinkRetainingCapacity(old_len + @as(usize, @intCast(n)));
    }
}

// ---------------------------------------------------------------------------
// TCP listener.
// ---------------------------------------------------------------------------

fn listenerThread() void {
    const sock = c.socket(c.AF.INET, c.SOCK.STREAM, 0);
    if (sock < 0) {
        logger.log("ERROR", "socket() failed");
        return;
    }
    var one: c_int = 1;
    _ = c.setsockopt(sock, c.SOL.SOCKET, c.SO.REUSEADDR, &one, @sizeOf(c_int));

    var addr: c.sockaddr.in = .{
        .family = c.AF.INET,
        .port = std.mem.nativeToBig(u16, config.port),
        .addr = std.mem.nativeToBig(u32, 0x7F000001), // 127.0.0.1
        .zero = @splat(0),
    };
    if (c.bind(sock, @ptrCast(&addr), @sizeOf(c.sockaddr.in)) != 0) {
        logger.log("ERROR", "bind() failed (port already in use?)");
        return;
    }
    if (c.listen(sock, 64) != 0) {
        logger.log("ERROR", "listen() failed");
        return;
    }
    logger.log("INFO", "TCP API listening on 127.0.0.1");

    while (true) {
        const client = c.accept(sock, null, null);
        if (client < 0) continue;
        const t = std.Thread.spawn(.{}, clientThread, .{client}) catch {
            _ = c.close(client);
            continue;
        };
        t.detach();
    }
}

// ---------------------------------------------------------------------------
// Stdin loop: framed responses from Chrome, routed to pending slots by id.
// ---------------------------------------------------------------------------

fn stdinLoop() void {
    while (true) {
        var header: [4]u8 = undefined;
        readExactFd(0, &header) catch |e| {
            if (e == error.Eof) {
                logger.log("INFO", "stdin closed; exiting.");
            } else {
                logger.log("ERROR", "stdin read failed; exiting.");
            }
            return;
        };
        const len = std.mem.readInt(u32, &header, native_endian);
        if (len == 0 or len > max_frame_len) {
            logger.log("ERROR", "invalid frame length from Chrome; exiting.");
            return;
        }
        const body = gpa.alloc(u8, len) catch return;
        defer gpa.free(body);
        readExactFd(0, body) catch return;

        // Extract "id" only; the raw bytes are routed untouched.
        var arena_state = std.heap.ArenaAllocator.init(gpa);
        defer arena_state.deinit();
        const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena_state.allocator(), body, .{}) catch continue;
        if (parsed != .object) continue;
        const id_v = parsed.object.get("id") orelse continue;
        if (id_v != .string) continue;

        pending_mu.lock();
        if (pending_map.get(id_v.string)) |slot| {
            if (!slot.done) {
                slot.response = gpa.dupe(u8, body) catch null;
                slot.done = true;
                _ = c.pthread_cond_signal(&slot.cond);
            }
        }
        pending_mu.unlock();
    }
}

// ---------------------------------------------------------------------------

pub fn main() void {
    // Writing to a closed socket/pipe must surface as EPIPE, not kill us.
    var sa: c.Sigaction = std.mem.zeroes(c.Sigaction);
    sa.handler = .{ .handler = c.SIG.IGN };
    _ = c.sigaction(c.SIG.PIPE, &sa, null);

    config = loadConfig();
    randInit();
    logger = Logger.open(config.log_file.ptr);
    pending_map = .init(gpa);

    logger.log("INFO", "bridge-host-zig starting");

    const t = std.Thread.spawn(.{}, listenerThread, .{}) catch {
        logger.log("ERROR", "failed to spawn listener");
        return;
    };
    t.detach();

    stdinLoop();
}
