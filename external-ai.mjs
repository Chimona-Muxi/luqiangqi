import {
  BOARD_SIZE,
  applyAction,
  cellName,
  getLegalWalls,
  getValidMoves,
  shortestPath,
  wallName
} from "./public/engine.mjs";
import { chooseAiAction } from "./public/ai.mjs";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:14b";
const DEFAULT_API_MODEL = "deepseek-chat";
const REQUEST_TIMEOUT_MS = 30000;
const API_REQUEST_TIMEOUT_MS = 75000;
const WALL_PROMPT_LIMIT = 36;

export const EXTERNAL_RULES = [
  "这是墙路棋/Quoridor：棋盘为 9x9，玩家从自己起点出发，先到达对边者获胜。",
  "每回合只能二选一：移动棋子，或放置一面墙。",
  "移动和放墙都必须从 legalActions 里选择，不能自己编坐标。",
  "动作 id 形如 move:E8 或 wall:h:E7。提交动作时只需要返回其中一个 id。",
  "服务器会校验动作是否合法并真正落子。"
];

function providerLabel(provider) {
  return {
    ollama: "本地千问",
    api: "云端大模型",
    hybrid: "混合外脑",
    builtin: "高速策略 AI"
  }[provider] || provider;
}

function normalizeBaseUrl(value, fallback) {
  const raw = String(value || fallback).trim().replace(/\/+$/, "");
  if (!raw) return fallback;
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

function actionId(action) {
  if (action.type === "move") return `move:${cellName(action.row, action.col)}`;
  return `wall:${action.orientation}:${cellName(action.row, action.col)}`;
}

function parseCellName(value) {
  const match = String(value || "").trim().toUpperCase().match(/^([A-I])([1-9])$/);
  if (!match) return null;
  return {
    row: BOARD_SIZE - Number(match[2]),
    col: match[1].charCodeAt(0) - 65
  };
}

function actionText(action) {
  if (action.type === "move") return `移动到 ${cellName(action.row, action.col)}`;
  return `放置${wallName(action)}`;
}

function buildActionEntry(action) {
  return {
    id: actionId(action),
    action,
    text: actionText(action)
  };
}

function actionMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.id, entry.action);
    map.set(entry.id.toLowerCase(), entry.action);
  }
  return map;
}

