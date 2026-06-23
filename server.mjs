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
const hostedBotTimers = new Map();

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

function addHostedBotSeat(room, seatIndex, name, options = {}) {
  const target = Number.isInteger(seatIndex) ? seatIndex : room.seats.findIndex((seat, index) => index > 0 && !seat.clientId);
  if (target < 0 || target >= room.playerCount) return -1;
  if (room.seats[target].clientId) return -1;

  const clientId = `hosted:${room.code}:${target}`;
  const displayName = cleanName(name, `托管 AI ${target + 1}`);
  room.seats[target] = {
    clientId,
    name: displayName,
    connected: true,
    hosted: true
  };
  room.hostedBots[target] = {
    provider: options.provider || "api",
    difficulty: options.difficulty || "hard",
    name: displayName
  };
  room.state.players[target].name = displayName;
  room.started = room.seats.every((seat) => Boolean(seat.clientId));
  room.updatedAt = Date.now();
  return target;
}

function setSeatConnected(room, clientId, connected) {
  const seat = room.seats.find((item) => item.clientId === clientId);
  if (!seat) return false;
  if (seat.hosted) {
    seat.connected = true;
    return true;
  }
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

  return {
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
      hosted: Boolean(seat.hosted),
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
    hostedBots: {},
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

function currentHostedBot(room) {
  if (!room.started || room.state.winner !== null) return null;
  const seatIndex = room.state.current;
  const bot = room.hostedBots?.[seatIndex];
  return bot ? { seatIndex, bot } : null;
}

function scheduleHostedBot(room) {
  const current = currentHostedBot(room);
  if (!current || hostedBotTimers.has(room.code)) return;

  const scheduledTurn = room.state.turn;
  const scheduledSeat = current.seatIndex;
  hostedBotTimers.set(room.code, setTimeout(async () => {
    hostedBotTimers.delete(room.code);
    const liveRoom = rooms.get(room.code);
    const liveBot = liveRoom ? currentHostedBot(liveRoom) : null;
    if (!liveRoom || !liveBot || liveRoom.state.turn !== scheduledTurn || liveRoom.state.current !== scheduledSeat) return;

    try {
      const decision = await chooseExternalAiAction(liveRoom.state, {
        provider: liveBot.bot.provider,
        difficulty: liveBot.bot.difficulty,
        config: {}
      });
      if (!decision.action) return;
      const result = applyAction(liveRoom.state, decision.action);
      if (!result.ok) return;
      liveRoom.state = result.state;
      liveRoom.updatedAt = Date.now();
      broadcast(liveRoom);
      scheduleHostedBot(liveRoom);
    } catch {
      scheduleHostedBot(liveRoom);
    }
  }, 650));
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

function externalStatePayload(room, requestedSeat, origin = "") {
  const seat = normalizeSeat(room, requestedSeat);
  const endpoints = externalEndpoints(room, seat, origin);
  const serverNow = Date.now();
  const freshStatePath = `${endpoints.statePath}&fresh=${serverNow}`;
  const rawAi = publicExternalState(room.state, seat);
  const canAct = room.started && room.state.current === seat && !room.state.winner;
  const legalActions = canAct ? rawAi.legalActions : [];
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
    external: {
      ...endpoints,
      freshStateUrl: withOrigin(origin, freshStatePath),
      freshStatePath,
      joinExample: {
        url: endpoints.joinUrl,
        path: endpoints.joinPath
      },
      stateExample: {
        url: endpoints.stateUrl,
        path: endpoints.statePath
      },
      actionExample: {
        url: legalActions[0]
          ? withOrigin(origin, `${endpoints.actionPath}?key=${encodeURIComponent(room.externalKey)}&seat=${seat}&id=${encodeURIComponent(legalActions[0].id)}`)
          : "",
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
      moveHistory: room.state.moveHistory || []
    }
  };
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
      return json(res, 200, externalStatePayload(room, parseSeat(url.searchParams.get("seat"), defaultExternalSeat(room)), requestOrigin(req)), headers);
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
      scheduleHostedBot(room);
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
      scheduleHostedBot(room);
      return json(res, 200, publicRoom(room, clientId));
    }

    if (method === "POST" && parts[3] === "hosted-ai") {
      const body = await bodyJson(req);
      const clientId = String(body.clientId || "");
      if (!clientId) return json(res, 400, { error: "缺少客户端标识" });
      const hostSeat = room.seats.findIndex((item) => item.clientId === clientId);
      if (hostSeat !== 0) return json(res, 403, { error: "只有房主可以添加托管 AI" });
      const seatIndex = parseSeat(body.seat, room.seats.findIndex((seat, index) => index > 0 && !seat.clientId));
      const seat = addHostedBotSeat(room, seatIndex, body.name || "托管 AI", {
        provider: body.provider,
        difficulty: body.difficulty
      });
      if (seat < 0) return json(res, 409, { error: "这个座位不可用" });
      broadcast(room);
      scheduleHostedBot(room);
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
      scheduleHostedBot(room);
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
