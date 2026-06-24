import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { applyAction, cellName, createInitialState } from "./public/engine.mjs";
import { chooseExternalAiAction, publicExternalState, resolveActionInput } from "./external-ai.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

const rooms = new Map();
const streams = new Map();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function html(res, status, content) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store"
  });
  res.end(content);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.LQQ_EXTERNAL_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  };
}

async function bodyJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function randomExternalKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from({ length: 16 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function cleanName(name, fallback) {
  const text = String(name || "").trim().slice(0, 14);
  return text || fallback;
}

function addSeat(room, clientId, name) {
  const existing = room.seats.findIndex((seat) => seat.clientId === clientId);
  if (existing >= 0) {
    room.seats[existing].connected = true;
    room.seats[existing].name = cleanName(name, room.seats[existing].name);
    room.state.players[existing].name = room.seats[existing].name;
    return existing;
  }

  const seatIndex = room.seats.findIndex((seat) => !seat.clientId);
  if (seatIndex < 0) return -1;

  const displayName = cleanName(name, `玩家 ${seatIndex + 1}`);
  room.seats[seatIndex] = {
    clientId,
    name: displayName,
    connected: true
  };
  room.state.players[seatIndex].name = displayName;
  room.started = room.seats.every((seat) => Boolean(seat.clientId));
  room.updatedAt = Date.now();
  return seatIndex;
}

function addExternalSeat(room, seatIndex, clientId, name) {
  const existing = room.seats.findIndex((seat) => seat.clientId === clientId);
  if (existing >= 0) {
    room.seats[existing].connected = true;
    room.seats[existing].name = cleanName(name, room.seats[existing].name);
    room.state.players[existing].name = room.seats[existing].name;
    room.updatedAt = Date.now();
    return existing;
  }

  const target = Number.isInteger(seatIndex) ? seatIndex : room.seats.findIndex((seat) => !seat.clientId);
  if (target < 0 || target >= room.playerCount) return -1;
  if (room.seats[target].clientId) return -1;

  const displayName = cleanName(name, `外部AI ${target + 1}`);
  room.seats[target] = {
    clientId,
    name: displayName,
    connected: true
  };
  room.state.players[target].name = displayName;
  room.started = room.seats.every((seat) => Boolean(seat.clientId));
  room.updatedAt = Date.now();
  return target;
}

function setSeatConnected(room, clientId, connected) {
  const seat = room.seats.find((item) => item.clientId === clientId);
  if (!seat) return false;
  seat.connected = connected;
  room.updatedAt = Date.now();
  return true;
}

function hasActiveStream(code, clientId) {
  if (!clientId) return false;
  for (const entry of roomStreams(code)) {
    if (entry.clientId === clientId) return true;
  }
  return false;
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? "https" : "http");
  const hostHeader = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return hostHeader ? `${proto}://${hostHeader}` : "";
}

function withOrigin(origin, path) {
  return origin ? new URL(path, origin).href : path;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function defaultExternalSeat(room) {
  const externalSeat = room.seats.findIndex((seat) => String(seat.clientId || "").startsWith(`external:${room.code}:`));
  if (externalSeat >= 0) return externalSeat;

  const openGuestSeat = room.seats.findIndex((seat, index) => index > 0 && !seat.clientId);
  if (openGuestSeat >= 0) return openGuestSeat;

  return room.playerCount > 1 ? 1 : room.state.current;
}

function normalizeSeat(room, value, fallback = defaultExternalSeat(room)) {
  if (value === null || value === undefined || value === "") return fallback;
  const seat = Number(value);
  if (Number.isInteger(seat) && seat >= 0 && seat < room.playerCount) return seat;
  return fallback;
}

function externalEndpoints(room, requestedSeat = defaultExternalSeat(room), origin = "") {
  const seat = normalizeSeat(room, requestedSeat);
  const base = `/api/external/rooms/${room.code}`;
  const key = encodeURIComponent(room.externalKey);
  const statePath = `${base}/state?key=${key}&seat=${seat}`;
  const joinPath = `${base}/join?key=${key}&seat=${seat}&name=GPT`;
  const actionPath = `${base}/action`;
  const actionTemplatePath = `${actionPath}?key=${key}&seat=${seat}&id=ACTION_ID`;
  const controlPath = `/external/${room.code}?key=${key}&seat=${seat}`;

  return {
    controlUrl: withOrigin(origin, controlPath),
    controlPath,
    stateUrl: withOrigin(origin, statePath),
    statePath,
    actionUrl: withOrigin(origin, actionPath),
    actionPath,
    actionTemplateUrl: withOrigin(origin, actionTemplatePath),
    actionTemplatePath,
    joinUrl: withOrigin(origin, joinPath),
    joinPath,
    seat,
    key: room.externalKey
  };
}

function publicRoom(room, clientId = "") {
  const mySeat = room.seats.findIndex((seat) => seat.clientId === clientId);
  const payload = {
    code: room.code,
    playerCount: room.playerCount,
    started: room.started,
    mySeat,
    seats: room.seats.map((seat, index) => ({
      index,
      name: seat.name || `玩家 ${index + 1}`,
      occupied: Boolean(seat.clientId),
      connected: Boolean(seat.connected),
      color: room.state.players[index]?.color
    })),
    state: room.state
  };
  if (mySeat === 0) payload.external = externalEndpoints(room);
  return payload;
}

function roomStreams(code) {
  if (!streams.has(code)) streams.set(code, new Set());
  return streams.get(code);
}

function sendStream(entry, room) {
  entry.res.write(`data: ${JSON.stringify(publicRoom(room, entry.clientId))}\n\n`);
}

function broadcast(room) {
  for (const entry of roomStreams(room.code)) sendStream(entry, room);
}

function createRoom(playerCount, hostName, clientId) {
  const count = Math.max(2, Math.min(4, Number(playerCount) || 2));
  const code = randomCode();
  const room = {
    code,
    playerCount: count,
    started: false,
    seats: Array.from({ length: count }, () => ({ clientId: "", name: "", connected: false })),
    state: createInitialState({
      playerCount: count,
      mode: "online",
      names: Array.from({ length: count }, (_, index) => `玩家 ${index + 1}`)
    }),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  room.externalKey = randomExternalKey();
  rooms.set(code, room);
  addSeat(room, clientId, hostName);
  return room;
}

function externalAllowed(req, url, body, room) {
  const expected = process.env.LQQ_EXTERNAL_TOKEN || room.externalKey || "";
  if (!expected) return true;
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const provided = bearer || url.searchParams.get("key") || body.key || body.token || "";
  return provided === expected;
}

function parseSeat(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const seat = Number(value);
  return Number.isInteger(seat) ? seat : fallback;
}

function compactAction(action) {
  if (!action) return "";
  if (action.type === "move") return `move:${cellName(action.row, action.col)}`;
  return `wall:${action.orientation}:${cellName(action.row, action.col)}`;
}

function freshPair(value, fallback) {
  const fresh = Number(value);
  if (Number.isFinite(fresh)) {
    const current = Math.floor(fresh);
    return { current, next: current + 1 };
  }
  return { current: null, next: fallback };
}

function externalControlPath(room, key, seat, fresh) {
  return `/external/${room.code}?key=${encodeURIComponent(key)}&seat=${seat}&fresh=${fresh}`;
}

function externalStatePayload(room, requestedSeat, origin = "", freshValue = null) {
  const seat = normalizeSeat(room, requestedSeat);
  const endpoints = externalEndpoints(room, seat, origin);
  const serverNow = Date.now();
  const fresh = freshPair(freshValue, serverNow);
  const freshStatePath = `${endpoints.statePath}&fresh=${fresh.next}`;
  const rawAi = publicExternalState(room.state, seat);
  const canAct = room.started && room.state.current === seat && !room.state.winner;
  const actionUrlFor = (id) => {
    const path = `${endpoints.actionPath}?key=${encodeURIComponent(room.externalKey)}&seat=${seat}&id=${encodeURIComponent(id)}`;
    return {
      url: withOrigin(origin, path),
      path
    };
  };
  const legalActions = canAct
    ? rawAi.legalActions.map((entry) => ({
      ...entry,
      ...actionUrlFor(entry.id)
    }))
    : [];
  const waitingReason = !room.seats[seat]?.clientId
    ? "这个座位还未入座，请先打开 joinUrl。"
    : !room.started
      ? "房间还未开始，请等待其他玩家入座。"
      : room.state.current !== seat
        ? "还没轮到这个座位。"
        : "";
  const ai = {
    ...rawAi,
    legalActions,
    responseFormat: {
      id: legalActions[0]?.id || "",
      note: canAct ? "从 legalActions 选择一个 id，不要提交不在列表里的动作。" : waitingReason
    }
  };

  return {
    ok: true,
    room: publicRoom(room),
    serverNow,
    roomUpdatedAt: room.updatedAt,
    fresh: fresh.current,
    nextFresh: fresh.next,
    external: {
      ...endpoints,
      freshStateUrl: withOrigin(origin, freshStatePath),
      freshStatePath,
      nextStateUrl: withOrigin(origin, freshStatePath),
      nextStatePath: freshStatePath,
      joinExample: {
        url: endpoints.joinUrl,
        path: endpoints.joinPath
      },
      stateExample: {
        url: endpoints.stateUrl,
        path: endpoints.statePath
      },
      actionExample: {
        url: legalActions[0]?.url || "",
        path: legalActions[0]?.path || "",
        key: room.externalKey,
        seat,
        id: legalActions[0]?.id || ""
      }
    },
    ai: {
      ...ai,
      requestedSeat: seat,
      isTurn: room.state.current === seat,
      seatOccupied: Boolean(room.seats[seat]?.clientId),
      seatConnected: Boolean(room.seats[seat]?.connected),
      waitingReason,
      serverNow,
      roomUpdatedAt: room.updatedAt,
      fresh: fresh.current,
      nextFresh: fresh.next,
      nextStateUrl: withOrigin(origin, freshStatePath),
      moveHistory: room.state.moveHistory || []
    }
  };
}

function externalControlPage(room, seat, origin, freshValue) {
  const payload = externalStatePayload(room, seat, origin, freshValue);
  const playerRows = payload.ai.players
    .map((player) => `<li>${escapeHtml(player.name)}：${escapeHtml(player.cell)}，目标 ${escapeHtml(player.goal)}，剩余 ${player.walls} 墙，最短路 ${player.shortestPath}</li>`)
    .join("");
  const wallText = [
    ...(payload.ai.walls.h || []).map((cell) => `h:${cell}`),
    ...(payload.ai.walls.v || []).map((cell) => `v:${cell}`)
  ].join(", ") || "无";
  const actionRows = payload.ai.legalActions.length
    ? payload.ai.legalActions.map((action) => `<li><a href="${escapeHtml(action.url)}">${escapeHtml(action.id)}</a><span>${escapeHtml(action.text)}</span></li>`).join("")
    : `<li>${escapeHtml(payload.ai.waitingReason || "当前没有可执行动作。")}</li>`;
  const nextPath = externalControlPath(room, room.externalKey, payload.ai.requestedSeat, payload.nextFresh);
  const nextUrl = withOrigin(origin, nextPath);
  const stateUrl = payload.external.nextStateUrl || payload.external.freshStateUrl;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墙路棋外部玩家 ${escapeHtml(room.code)}</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1d2a26; background: #f6f8f4; }
    main { max-width: 760px; margin: 0 auto; padding: 24px; }
    section { margin: 14px 0; padding: 16px; border: 1px solid #d8e0d6; border-radius: 8px; background: white; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    a { color: #16745f; overflow-wrap: anywhere; }
    code { padding: 2px 5px; border-radius: 5px; background: #edf2ea; }
    ul { margin: 8px 0 0; padding-left: 20px; }
    li { margin: 8px 0; }
    .status { font-size: 18px; font-weight: 700; }
    .muted { color: #65746f; }
    .actions li { display: grid; gap: 2px; }
  </style>
</head>
<body>
  <main>
    <h1>墙路棋外部玩家</h1>
    <p class="muted">房间 <code>${escapeHtml(room.code)}</code>，座位 <code>${payload.ai.requestedSeat + 1}</code>，serverNow <code>${payload.serverNow}</code></p>
    <section>
      <h2>当前状态</h2>
      <div class="status">${payload.ai.isTurn ? "轮到你了" : escapeHtml(payload.ai.waitingReason || "等待中")}</div>
      <p>回合：${payload.ai.turn}；当前玩家：${payload.ai.current + 1}；房间：${room.started ? "已开始" : "等待入座"}</p>
      <p>已放墙：${escapeHtml(wallText)}</p>
      <ul>${playerRows}</ul>
    </section>
    <section>
      <h2>刷新</h2>
      <p><a href="${escapeHtml(nextUrl)}">刷新局面</a></p>
      <p class="muted">下一次 fresh：<code>${payload.nextFresh}</code></p>
      <p class="muted">JSON 状态：<a href="${escapeHtml(stateUrl)}">${escapeHtml(stateUrl)}</a></p>
    </section>
    <section>
      <h2>合法动作</h2>
      <ul class="actions">${actionRows}</ul>
    </section>
  </main>
</body>
</html>`;
}

function handleExternalControl(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "external" || !parts[1]) return false;

  const code = parts[1].toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    html(res, 404, "<!doctype html><meta charset=\"utf-8\"><title>房间不存在</title><p>房间不存在或服务器刚刚重启。</p>");
    return true;
  }
  if (!externalAllowed(req, url, {}, room)) {
    html(res, 403, "<!doctype html><meta charset=\"utf-8\"><title>密钥不正确</title><p>外部接口密钥不正确。</p>");
    return true;
  }

  const seatIndex = parseSeat(url.searchParams.get("seat"), defaultExternalSeat(room));
  const botId = cleanName(url.searchParams.get("botId"), `bot-${seatIndex}`);
  const clientId = `external:${room.code}:${botId}`;
  addExternalSeat(room, seatIndex, clientId, url.searchParams.get("name") || "GPT");
  broadcast(room);
  html(res, 200, externalControlPage(room, seatIndex, requestOrigin(req), url.searchParams.get("fresh")));
  return true;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method || "GET";

  if (method === "POST" && url.pathname === "/api/ai/action") {
    const body = await bodyJson(req);
    if (!body.state?.players?.length) return json(res, 400, { error: "缺少棋局状态" });
    const result = await chooseExternalAiAction(body.state, {
      provider: body.provider || body.aiEngine,
      difficulty: body.difficulty,
      config: body.config || {}
    });
    return json(res, 200, result);
  }

  if (parts[0] === "api" && parts[1] === "external" && parts[2] === "rooms" && parts[3]) {
    const code = parts[3].toUpperCase();
    const room = rooms.get(code);
    const headers = corsHeaders();
    if (!room) return json(res, 404, { error: "房间不存在" }, headers);

    if (method === "GET" && parts[4] === "state") {
      if (!externalAllowed(req, url, {}, room)) return json(res, 403, { error: "外部接口密钥不正确" }, headers);
      const payload = externalStatePayload(room, parseSeat(url.searchParams.get("seat"), defaultExternalSeat(room)), requestOrigin(req), url.searchParams.get("fresh"));
      const incomingFresh = url.searchParams.get("fresh");
      if (incomingFresh !== null) {
        const nextFresh = freshPair(incomingFresh, Date.now()).next;
        const connector = payload.external.statePath.includes("?") ? "&" : "?";
        const nextPath = `${payload.external.statePath}${connector}fresh=${nextFresh}`;
        payload.fresh = Number(incomingFresh);
        payload.nextFresh = nextFresh;
        payload.external.freshStatePath = nextPath;
        payload.external.freshStateUrl = withOrigin(requestOrigin(req), nextPath);
        payload.external.nextStatePath = nextPath;
        payload.external.nextStateUrl = withOrigin(requestOrigin(req), nextPath);
        payload.ai.fresh = Number(incomingFresh);
        payload.ai.nextFresh = nextFresh;
        payload.ai.nextStateUrl = payload.external.nextStateUrl;
      }
      return json(res, 200, payload, headers);
    }

    if ((method === "GET" || method === "POST") && parts[4] === "join") {
      const body = method === "GET" ? {} : await bodyJson(req);
      if (!externalAllowed(req, url, body, room)) return json(res, 403, { error: "外部接口密钥不正确" }, headers);
      const seatIndex = parseSeat(body.seat ?? url.searchParams.get("seat"), defaultExternalSeat(room));
      const botId = cleanName(body.botId || url.searchParams.get("botId"), `bot-${Number.isInteger(seatIndex) ? seatIndex : "auto"}`);
      const clientId = `external:${room.code}:${botId}`;
      const seat = addExternalSeat(room, seatIndex, clientId, body.name || url.searchParams.get("name") || "外部AI");
      if (seat < 0) return json(res, 409, { error: "房间已满" }, headers);
      broadcast(room);
      return json(res, 200, {
        ok: true,
        seat,
        room: publicRoom(room, clientId),
        next: room.state.current,
        state: externalStatePayload(room, seat, requestOrigin(req)).ai
      }, headers);
    }

    if ((method === "GET" || method === "POST") && parts[4] === "action") {
      const body = method === "GET" ? {} : await bodyJson(req);
      if (!externalAllowed(req, url, body, room)) return json(res, 403, { error: "外部接口密钥不正确" }, headers);
      const seat = normalizeSeat(room, body.seat ?? url.searchParams.get("seat"));
      if (!room.started) return json(res, 409, { error: "等待玩家入座" }, headers);
      if (!Number.isInteger(seat) || seat < 0 || seat >= room.playerCount) return json(res, 400, { error: "座位不正确" }, headers);
      if (room.state.current !== seat) return json(res, 409, { error: "还没轮到这个座位" }, headers);

      const queryAction = url.searchParams.get("id") || url.searchParams.get("action");
      const action = resolveActionInput(room.state, body.action || body.id || queryAction || body, seat);
      if (!action) return json(res, 400, { error: "动作不在合法动作列表中" }, headers);
      const result = applyAction(room.state, action);
      if (!result.ok) return json(res, 400, { error: result.reason || "这步不合法" }, headers);
      room.state = result.state;
      room.updatedAt = Date.now();
      broadcast(room);
      return json(res, 200, {
        ok: true,
        applied: compactAction(action),
        action,
        next: room.state.current,
        room: publicRoom(room),
        state: externalStatePayload(room, room.state.current, requestOrigin(req)).ai
      }, headers);
    }

    return json(res, 404, { error: "未知外部接口" }, headers);
  }

  if (method === "POST" && url.pathname === "/api/rooms") {
    const body = await bodyJson(req);
    const clientId = String(body.clientId || "");
    if (!clientId) return json(res, 400, { error: "缺少客户端标识" });
    const room = createRoom(body.playerCount, body.name, clientId);
    return json(res, 200, publicRoom(room, clientId));
  }

  if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
    const code = parts[2].toUpperCase();
    const room = rooms.get(code);
    if (!room) return json(res, 404, { error: "房间不存在" });

    if (method === "GET" && parts.length === 3) {
      const clientId = url.searchParams.get("clientId") || "";
      if (clientId) setSeatConnected(room, clientId, true);
      return json(res, 200, publicRoom(room, clientId));
    }

    if (method === "POST" && parts[3] === "join") {
      const body = await bodyJson(req);
      const clientId = String(body.clientId || "");
      if (!clientId) return json(res, 400, { error: "缺少客户端标识" });
      const seat = addSeat(room, clientId, body.name);
      if (seat < 0) return json(res, 409, { error: "房间已满" });
      broadcast(room);
      return json(res, 200, publicRoom(room, clientId));
    }

    if (method === "POST" && parts[3] === "action") {
      const body = await bodyJson(req);
      const clientId = String(body.clientId || "");
      const seat = room.seats.findIndex((item) => item.clientId === clientId);
      if (!room.started) return json(res, 409, { error: "等待玩家入座" });
      if (seat < 0) return json(res, 403, { error: "你不在这个房间里" });
      if (room.state.current !== seat) return json(res, 409, { error: "还没轮到你" });

      const result = applyAction(room.state, body.action);
      if (!result.ok) return json(res, 400, { error: result.reason || "这步不合法" });
      room.state = result.state;
      room.updatedAt = Date.now();
      broadcast(room);
      return json(res, 200, publicRoom(room, clientId));
    }
  }

  return json(res, 404, { error: "未知接口" });
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const target = normalize(join(publicDir, safePath));
  if (!target.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(target);
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(target)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (handleExternalControl(req, res, url)) return;

  if (req.method === "OPTIONS" && url.pathname.startsWith("/api/external/")) {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url);
    } catch (error) {
      json(res, 500, { error: error.message || "服务器错误" });
    }
    return;
  }

  if (url.pathname.startsWith("/events/")) {
    const code = url.pathname.split("/")[2]?.toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      res.writeHead(404);
      res.end();
      return;
    }

    const clientId = url.searchParams.get("clientId") || "";
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const entry = { res, clientId };
    roomStreams(code).add(entry);
    if (setSeatConnected(room, clientId, true)) broadcast(room);
    sendStream(entry, room);

    req.on("close", () => {
      roomStreams(code).delete(entry);
      if (!hasActiveStream(code, clientId) && setSeatConnected(room, clientId, false)) broadcast(room);
    });
    return;
  }

  await serveStatic(res, decodeURIComponent(url.pathname));
});

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

server.listen(port, host, () => {
  console.log(`墙路棋已启动：`);
  console.log(`本机访问：http://localhost:${port}`);
  if (host === "0.0.0.0" || host === "::") {
    for (const address of lanAddresses()) {
      console.log(`同一网络设备访问：http://${address}:${port}`);
    }
  } else if (host !== "127.0.0.1" && host !== "localhost") {
    console.log(`同一网络设备访问：http://${host}:${port}`);
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用。可以先关闭旧窗口，或用 PORT=5175 另开一个端口。`);
  } else if (error.code === "EACCES" || error.code === "EPERM") {
    console.error(`当前环境不允许监听 ${host}:${port}，请尝试换端口或检查系统网络权限。`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
