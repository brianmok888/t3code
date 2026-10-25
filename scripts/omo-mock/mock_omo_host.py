#!/usr/bin/env python3
"""Mock native omo host: speaks the multi-session socket protocol that the
t3 OmoSharedProcess/RpcClient drives, with canned deterministic responses.

Purpose: mock-first connection testing of the t3 omo adapter chain.
Frames (mirrors senpi dist/modes/rpc/rpc-mode.d.ts responses observed live):
  req:  {type, id, ...}              res: {type:"response", id, success, command, data|error}
  events: {type:"message_update", sessionId, assistantMessageEvent:{type:"text_delta",...}}
          {type:"turn_end"|"agent_end"|"agent_idle", sessionId}
Supported: get_protocol_info, list_sessions, open_session, prompt,
           get_state, get_messages, close_session, steer (send_custom_message).
"""
import json, os, socket, socketserver, threading, time, uuid

SOCK = sys_sock = os.environ.get("MOCK_SOCK", "/tmp/mock-omo-host.sock")
INSTANCE_ID = "mock-" + uuid.uuid4().hex[:12]

sessions = {}          # sessionId -> {cwd, messages, streaming, sessionPath}
lock = threading.Lock()

def emit(conn, payload):
    conn.sendall((json.dumps(payload) + "\n").encode())

def stream_prompt(conn, sid, message):
    """Emit a deterministic text_delta stream then lifecycle completions."""
    text = f"mock-reply-to:{message[:60]}"
    for chunk in [text[i:i+12] for i in range(0, len(text), 12)]:
        emit(conn, {"type": "message_update", "sessionId": sid,
                    "assistantMessageEvent": {"type": "text_delta", "delta": chunk,
                                              "snapshotSoFar": text[:text.index(chunk)+len(chunk)]}})
        time.sleep(0.01)
    for typ in ("turn_end", "agent_end", "agent_settled", "agent_idle"):
        emit(conn, {"type": typ, "sessionId": sid})

def handle(conn):
    buf = b""
    try:
        while True:
            data = conn.recv(65536)
            if not data:
                break
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    req = json.loads(line)
                except ValueError:
                    continue
                typ, rid = req.get("type"), req.get("id")
                with lock:
                    if typ == "get_protocol_info":
                        emit(conn, {"type": "response", "id": rid, "success": True,
                                    "command": typ,
                                    "data": {"mode": "multi", "serverVersion": "mock-5.1.44",
                                             "instanceId": INSTANCE_ID, "generation": 1,
                                             "capabilities": {"multiSession": True}}})
                    elif typ == "list_sessions":
                        emit(conn, {"type": "response", "id": rid, "success": True, "command": typ,
                                    "data": {"sessions": [{"sessionId": k, "cwd": v["cwd"]} for k, v in sessions.items()]}})
                    elif typ == "open_session":
                        spath = req.get("sessionPath") or f"/tmp/mock-session-{uuid.uuid4().hex[:8]}.jsonl"
                        existing = next((k for k, v in sessions.items() if v["sessionPath"] == spath), None)
                        sid = existing or f"mock-{uuid.uuid4().hex[:6]}"
                        sessions.setdefault(sid, {"cwd": req.get("cwd"), "messages": [],
                                                  "streaming": False, "sessionPath": spath})
                        attached = existing is not None
                        emit(conn, {"type": "response", "id": rid, "success": True, "command": typ,
                                    "data": {"sessionId": sid, "attached": attached,
                                             "state": {"model": {"id": "omniroute/glm/glm-5.3-flash"},
                                                       "isStreaming": sessions[sid]["streaming"],
                                                       "sessionPath": spath}}})
                    elif typ == "prompt":
                        sid = req.get("sessionId")
                        msg = req.get("message", "")
                        if sid not in sessions:
                            emit(conn, {"type": "response", "id": rid, "success": False, "command": typ,
                                        "error": {"code": "unknown_session"}})
                            continue
                        sessions[sid]["messages"].append({"role": "user", "content": [{"type": "text", "text": msg}]})
                        reply = {"role": "assistant", "content": [{"type": "text", "text": f"mock-reply-to:{msg[:60]}"}]}
                        sessions[sid]["messages"].append(reply)
                        sessions[sid]["streaming"] = True
                        emit(conn, {"type": "response", "id": rid, "success": True, "command": typ,
                                    "data": {"sessionId": sid, "accepted": True}})
                        threading.Thread(target=stream_prompt, args=(conn, sid, msg), daemon=True).start()
                        sessions[sid]["streaming"] = False
                    elif typ == "get_state":
                        sid = req.get("sessionId")
                        v = sessions.get(sid)
                        if not v:
                            emit(conn, {"type": "response", "id": rid, "success": False, "command": typ,
                                        "error": {"code": "unknown_session"}})
                        else:
                            emit(conn, {"type": "response", "id": rid, "success": True, "command": typ,
                                    "data": {"sessionId": sid, "isStreaming": v["streaming"],
                                             "pendingQuestions": []}})
                    elif typ == "get_messages":
                        v = sessions.get(req.get("sessionId"))
                        emit(conn, {"type": "response", "id": rid, "success": True, "command": typ,
                                    "data": {"messages": v["messages"] if v else []}})
                    elif typ == "close_session":
                        sessions.pop(req.get("sessionId"), None)
                        emit(conn, {"type": "response", "id": rid, "success": True, "command": typ,
                                    "data": {"closed": True}})
                    elif typ in ("steer", "send_custom_message"):
                        emit(conn, {"type": "response", "id": rid, "success": True, "command": typ,
                                    "data": {"queued": True}})
                    else:
                        emit(conn, {"type": "response", "id": rid, "success": False,
                                    "command": typ or "?", "error": {"code": "unknown_command"}})
    except (ConnectionResetError, BrokenPipeError):
        pass

class MockOmoHandler(socketserver.BaseRequestHandler):
    def handle(self):
        handle(self.request)

class UnixServer(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True
    daemon_threads = True

if os.path.exists(SOCK):
    os.unlink(SOCK)
srv = UnixServer(SOCK, MockOmoHandler)
os.chmod(SOCK, 0o600)
print(f"MOCK_OMO_HOST_READY {SOCK} instance={INSTANCE_ID}", flush=True)
srv.serve_forever()
