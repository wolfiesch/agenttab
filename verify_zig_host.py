#!/usr/bin/env python3
"""Integration verification of the Zig native host (host-zig).

Same contract as verify_rust_host.py: native-messaging framing, token-gated
TCP API, large-payload framing integrity, invalid-token rejection. Runs on
port 9226 so it never clashes with a live bridge (9223) or the Rust
verifier (9225).
"""
import subprocess
import time
import socket
import json
import struct
import threading
import sys
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Captures every framed message the host forwards to Chrome (its stdout),
# keyed by request id, and stores the matching client socket so the mock
# "extension" can answer.
forwarded = {}
forwarded_lock = threading.Lock()

PORT = 9226


def read_from_bridge(proc):
    try:
        while True:
            raw_len = proc.stdout.read(4)
            if not raw_len:
                break
            msg_len = struct.unpack('@I', raw_len)[0]
            data = b""
            while len(data) < msg_len:
                chunk = proc.stdout.read(msg_len - len(data))
                if not chunk:
                    return
                data += chunk
            msg = json.loads(data.decode('utf-8'))
            with forwarded_lock:
                forwarded[msg.get("id")] = msg
    except Exception as e:
        print("[TEST] Error reading from stdout:", e)


def respond_on_stdin(proc, req_id, result):
    mock_response = {"id": req_id, "success": True, "result": result}
    encoded = json.dumps(mock_response).encode('utf-8')
    proc.stdin.write(struct.pack('@I', len(encoded)))
    proc.stdin.write(encoded)
    proc.stdin.flush()


def recv_line(sock):
    buffer = b""
    while b"\n" not in buffer:
        chunk = sock.recv(65536)
        if not chunk:
            raise RuntimeError("socket closed before newline")
        buffer += chunk
    return buffer.split(b"\n", 1)[0]


def round_trip(proc, port, action, result_payload, label, payload=None):
    print(f"[TEST] --- {label} ---")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(('127.0.0.1', port))
    token_file = os.environ.get('BRIDGE_TOKEN_FILE', os.path.join(SCRIPT_DIR, 'bridge_token.txt'))
    with open(token_file) as f:
        token = f.read().strip()
    sock.sendall((json.dumps({"action": action, "payload": payload or {}, "token": token}) + "\n").encode('utf-8'))

    # Wait for the host to forward exactly one new command.
    req_id = None
    deadline = time.time() + 5
    while time.time() < deadline and req_id is None:
        with forwarded_lock:
            if forwarded:
                req_id = next(iter(forwarded))
        time.sleep(0.02)
    if req_id is None:
        print("[TEST] FAILED: host never forwarded the command on stdout.")
        proc.terminate(); sys.exit(1)
    fwd = forwarded[req_id]
    print(f"[TEST] Intercepted command id={req_id} ({len(json.dumps(fwd))} bytes)")
    # Host-only fields must never reach the extension.
    assert "token" not in fwd, "token leaked to extension"
    assert fwd.get("action") == action, "action corrupted in forward"

    respond_on_stdin(proc, req_id, result_payload)

    line = recv_line(sock)
    sock.close()
    with forwarded_lock:
        forwarded.clear()
    response = json.loads(line.decode('utf-8'))
    assert response.get("success") is True, "response not successful"
    assert response.get("result") == result_payload, "payload corrupted/truncated in transit"
    print(f"[TEST] OK: round-tripped {len(json.dumps(response))} bytes intact.\n")


