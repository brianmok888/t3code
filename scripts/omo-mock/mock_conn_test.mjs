#!/usr/bin/env node
// Mock-first connection test for the t3 omo adapter chain.
// Replicates the OmoSharedProcess connection sequence against the mock
// native host: ensure-info, id-isolation across connections, open_session,
// prompt streaming, state/messages, reconnect-reattach by sessionPath, close.
import net from "node:net";
import readline from "node:readline";

const SOCK = process.env.MOCK_SOCK || "/tmp/mock-omo-host.sock";
const results = [];
const check = (name, ok, detail = "") => results.push([ok ? "PASS" : "FAIL", name, detail]);

function connect() {
  const c = net.createConnection(SOCK);
  const events = [];
  const waiters = [];
  const rl = readline.createInterface({ input: c });
  rl.on("line", (line) => {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i];
      if (w.pred(d)) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(d);
      }
    }
    events.push(d);
  });
  const req = (payload, pred, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.reject === reject);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`timeout waiting ${payload.type}#${payload.id ?? ""}`));
      }, timeoutMs);
      const w = { pred: pred || (() => true), resolve, reject, timer };
      waiters.push(w);
      c.write(JSON.stringify(payload) + "\n");
    });
  const response = (payload, timeoutMs = 5000) =>
    req(payload, (d) => d.type === "response" && d.id === payload.id, timeoutMs);
  let seq = 0;
  return {
    socket: c,
    events,
    request: (type, extra = {}, timeoutMs) =>
      response({ type, id: `c${++seq}`, ...extra }, timeoutMs),
    waitFor: (pred, timeoutMs = 5000) =>
      req({ type: "__wait__" }, pred, timeoutMs).catch(() => null),
    close: () => c.destroy(),
  };
}

const c1 = connect();
c1.socket.on("error", () => {});
const c2 = connect();
c2.socket.on("error", () => {});

// 1. protocol info
const info = await c1.request("get_protocol_info");
check(
  "protocol-info",
  info.success && info.data.mode === "multi" && !!info.data.instanceId,
  `mode=${info.data?.mode} v=${info.data?.serverVersion}`,
);

// 2. same request id on two connections -> isolation
c1.socket.write(JSON.stringify({ type: "get_protocol_info", id: "same" }) + "\n");
c2.socket.write(JSON.stringify({ type: "list_sessions", id: "same" }) + "\n");
const [p1, p2] = await Promise.all([
  new Promise((r) => c1.socket.once("data", (buf) => r(JSON.parse(buf.toString().split("\n")[0])))),
  new Promise((r) => c2.socket.once("data", (buf) => r(JSON.parse(buf.toString().split("\n")[0])))),
]);
check(
  "same-id-isolation",
  p1.command === "get_protocol_info" && p2.command === "list_sessions",
  `${p1.command} vs ${p2.command}`,
);

// 3. open session
const opened = await c1.request("open_session", {
  cwd: "/tmp",
  sessionPath: "/tmp/mock-probe-session.jsonl",
  kind: "worker",
  retain_on_disconnect: true,
  promptSurface: "chat",
});
const sid = opened.data?.sessionId;
check("open-session", opened.success && !!sid, `sid=${sid} attached=${opened.data?.attached}`);
check(
  "open-session-model",
  opened.data?.state?.model?.id?.includes("glm-5.3-flash"),
  opened.data?.state?.model?.id,
);

// 4. prompt -> streaming
const deltas = [];
const streamDone = (async () => {
  for (;;) {
    const ev = await c1.waitFor(
      (d) =>
        d.sessionId === sid &&
        d.type === "message_update" &&
        d.assistantMessageEvent?.type === "text_delta",
      5000,
    );
    if (!ev) break;
    deltas.push(ev.assistantMessageEvent.delta);
  }
})();
const prompted = await c1.request("prompt", {
  sessionId: sid,
  message: "hello from t3 mock probe",
});
check("prompt-accepted", prompted.success);
const idle = await c1.waitFor((d) => d.sessionId === sid && d.type === "agent_idle", 5000);
await streamDone;
check("streaming-deltas", deltas.length >= 3, `${deltas.length} deltas`);
check("lifecycle-complete", !!idle, "agent_idle received");
check("reply-content", deltas.join("").startsWith("mock-reply-to:"), deltas.join("").slice(0, 40));

// 5. state + messages
const st = await c1.request("get_state", { sessionId: sid });
check("state-idle", st.success && st.data.isStreaming === false);
const msgs = await c1.request("get_messages", { sessionId: sid });
const reply = (msgs.data.messages || []).find((m) => m.role === "assistant");
check("messages-persisted", !!reply, reply?.content?.[0]?.text?.slice(0, 30));

// 6. reconnect-reattach by sessionPath (different connection)
const re = await c2.request("open_session", {
  cwd: "/tmp",
  sessionPath: "/tmp/mock-probe-session.jsonl",
  kind: "worker",
  retain_on_disconnect: true,
});
check(
  "reattach-same-session",
  re.success && re.data.sessionId === sid && re.data.attached === true,
  `sid=${re.data?.sessionId} attached=${re.data?.attached}`,
);

// 7. close
const closed = await c2.request("close_session", { sessionId: sid });
check("close-session", closed.success);

c1.close();
c2.close();

let fails = 0;
for (const [status, name, detail] of results) {
  if (status === "FAIL") fails++;
  console.log(`${status}  ${name}${detail ? "  — " + detail : ""}`);
}
console.log(fails === 0 ? "\nALL GREEN — mock connection path verified" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
