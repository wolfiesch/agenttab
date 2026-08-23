#!/usr/bin/env python3
import subprocess
import time
import socket
import json
import struct
import threading
import sys
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Captures every framed message bridge.py forwards to Chrome (its stdout),
# keyed by request id, and stores the matching client socket so the mock
# "extension" can answer.
forwarded = {}
forwarded_lock = threading.Lock()

def read_from_bridge(proc):
    try:
        while True:
            raw_length = proc.stdout.read(4)
            if len(raw_length) == 0:
                break
            length = struct.unpack('@I', raw_length)[0]
            data = proc.stdout.read(length).decode('utf-8')
            msg = json.loads(data)
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
            break
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

    # Wait for the bridge to forward exactly one new command.
    req_id = None
    deadline = time.time() + 5
    while time.time() < deadline and req_id is None:
        with forwarded_lock:
            if forwarded:
                req_id = next(iter(forwarded))
        time.sleep(0.02)
    if req_id is None:
        print("[TEST] FAILED: bridge never forwarded the command on stdout.")
        proc.terminate(); sys.exit(1)
    print(f"[TEST] Intercepted command id={req_id} ({len(json.dumps(forwarded[req_id]))} bytes)")

    respond_on_stdin(proc, req_id, result_payload)

    line = recv_line(sock)
    sock.close()
    with forwarded_lock:
        forwarded.clear()
    response = json.loads(line.decode('utf-8'))
    assert response.get("success") is True, "response not successful"
    assert response.get("result") == result_payload, "payload corrupted/truncated in transit"
    print(f"[TEST] OK: round-tripped {len(json.dumps(response))} bytes intact.\n")

def unused_loopback_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def main():
    print("[TEST] Starting integration verification of Native Messaging Host...")
    port = unused_loopback_port()
    test_env = os.environ.copy()
    test_env['BRIDGE_PORT'] = str(port)
    token_fixture = "/tmp/chrome-bridge-verify-token.txt"
    with open(token_fixture, "w", encoding="utf-8") as f:
        f.write("verify-token\n")
    test_env['BRIDGE_TOKEN_FILE'] = token_fixture
    os.environ['BRIDGE_TOKEN_FILE'] = token_fixture
    policy_fixture = "/tmp/chrome-bridge-verify-policy.json"
    with open(policy_fixture, "w", encoding="utf-8") as f:
        json.dump({"default": {"allowedActions": ["*"], "allowedOrigins": ["*"], "deniedActions": [], "deniedOrigins": [], "requireConfirmation": [], "redact": True, "audit": True}}, f)
    test_env['BRIDGE_POLICY_FILE'] = policy_fixture

    proc = subprocess.Popen(
        [os.path.join(SCRIPT_DIR, 'bridge.py')],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=test_env
    )
    time.sleep(1)

    threading.Thread(target=read_from_bridge, args=(proc,), daemon=True).start()

    # Case 1: small ping/pong.
    round_trip(proc, port, "ping", "pong", "Case 1: small payload")

    # Case 2: large payload that exceeds a single recv() buffer (the framing bug).
    big = "x" * 500_000
    round_trip(proc, port, "getCookies", big, "Case 2: 500KB payload", {"domain": "example.com"})

    # Case 3: a wrong token must be rejected without forwarding to the extension.
    print("[TEST] --- Case 3: invalid token rejected ---")
    bad = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    bad.connect(('127.0.0.1', port))
    bad.sendall((json.dumps({"action": "ping", "payload": {}, "token": "WRONG"}) + "\n").encode('utf-8'))
    rej = json.loads(recv_line(bad).decode('utf-8'))
    bad.close()
    assert rej.get("success") is False and rej.get("error") == "unauthorized", "bad token not rejected"
    print("[TEST] OK: invalid token rejected.\n")

    print("[TEST] SUCCESS: All integration checks passed (framing handles large payloads).")
    proc.terminate()
    proc.wait()

if __name__ == '__main__':
    main()