def main():
    print("[TEST] Starting integration verification of Zig Native Messaging Host...")
    zig_bin = os.path.join(SCRIPT_DIR, 'host-zig', 'zig-out', 'bin', 'bridge-host-zig')
    if not os.path.exists(zig_bin):
        print('Zig host not built: run `zig build` in host-zig/ first')
        sys.exit(3)

    test_env = os.environ.copy()
    test_env['BRIDGE_PORT'] = str(PORT)
    token_fixture = "/tmp/chrome-bridge-verify-zig-token.txt"
    with open(token_fixture, "w", encoding="utf-8") as f:
        f.write("verify-token\n")
    test_env['BRIDGE_TOKEN_FILE'] = token_fixture
    os.environ['BRIDGE_TOKEN_FILE'] = token_fixture
    tokens_fixture = "/tmp/chrome-bridge-verify-zig-tokens.txt"
    with open(tokens_fixture, "w", encoding="utf-8") as f:
        f.write("# named clients\nomp:zig-named-token\n")
    test_env['BRIDGE_TOKENS_FILE'] = tokens_fixture
    test_env['BRIDGE_LOG_FILE'] = "/tmp/chrome-bridge-verify-zig.log"
    # Short timeout so the timeout/race cases (6a-6c) run in seconds. All
    # other cases answer immediately and are unaffected.
    test_env['BRIDGE_RESP_TIMEOUT_SECONDS'] = '1'

    proc = subprocess.Popen(
        [zig_bin],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=test_env
    )
    time.sleep(1)

    threading.Thread(target=read_from_bridge, args=(proc,), daemon=True).start()

    # Case 1: small ping/pong.
    round_trip(proc, PORT, "ping", "pong", "Case 1: small payload")

    # Case 2: large payload that exceeds a single recv() buffer (the framing bug).
    big = "x" * 500_000
    round_trip(proc, PORT, "getCookies", big, "Case 2: 500KB payload", {"domain": "example.com"})

    # Case 3: a wrong token must be rejected without forwarding to the extension.
    print("[TEST] --- Case 3: invalid token rejected ---")
    bad = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    bad.connect(('127.0.0.1', PORT))
    bad.sendall((json.dumps({"action": "ping", "payload": {}, "token": "WRONG"}) + "\n").encode('utf-8'))
    rej = json.loads(recv_line(bad).decode('utf-8'))
    bad.close()
    assert rej.get("success") is False and rej.get("error") == "unauthorized", "bad token not rejected"
    with forwarded_lock:
        assert not forwarded, "unauthorized request was forwarded to the extension"
    print("[TEST] OK: invalid token rejected.\n")

    # Case 4: a named token (BRIDGE_TOKENS_FILE) must authenticate.
    print("[TEST] --- Case 4: named token accepted ---")
    named = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    named.connect(('127.0.0.1', PORT))
    named.sendall((json.dumps({"action": "ping", "payload": {}, "token": "zig-named-token"}) + "\n").encode('utf-8'))
    req_id = None
    deadline = time.time() + 5
    while time.time() < deadline and req_id is None:
        with forwarded_lock:
            if forwarded:
                req_id = next(iter(forwarded))
        time.sleep(0.02)
    assert req_id is not None, "named-token request was not forwarded"
    respond_on_stdin(proc, req_id, "pong")
    resp = json.loads(recv_line(named).decode('utf-8'))
    named.close()
    with forwarded_lock:
        forwarded.clear()
    assert resp.get("success") is True and resp.get("result") == "pong"
    print("[TEST] OK: named token accepted.\n")

    # Case 5: concurrent clients, responses delivered in REVERSE arrival
    # order, each socket must receive only its own payload. This exercises
    # the pending-map/condvar routing under the interleaving it exists for.
    print("[TEST] --- Case 5: concurrent clients, out-of-order responses ---")
    with open(token_fixture) as f:
        legacy_token = f.read().strip()
    clients = {}
    for who in ("alpha", "beta"):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.connect(('127.0.0.1', PORT))
        s.sendall((json.dumps({"action": "ping", "payload": {"who": who},
                               "token": legacy_token}) + "\n").encode('utf-8'))
        clients[who] = s
    # Both requests must be forwarded (in-flight simultaneously) before any
    # response is written back.
    deadline = time.time() + 5
    while time.time() < deadline:
        with forwarded_lock:
            if len(forwarded) == 2:
                break
        time.sleep(0.02)
    with forwarded_lock:
        assert len(forwarded) == 2, "both requests should be in flight concurrently"
        arrival = list(forwarded.items())  # dict preserves arrival order
    ids_by_who = {msg["payload"]["who"]: rid for rid, msg in arrival}
    assert set(ids_by_who) == {"alpha", "beta"}, "forwarded payloads corrupted"
    assert ids_by_who["alpha"] != ids_by_who["beta"], "request ids must be unique"
    # Reply in reverse arrival order with per-request payloads.
    for rid, msg in reversed(arrival):
        respond_on_stdin(proc, rid, "result-for-" + msg["payload"]["who"])
    for who, s in clients.items():
        resp = json.loads(recv_line(s).decode('utf-8'))
        s.close()
        assert resp.get("success") is True, f"{who}: response not successful"
        assert resp.get("result") == "result-for-" + who, \
            f"{who}: received another client's payload: {resp.get('result')!r}"
    with forwarded_lock:
        forwarded.clear()
    print("[TEST] OK: out-of-order responses routed to the correct clients.\n")

    def send_and_forward(payload):
        """Send one authenticated request; return (socket, forwarded_id)."""
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.connect(('127.0.0.1', PORT))
        with open(token_fixture) as f:
            tok = f.read().strip()
        s.sendall((json.dumps({"action": "ping", "payload": payload,
                               "token": tok}) + "\n").encode('utf-8'))
        rid = None
        deadline = time.time() + 5
        while time.time() < deadline and rid is None:
            with forwarded_lock:
                if forwarded:
                    rid = next(iter(forwarded))
            time.sleep(0.005)
        assert rid is not None, "request was not forwarded"
        with forwarded_lock:
            forwarded.clear()
        return s, rid

    # Case 6a: a response arriving after the timeout verdict is dropped:
    # the client gets the timeout error, the host stays healthy, and a
    # follow-up request round-trips normally.
    print("[TEST] --- Case 6a: late response dropped after timeout ---")
    s, rid = send_and_forward({})
    t0 = time.time()
    line = recv_line(s)  # no reply sent; host must emit its timeout error
    elapsed = time.time() - t0
    s.close()
    resp = json.loads(line.decode('utf-8'))
    assert resp.get("success") is False and "timeout" in resp.get("error", ""), \
        f"expected timeout error, got {resp!r}"
    assert elapsed < 4, f"timeout verdict took {elapsed:.1f}s with a 1s budget"
    respond_on_stdin(proc, rid, "way-too-late")  # must be dropped, not crash
    time.sleep(0.1)
    round_trip(proc, PORT, "ping", "pong", "Case 6a follow-up: host healthy")

    # Case 6b: hammer the timeout boundary. Respond at ~the 1s deadline with
    # jitter on both sides; every outcome must be EITHER this request's own
    # payload OR the timeout error. A wrong payload, a hang, or a crash
    # fails. This drives the verdict/transfer/deregistration critical
    # section from both sides simultaneously.
    print("[TEST] --- Case 6b: timeout-vs-response boundary hammer ---")
    outcomes = {"delivered": 0, "timeout": 0}
    for i in range(12):
        marker = f"boundary-{i}"
        s, rid = send_and_forward({"who": marker})
        delay = 0.90 + (i % 5) * 0.05  # 0.90s .. 1.10s across the 1s deadline
        responder = threading.Timer(delay, respond_on_stdin, args=(proc, rid, marker))
        responder.start()
        line = recv_line(s)
        s.close()
        responder.join()
        resp = json.loads(line.decode('utf-8'))
        if resp.get("success") is True:
            assert resp.get("result") == marker, \
                f"iteration {i}: wrong payload {resp.get('result')!r}"
            outcomes["delivered"] += 1
        else:
            assert "timeout" in resp.get("error", ""), f"iteration {i}: {resp!r}"
            outcomes["timeout"] += 1
    print(f"[TEST] OK: 12 boundary races, all outcomes clean "
          f"(delivered={outcomes['delivered']}, timeout={outcomes['timeout']}).")
    assert outcomes["delivered"] > 0 and outcomes["timeout"] > 0, \
        "hammer never straddled the boundary; widen the jitter range"

    # Case 6c: late LARGE responses must not accumulate in the host (the
    # dropped-response path must free). 500KB x 8 late replies would grow
    # RSS by ~4MB if leaked.
    print("[TEST] --- Case 6c: late large responses do not leak ---")
    rss_before = int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(proc.pid)]).strip())
    for i in range(8):
        s, rid = send_and_forward({})
        recv_line(s)  # timeout error after 1s
        s.close()
        respond_on_stdin(proc, rid, "x" * 500_000)  # late; must be dropped+freed
    time.sleep(0.3)
    round_trip(proc, PORT, "ping", "pong", "Case 6c follow-up: host healthy")
    rss_after = int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(proc.pid)]).strip())
    growth_mb = (rss_after - rss_before) / 1024
    assert growth_mb < 3, f"RSS grew {growth_mb:.1f} MB across late 500KB responses"
    print(f"[TEST] OK: RSS growth {growth_mb:.2f} MB across 8 late 500KB responses.\n")

    # Case 7: stdin EOF (Chrome exit) must terminate the host promptly.
    print("[TEST] --- Case 7: clean exit on stdin EOF ---")
    proc.stdin.close()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        print("[TEST] FAILED: host did not exit on stdin EOF.")
        sys.exit(1)
    print("[TEST] OK: host exited on stdin EOF.\n")

    print("[TEST] SUCCESS: All integration checks passed (framing handles large payloads).")


if __name__ == '__main__':
    main()