function rankWallCandidates(state, playerId, limit = WALL_PROMPT_LIMIT) {
  const me = state.players[playerId];
  if (!me || me.walls <= 0) return [];

  const beforeMine = shortestPath(state, playerId);
  const beforeOpponents = state.players
    .filter((player) => player.id !== playerId)
    .map((player) => ({ id: player.id, distance: shortestPath(state, player.id) }));

  return getLegalWalls(state, playerId)
    .map((wall) => ({ type: "wall", ...wall }))
    .map((wall) => {
      const result = applyAction(state, wall);
      if (!result.ok) return null;

      const afterMine = shortestPath(result.state, playerId);
      const selfCost = afterMine - beforeMine;
      let opponentGain = 0;
      let urgentGain = 0;

      for (const opponent of beforeOpponents) {
        const after = shortestPath(result.state, opponent.id);
        const gain = Math.max(0, after - opponent.distance);
        const urgency = opponent.distance <= 2 ? 3.2 : opponent.distance <= 4 ? 1.8 : 1;
        opponentGain += gain * urgency;
        if (opponent.distance <= 2 && after > opponent.distance) urgentGain += 1;
      }

      return {
        wall,
        score: opponentGain * 16 + urgentGain * 24 - selfCost * (selfCost > 1 ? 12 : 5)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.wall);
}

export function legalActionEntries(state, playerId = state.current, options = {}) {
  const moves = getValidMoves(state, playerId).map((cell) => ({ type: "move", row: cell.row, col: cell.col }));
  const walls = rankWallCandidates(state, playerId, options.wallLimit || WALL_PROMPT_LIMIT);
  return [...moves, ...walls].map(buildActionEntry);
}

function goalText(player) {
  if (player.goal.edge === "row") return player.goal.value === 0 ? "北线" : "南线";
  return player.goal.value === 0 ? "西线" : "东线";
}

function compactStateForPrompt(state, playerId, actions) {
  const current = state.players[playerId];
  const players = state.players.map((player) => ({
    id: player.id,
    label: player.label,
    name: player.name,
    cell: cellName(player.row, player.col),
    goal: goalText(player),
    walls: player.walls,
    shortestPath: shortestPath(state, player.id)
  }));

  const walls = [
    ...(state.walls.h || []).map((wall) => `h:${cellName(wall.row, wall.col)}`),
    ...(state.walls.v || []).map((wall) => `v:${cellName(wall.row, wall.col)}`)
  ];

  return [
    `你正在下墙路棋，当前轮到玩家 ${current.label} / ${current.name}。`,
    `你的目标：${goalText(current)}。`,
    `棋局手数：${state.turn}。`,
    `玩家状态：${JSON.stringify(players)}`,
    `已放墙：${walls.length ? walls.join(", ") : "无"}`,
    `最近记录：${(state.log || []).slice(0, 8).map((entry) => entry.text).join("；") || "无"}`,
    "LEGAL_ACTIONS 里每个 id 都是当前局面的合法动作。你必须只选其中一个 id。",
    actions.map((entry) => `${entry.id} = ${entry.text}`).join("\n")
  ].join("\n");
}

function buildMessages(state, playerId, actions) {
  return [
    {
      role: "system",
      content: [
        "你是墙路棋/Quoridor 的对弈 AI。",
        "你只允许从用户给出的 LEGAL_ACTIONS 中选择一个动作。",
        "优先考虑：立即获胜、防止对手下一步获胜、缩短自己的最短路、用墙显著拉长领先对手的路线。",
        "返回必须是纯 JSON，不要 Markdown，不要解释。",
        '格式：{"id":"move:E8","reason":"简短原因"}'
      ].join("\n")
    },
    {
      role: "user",
      content: compactStateForPrompt(state, playerId, actions)
    }
  ];
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // fall through to loose extraction
      }
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalizeActionShape(input) {
  if (!input || typeof input !== "object") return null;
  const raw = input.action && typeof input.action === "object" ? input.action : input;
  const type = String(raw.type || raw.action || "").toLowerCase();

  if (type === "move" || type === "移动") {
    const cell = parseCellName(raw.cell || raw.to || raw.target);
    const row = cell ? cell.row : Number(raw.row);
    const col = cell ? cell.col : Number(raw.col);
    return Number.isInteger(row) && Number.isInteger(col) ? { type: "move", row, col } : null;
  }

  if (type === "wall" || type === "放墙" || type === "墙") {
    const cell = parseCellName(raw.cell || raw.at || raw.target);
    const orientationText = String(raw.orientation || raw.dir || raw.direction || "").toLowerCase();
    const orientation = orientationText.startsWith("v") || orientationText.includes("竖") ? "v" : "h";
    const row = cell ? cell.row : Number(raw.row);
    const col = cell ? cell.col : Number(raw.col);
    return Number.isInteger(row) && Number.isInteger(col) ? { type: "wall", orientation, row, col } : null;
  }

  return null;
}

export function resolveActionInput(state, input, playerId = state.current) {
  const legal = legalActionEntries(state, playerId, { wallLimit: 128 });
  const byId = actionMap(legal);
  const rawId = typeof input === "string" ? input : input?.id;
  if (rawId && byId.has(String(rawId))) return byId.get(String(rawId));
  if (rawId && byId.has(String(rawId).toLowerCase())) return byId.get(String(rawId).toLowerCase());

  const text = typeof input === "string" ? input : JSON.stringify(input || {});
  for (const entry of legal) {
    if (text.includes(entry.id) || text.toLowerCase().includes(entry.id.toLowerCase())) return entry.action;
  }

  const shaped = normalizeActionShape(input);
  if (!shaped) return null;
  return byId.get(actionId(shaped)) || null;
}

function resolveModelAction(state, modelText, playerId, actions) {
  const parsed = extractJsonObject(modelText);
  if (parsed) {
    const byId = actionMap(actions);
    if (parsed.id && byId.has(String(parsed.id))) return byId.get(String(parsed.id));
    if (parsed.id && byId.has(String(parsed.id).toLowerCase())) return byId.get(String(parsed.id).toLowerCase());
    const shaped = normalizeActionShape(parsed);
    if (shaped && byId.has(actionId(shaped))) return byId.get(actionId(shaped));
    if (shaped && byId.has(actionId(shaped).toLowerCase())) return byId.get(actionId(shaped).toLowerCase());
  }

  const text = String(modelText || "");
  const lowerText = text.toLowerCase();
  for (const entry of actions) {
    if (text.includes(entry.id) || lowerText.includes(entry.id.toLowerCase())) return entry.action;
  }

  return resolveActionInput(state, parsed || modelText, playerId);
}

async function fetchTextWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonResponse(text, label) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} 返回了无法解析的数据`);
  }
}

function responseError(label, response, text) {
  let detail = String(text || "").slice(0, 180);
  try {
    const data = JSON.parse(text);
    detail = data?.error?.message || data?.message || detail;
  } catch {
    // keep plain text detail
  }
  return `${label} 返回 ${response.status}${detail ? `：${detail}` : ""}`;
}

async function callOllama(messages, config = {}) {
  const baseUrl = normalizeBaseUrl(config.ollamaUrl || process.env.LQQ_OLLAMA_URL || process.env.OLLAMA_HOST, DEFAULT_OLLAMA_URL);
  const model = config.ollamaModel || process.env.LQQ_OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
  const { response, text } = await fetchTextWithTimeout(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: 0.15,
        num_ctx: 4096
      }
    })
  }, Number(config.timeoutMs || process.env.LQQ_OLLAMA_TIMEOUT_MS || REQUEST_TIMEOUT_MS));
  if (!response.ok) throw new Error(responseError("Ollama", response, text));
  const data = parseJsonResponse(text, "Ollama");
  return data?.message?.content || data?.response || "";
}

function apiChatUrl(config = {}) {
  if (config.apiUrl) return config.apiUrl;
  if (process.env.LQQ_LLM_API_URL) return process.env.LQQ_LLM_API_URL;
  if (process.env.OPENAI_API_URL) return process.env.OPENAI_API_URL;
  const base = normalizeBaseUrl(config.apiBaseUrl || process.env.LQQ_LLM_BASE_URL || process.env.OPENAI_BASE_URL, "https://api.deepseek.com");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

async function callApiModel(messages, config = {}) {
  const apiKey = config.apiKey || process.env.LQQ_LLM_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey && process.env.LQQ_LLM_ALLOW_NO_KEY !== "1") {
    throw new Error("未配置大模型 API key");
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const { response, text } = await fetchTextWithTimeout(apiChatUrl(config), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.apiModel || process.env.LQQ_LLM_MODEL || process.env.OPENAI_MODEL || DEFAULT_API_MODEL,
      messages,
      temperature: Number(config.temperature || process.env.LQQ_LLM_TEMPERATURE || 0.15)
    })
  }, Number(config.timeoutMs || process.env.LQQ_LLM_TIMEOUT_MS || API_REQUEST_TIMEOUT_MS));
  if (!response.ok) throw new Error(responseError("API", response, text));
  const data = parseJsonResponse(text, "API");
  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
}

async function askProvider(provider, messages, config = {}) {
  if (provider === "ollama") return callOllama(messages, config);
  if (provider === "api") return callApiModel(messages, config);
  throw new Error(`未知外部 AI：${provider}`);
}

export async function chooseExternalAiAction(state, options = {}) {
  const playerId = state.current;
  const difficulty = options.difficulty || state.aiDifficulty || "steady";
  const provider = options.provider || state.aiEngine || "ollama";
  const config = options.config || {};
  const fallback = chooseAiAction(state, difficulty);
  const actions = legalActionEntries(state, playerId);
  if (!actions.length) return { action: fallback, source: "builtin-fallback", note: "没有可用外部动作" };

  const providers = provider === "hybrid" ? ["ollama", "api"] : [provider];
  const messages = buildMessages(state, playerId, actions);
  const errors = [];

  for (const item of providers) {
    try {
      const text = await askProvider(item, messages, config);
      const action = resolveModelAction(state, text, playerId, actions);
      if (action) return { action, source: item, note: providerLabel(item) };
      errors.push(`${providerLabel(item)} 返回了无法识别的动作`);
    } catch (error) {
      errors.push(`${providerLabel(item)}：${error.message}`);
    }
  }

  return {
    action: fallback,
    source: "builtin-fallback",
    note: errors.join("；") || "外部 AI 暂不可用"
  };
}

export function publicExternalState(state, playerId = state.current) {
  const actions = legalActionEntries(state, playerId, { wallLimit: 64 });
  return {
    boardSize: BOARD_SIZE,
    current: state.current,
    requestedSeat: playerId,
    turn: state.turn,
    winner: state.winner,
    players: state.players.map((player) => ({
      id: player.id,
      label: player.label,
      name: player.name,
      cell: cellName(player.row, player.col),
      goal: goalText(player),
      walls: player.walls,
      shortestPath: shortestPath(state, player.id)
    })),
    walls: {
      h: (state.walls.h || []).map((wall) => cellName(wall.row, wall.col)),
      v: (state.walls.v || []).map((wall) => cellName(wall.row, wall.col))
    },
    legalActions: actions,
    rules: EXTERNAL_RULES,
    responseFormat: {
      id: actions[0]?.id || "move:E8",
      note: "从 legalActions 选择一个 id，不要提交不在列表里的动作。"
    }
  };
}
