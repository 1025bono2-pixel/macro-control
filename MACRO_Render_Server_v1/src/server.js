const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const HOST_SECRET = process.env.HOST_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

if (!HOST_SECRET || !SESSION_SECRET) {
  console.warn("[MACRO] HOST_SECRET / SESSION_SECRET 환경변수를 설정하세요.");
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/host" });

let hostSocket = null;
let hostState = { connected: false, connectedAt: null, accounts: [] };
const pending = new Map();

function send(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(data));
  return true;
}

function requestHost(type, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!hostSocket || hostSocket.readyState !== WebSocket.OPEN) {
      return reject(new Error("총괄 PC Host가 연결되어 있지 않습니다."));
    }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Host 응답 시간이 초과되었습니다."));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    send(hostSocket, { type, requestId, payload });
  });
}

app.get("/", (_req, res) => res.json({
  service: "MACRO Control",
  version: "2.0.0",
  status: "ok",
  hostConnected: hostState.connected
}));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/status", (_req, res) => res.json({ ok: true, host: hostState }));

app.post("/api/host/request", async (req, res) => {
  const token = String(req.headers["x-macro-session"] || "");
  if (!SESSION_SECRET || token !== SESSION_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const type = String(req.body?.type || "");
  const payload = req.body?.payload || {};
  const allowed = new Set([
    "control.status",
    "control.rooms",
    "control.macros.get",
    "control.macros.set"
  ]);
  if (!allowed.has(type)) {
    return res.status(400).json({ ok: false, error: "unsupported request" });
  }

  try {
    const result = await requestHost(type, payload);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const secret = url.searchParams.get("secret") || "";
  if (!HOST_SECRET || secret !== HOST_SECRET) {
    ws.close(1008, "unauthorized");
    return;
  }

  if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
    hostSocket.close(1012, "replaced");
  }
  hostSocket = ws;
  hostState = { ...hostState, connected: true, connectedAt: new Date().toISOString() };
  send(ws, { type: "relay.ready", version: "2.0.0" });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === "host.state") {
      hostState.accounts = Array.isArray(msg.accounts) ? msg.accounts : [];
      return;
    }
    if (msg.requestId && pending.has(msg.requestId)) {
      const item = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      clearTimeout(item.timer);
      if (msg.ok === false) item.reject(new Error(msg.error || "Host request failed"));
      else item.resolve(msg.result ?? null);
    }
  });

  ws.on("close", () => {
    if (hostSocket === ws) {
      hostSocket = null;
      hostState = { connected: false, connectedAt: null, accounts: [] };
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`[MACRO CONTROL] :${PORT}`));
