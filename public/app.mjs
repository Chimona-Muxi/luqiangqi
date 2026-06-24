import {
  BOARD_SIZE,
  applyAction,
  cellName,
  createInitialState,
  getValidMoves,
  isLegalWall,
  shortestPath
} from "./engine.mjs";
import { chooseAiAction } from "./ai.mjs";

const CELL = 54;
const GAP = 12;
const STEP = CELL + GAP;
const TOTAL = CELL * BOARD_SIZE + GAP * (BOARD_SIZE - 1);
const SVG = "http://www.w3.org/2000/svg";

const els = {
  board: document.querySelector("#boardSvg"),
  modeTabs: document.querySelector("#modeTabs"),
  gameSubtitle: document.querySelector("#gameSubtitle"),
  setupPanel: document.querySelector("#setupPanel"),
  onlinePanel: document.querySelector("#onlinePanel"),
  modelPanel: document.querySelector("#modelPanel"),
  playerCountField: document.querySelector("#playerCountField"),
  difficultyField: document.querySelector("#difficultyField"),
  playerCount: document.querySelector("#playerCountSelect"),
  difficulty: document.querySelector("#difficultySelect"),
  onlinePlayerCount: document.querySelector("#onlinePlayerCountSelect"),
  modelHomeStep: document.querySelector("#modelHomeStep"),
  modelLocalStep: document.querySelector("#modelLocalStep"),
  modelApiStep: document.querySelector("#modelApiStep"),
  chooseLocalModel: document.querySelector("#chooseLocalModelButton"),
  chooseApiModel: document.querySelector("#chooseApiModelButton"),
  modelLocalBack: document.querySelector("#modelLocalBackButton"),
  modelApiBack: document.querySelector("#modelApiBackButton"),
  ollamaCommand: document.querySelector("#ollamaCommandText"),
  copyOllamaCommand: document.querySelector("#copyOllamaCommandButton"),
  ollamaUrl: document.querySelector("#ollamaUrlInput"),
  ollamaModel: document.querySelector("#ollamaModelInput"),
  modelLocalDifficulty: document.querySelector("#modelLocalDifficultySelect"),
  startLocalModel: document.querySelector("#startLocalModelButton"),
  apiKey: document.querySelector("#apiKeyInput"),
  apiBaseUrl: document.querySelector("#apiBaseUrlInput"),
  apiModel: document.querySelector("#apiModelInput"),
  modelApiDifficulty: document.querySelector("#modelApiDifficultySelect"),
  startApiModel: document.querySelector("#startApiModelButton"),
  newGame: document.querySelector("#newGameButton"),
  toolbox: document.querySelector("#toolbox"),
  statusTitle: document.querySelector("#statusTitle"),
  turnEyebrow: document.querySelector("#turnEyebrow"),
  players: document.querySelector("#playersList"),
  log: document.querySelector("#logList"),
  pathMetric: document.querySelector("#pathMetric"),
  wallMetric: document.querySelector("#wallMetric"),
  onlineName: document.querySelector("#onlineNameInput"),
  onlineHomeStep: document.querySelector("#onlineHomeStep"),
  onlineJoinStep: document.querySelector("#onlineJoinStep"),
  onlineRoomStep: document.querySelector("#onlineRoomStep"),
  createRoom: document.querySelector("#createRoomButton"),
  chooseJoin: document.querySelector("#chooseJoinButton"),
  joinCode: document.querySelector("#joinCodeInput"),
  joinRoom: document.querySelector("#joinRoomButton"),
  joinBack: document.querySelector("#joinBackButton"),
  roomBack: document.querySelector("#roomBackButton"),
  roomCard: document.querySelector("#roomCard"),
  roomStepTitle: document.querySelector("#roomStepTitle"),
  roomState: document.querySelector("#roomStateText"),
  roomCode: document.querySelector("#roomCodeText"),
  copyRoom: document.querySelector("#copyRoomButton"),
  externalCard: document.querySelector("#externalCard"),
  externalLinkText: document.querySelector("#externalLinkText"),
  copyExternal: document.querySelector("#copyExternalButton"),
  toast: document.querySelector("#toast")
};

const subtitles = {
  ai: "人机对弈",
  local: "同屏多人",
  online: "房间联机",
  model: "外脑对弈"
};

let mode = "ai";
let tool = "move";
let onlineRoom = null;
let onlineStep = "home";
let onlineRoomRole = "host";
let modelStep = "home";
let modelConfig = null;
let eventSource = null;
let game = createGame();
let aiTimer = null;
let aiRequestId = 0;
let toastTimer = null;

const activeRoomKey = "qiangluqi-active-room";
const clientId = getClientId();

function getClientId() {
  const key = "qiangluqi-client-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function createGame() {
  const onlineCount = Number(els.onlinePlayerCount?.value || els.playerCount?.value || 2);
  const playerCount = mode === "ai" || mode === "model" ? 2 : mode === "online" ? onlineCount : Number(els.playerCount?.value || 2);
  const external = mode === "model";
  const aiName = external ? modelAiName() : "AI";
  const state = createInitialState({
    playerCount,
    mode,
    aiDifficulty: external ? modelConfig?.difficulty || "steady" : els.difficulty?.value || "steady",
    aiEngine: external ? modelConfig?.provider || "ollama" : "builtin",
    aiSlots: mode === "ai" || mode === "model" ? [1] : [],
    names: mode === "ai" || mode === "model" ? ["你", aiName] : Array.from({ length: playerCount }, (_, index) => `玩家 ${index + 1}`)
  });
  state.aiEngine = external ? modelConfig?.provider || "ollama" : "builtin";
  return state;
}

function modelAiName() {
  return {
    ollama: "本地模型",
    api: "云端模型"
  }[modelConfig?.provider] || "外脑";
}

function providerName(value) {
  return {
    ollama: "本地模型",
    api: "云端 API"
  }[value] || "外脑";
}

function shortErrorNote(value) {
  const text = String(value || "").trim();
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1900);
}

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function cellCenter(row, col) {
  return {
    x: col * STEP + CELL / 2,
    y: row * STEP + CELL / 2
  };
}

function currentPlayer() {
  return game.players[game.current];
}

function canAct() {
  if (game.winner !== null) return false;
  if (mode === "model" && !modelConfig) return false;
  if (mode === "online") return onlineRoom?.started && onlineRoom.mySeat === game.current;
  if (mode === "ai" || mode === "model") return currentPlayer()?.kind !== "ai";
  return true;
}

function actionLockedReason() {
  if (game.winner !== null) return "对局已结束";
  if (mode === "model" && !modelConfig) return "请先选择外脑";
  if (mode === "online" && !onlineRoom?.started) return "等待玩家入座";
  if (mode === "online" && onlineRoom?.mySeat !== game.current) return "还没轮到你";
  if (mode === "ai" && currentPlayer()?.kind === "ai") return "AI 思考中";
  if (mode === "model" && currentPlayer()?.kind === "ai") return "外脑思考中";
  return "";
}

function resetOfflineGame() {
  aiRequestId += 1;
  closeEvents();
  onlineRoom = null;
  onlineStep = "home";
  game = createGame();
  tool = "move";
  render();
  queueAi();
}

function resetModelHome() {
  aiRequestId += 1;
  closeEvents();
  onlineRoom = null;
  modelStep = "home";
  modelConfig = null;
  game = createInitialState({ playerCount: 2, mode: "model", names: ["你", "外脑"] });
  tool = "move";
  render();
}

function startModelGame(config) {
  modelConfig = config;
  modelStep = config.provider === "api" ? "api" : "local";
  resetOfflineGame();
}

function closeEvents() {
  if (eventSource) eventSource.close();
  eventSource = null;
}

function readActiveRoom() {
  try {
    return JSON.parse(localStorage.getItem(activeRoomKey) || "null");
  } catch {
    return null;
  }
}

function saveActiveRoom(room, role = onlineRoomRole) {
  if (!room?.code || mode !== "online" || room.mySeat < 0) return;
  localStorage.setItem(activeRoomKey, JSON.stringify({
    code: room.code,
    role,
    savedAt: Date.now()
  }));
}

function clearActiveRoom() {
  localStorage.removeItem(activeRoomKey);
}

function resetOnlineLobby() {
  aiRequestId += 1;
  closeEvents();
  onlineRoom = null;
  onlineStep = "home";
  onlineRoomRole = "host";
  clearActiveRoom();
  game = createInitialState({
    playerCount: Number(els.onlinePlayerCount?.value || 2),
    mode: "online"
  });
  tool = "move";
  render();
}

function withRoomState(room) {
  onlineRoom = room;
  game = room.state;
  saveActiveRoom(room);
  render();
}

async function api(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function fetchRoom(code) {
  const response = await fetch(`/api/rooms/${code}?clientId=${encodeURIComponent(clientId)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "房间不存在");
  return data;
}

function connectRoomEvents(code) {
  closeEvents();
  eventSource = new EventSource(`/events/${code}?clientId=${encodeURIComponent(clientId)}`);
  eventSource.onmessage = (event) => withRoomState(JSON.parse(event.data));
  eventSource.onerror = () => showToast("联机同步正在重连");
}

async function restoreActiveRoom({ quiet = false } = {}) {
  const saved = readActiveRoom();
  if (!saved?.code) return false;

  try {
    const room = await fetchRoom(saved.code);
    if (room.mySeat < 0) throw new Error("座位已失效");
    mode = "online";
    onlineRoomRole = saved.role || (room.mySeat === 0 ? "host" : "guest");
    onlineStep = "room";
    withRoomState(room);
    connectRoomEvents(room.code);
    if (!quiet) showToast("已回到房间");
    return true;
  } catch {
    clearActiveRoom();
    if (!quiet) showToast("原房间已失效");
    return false;
  }
}

function externalStateUrl() {
  if (!onlineRoom?.external?.stateUrl) return "";
  return new URL(onlineRoom.external.stateUrl, window.location.origin).href;
}

function absoluteExternalUrl(value) {
  return value ? new URL(value, window.location.origin).href : "";
}

function externalAccessText() {
  const external = onlineRoom?.external;
  if (!external) return "";
  const seat = Number(external.seat ?? 1);
  const controlUrl = absoluteExternalUrl(external.controlUrl || external.controlPath);
  const freshControlUrl = controlUrl ? new URL(controlUrl) : null;
  if (freshControlUrl) freshControlUrl.searchParams.set("fresh", String(Date.now()));
  return [
    "墙路棋外部玩家控制页",
    `座位：玩家 ${seat + 1}`,
    `${freshControlUrl?.href || ""}`,
    "打开后页面里会显示当前局面、刷新链接和可直接打开的合法动作链接。"
  ].join("\n");
}

async function createRoom() {
  try {
    const room = await api("/api/rooms", {
      clientId,
      name: els.onlineName.value,
      playerCount: Number(els.onlinePlayerCount.value)
    });
    onlineRoomRole = "host";
    onlineStep = "room";
    withRoomState(room);
    saveActiveRoom(room, onlineRoomRole);
    connectRoomEvents(room.code);
    showToast("房间已创建");
  } catch (error) {
    showToast(error.message.includes("Failed") ? "请先用启动脚本打开游戏" : error.message);
  }
}

async function joinRoom() {
  const code = els.joinCode.value.trim().toUpperCase();
  if (!code) return showToast("请输入房间码");
  try {
    const room = await api(`/api/rooms/${code}/join`, {
      clientId,
      name: els.onlineName.value
    });
    onlineRoomRole = "guest";
    onlineStep = "room";
    withRoomState(room);
    saveActiveRoom(room, onlineRoomRole);
    connectRoomEvents(room.code);
    showToast("已加入房间");
  } catch (error) {
    showToast(error.message.includes("Failed") ? "请先用启动脚本打开游戏" : error.message);
  }
}

async function sendAction(action) {
  if (!canAct()) {
    const reason = actionLockedReason();
    if (reason) showToast(reason);
    return;
  }

  if (mode === "online") {
    try {
      const room = await api(`/api/rooms/${onlineRoom.code}/action`, { clientId, action });
      withRoomState(room);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const result = applyAction(game, action);
  if (!result.ok) {
    showToast(result.reason || "这步不合法");
    return;
  }
  game = result.state;
  if (game.winner !== null) tool = "move";
  render();
  queueAi();
}

function queueAi() {
  clearTimeout(aiTimer);
  if ((mode !== "ai" && mode !== "model") || game.winner !== null || currentPlayer()?.kind !== "ai") return;
  const requestId = aiRequestId + 1;
  aiRequestId = requestId;
  aiTimer = setTimeout(async () => {
    const snapshot = JSON.parse(JSON.stringify(game));
    const external = mode === "model";
    const engine = external ? modelConfig?.provider || snapshot.aiEngine || "ollama" : "builtin";
    let action = null;
    let note = "";

    if (!external) {
      action = chooseAiAction(snapshot, snapshot.aiDifficulty);
    } else {
      try {
        const result = await api("/api/ai/action", {
          state: snapshot,
          provider: engine,
          difficulty: snapshot.aiDifficulty,
          config: modelConfig
        });
        action = result.action;
        note = result.note || "";
        if (result.source === "builtin-fallback") {
          showToast(shortErrorNote(note) ? `外脑暂不可用：${shortErrorNote(note)}` : "外脑暂不可用，已用高速 AI");
        }
      } catch (error) {
        action = chooseAiAction(snapshot, snapshot.aiDifficulty);
        note = error.message;
        showToast(shortErrorNote(note) ? `外脑未响应：${shortErrorNote(note)}` : "外脑未响应，已用高速 AI");
      }
    }

    if (requestId !== aiRequestId || (mode !== "ai" && mode !== "model") || game.winner !== null || currentPlayer()?.kind !== "ai") return;
    if (!action) return;
    const result = applyAction(game, action);
    if (result.ok) {
      game = result.state;
      render();
    } else if (external) {
      const fallback = chooseAiAction(game, game.aiDifficulty);
      const fallbackResult = fallback ? applyAction(game, fallback) : null;
      if (fallbackResult?.ok) {
        game = fallbackResult.state;
        render();
        showToast(note || "外脑返回了非法动作，已用高速 AI");
      }
    }
  }, 520);
}

function renderGoals(svg) {
  for (const player of game.players) {
    const attrs = {
      class: "goal-band",
      fill: player.color,
      rx: 6,
      ry: 6
    };
    if (player.goal.edge === "row") {
      attrs.x = 0;
      attrs.y = player.goal.value === 0 ? -10 : TOTAL;
      attrs.width = TOTAL;
      attrs.height = 7;
    } else {
      attrs.x = player.goal.value === 0 ? -10 : TOTAL;
      attrs.y = 0;
      attrs.width = 7;
      attrs.height = TOTAL;
    }
    svg.appendChild(svgEl("rect", attrs));
  }
}

function renderCells(svg) {
  const moveSet = new Set(getValidMoves(game).map((cell) => `${cell.row},${cell.col}`));
  const actionable = canAct() && tool === "move";

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const target = actionable && moveSet.has(`${row},${col}`);
      const rect = svgEl("rect", {
        x: col * STEP,
        y: row * STEP,
        width: CELL,
        height: CELL,
        rx: 8,
        ry: 8,
        class: `cell ${(row + col) % 2 ? "alt" : ""} ${target ? "target" : ""}`
      });
      if (target) rect.addEventListener("click", () => sendAction({ type: "move", row, col }));
      svg.appendChild(rect);
    }
  }
}

function renderWallSlots(svg) {
  if (!canAct() || tool === "move") return;
  const orientation = tool;

  for (let row = 0; row < BOARD_SIZE - 1; row += 1) {
    for (let col = 0; col < BOARD_SIZE - 1; col += 1) {
      const wall = { type: "wall", orientation, row, col };
      const legal = isLegalWall(game, wall);
      const attrs = orientation === "h"
        ? { x: col * STEP, y: row * STEP + CELL, width: CELL * 2 + GAP, height: GAP }
        : { x: col * STEP + CELL, y: row * STEP, width: GAP, height: CELL * 2 + GAP };
      const rect = svgEl("rect", {
        ...attrs,
        rx: 5,
        ry: 5,
        class: `wall-slot ${legal ? "legal" : "illegal"}`
      });
      rect.addEventListener("click", () => sendAction(wall));
      svg.appendChild(rect);
    }
  }
}

function renderPlacedWalls(svg) {
  for (const orientation of ["h", "v"]) {
    for (const wall of game.walls[orientation] || []) {
      const attrs = orientation === "h"
        ? { x: wall.col * STEP, y: wall.row * STEP + CELL, width: CELL * 2 + GAP, height: GAP }
        : { x: wall.col * STEP + CELL, y: wall.row * STEP, width: GAP, height: CELL * 2 + GAP };
      svg.appendChild(svgEl("rect", {
        ...attrs,
        rx: 5,
        ry: 5,
        class: "wall-placed"
      }));
    }
  }
}

function renderPawns(svg) {
  for (const player of game.players) {
    const center = cellCenter(player.row, player.col);
    const group = svgEl("g", {
      class: `pawn ${player.id === game.current && game.winner === null ? "current" : ""}`
    });
    group.appendChild(svgEl("circle", {
      cx: center.x,
      cy: center.y,
      r: 26,
      class: "pawn-ring"
    }));
    group.appendChild(svgEl("circle", {
      cx: center.x,
      cy: center.y,
      r: 18,
      fill: player.color
    }));
    const label = svgEl("text", {
      x: center.x,
      y: center.y + 0.5,
      class: "pawn-label"
    });
    label.textContent = player.label;
    group.appendChild(label);
    svg.appendChild(group);
  }
}

function renderBoard() {
  els.board.setAttribute("viewBox", `-14 -14 ${TOTAL + 28} ${TOTAL + 28}`);
  els.board.replaceChildren();
  const bg = svgEl("rect", {
    x: -14,
    y: -14,
    width: TOTAL + 28,
    height: TOTAL + 28,
    rx: 14,
    fill: "rgba(255,255,255,0.38)"
  });
  els.board.appendChild(bg);
  renderGoals(els.board);
  renderCells(els.board);
  renderWallSlots(els.board);
  renderPlacedWalls(els.board);
  renderPawns(els.board);
}

function renderPlayers() {
  els.players.replaceChildren();
  const seats = onlineRoom?.seats || [];

  for (const player of game.players) {
    const card = document.createElement("article");
    card.className = `player-card ${player.id === game.current && game.winner === null ? "current" : ""}`;

    const dot = document.createElement("span");
    dot.className = "player-dot";
    dot.style.background = player.color;

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = mode === "online" ? seats[player.id]?.name || player.name : player.name;
    const meta = document.createElement("small");
    const seatText = mode === "online" && !seats[player.id]?.occupied ? "空位" : player.goal.edge === "row"
      ? `目标 ${player.goal.value === 0 ? "北线" : "南线"}`
      : `目标 ${player.goal.value === 0 ? "西线" : "东线"}`;
    meta.textContent = `${player.label} · ${seatText}`;
    info.append(name, meta);

    const walls = document.createElement("span");
    walls.className = "wall-pill";
    walls.textContent = `${player.walls} 墙`;

    card.append(dot, info, walls);
    els.players.appendChild(card);
  }
}

function renderLog() {
  els.log.replaceChildren();
  const startText = mode === "online" && !onlineRoom?.started
    ? "等待房间满员"
    : mode === "model" && !modelConfig
      ? "选择一个外脑类型"
      : "棋局开始";
  const entries = game.log?.length ? game.log : [{ text: startText }];
  for (const entry of entries.slice(0, 18)) {
    const item = document.createElement("li");
    item.textContent = entry.text;
    els.log.appendChild(item);
  }
}

function renderStatus() {
  const player = currentPlayer();
  els.gameSubtitle.textContent = subtitles[mode];
  els.turnEyebrow.textContent = game.winner !== null ? "终局" : `第 ${game.turn} 手`;

  if (game.winner !== null) {
    els.statusTitle.textContent = `${game.players[game.winner].name} 获胜`;
  } else if (mode === "model" && !modelConfig) {
    els.statusTitle.textContent = "选择外脑";
  } else if (mode === "online" && !onlineRoom?.started) {
    const occupied = onlineRoom?.seats?.filter((seat) => seat.occupied).length || 0;
    els.statusTitle.textContent = `等待玩家 ${occupied}/${game.playerCount}`;
  } else {
    els.statusTitle.textContent = `轮到 ${player.name}`;
  }

  els.pathMetric.textContent = game.players.map((item) => shortestPath(game, item.id)).join(" / ");
  els.wallMetric.textContent = game.players.map((item) => item.walls).join(" / ");

  const occupied = onlineRoom?.seats?.filter((seat) => seat.occupied).length || 0;
  els.onlineHomeStep.classList.toggle("hidden", onlineStep !== "home");
  els.onlineJoinStep.classList.toggle("hidden", onlineStep !== "join");
  els.onlineRoomStep.classList.toggle("hidden", onlineStep !== "room");
  els.modelHomeStep.classList.toggle("hidden", modelStep !== "home");
  els.modelLocalStep.classList.toggle("hidden", modelStep !== "local");
  els.modelApiStep.classList.toggle("hidden", modelStep !== "api");
  els.roomCard.classList.toggle("hidden", !onlineRoom || onlineStep !== "room");
  els.externalCard.classList.toggle("hidden", !onlineRoom?.external || onlineStep !== "room");
  els.roomStepTitle.textContent = onlineRoomRole === "guest" ? "已加入房间" : "房间已创建";
  els.roomState.textContent = onlineRoom
    ? onlineRoom.started
      ? "对局进行中"
      : `等待玩家 ${occupied}/${onlineRoom.playerCount}`
    : "等待玩家";
  els.roomCode.textContent = onlineRoom?.code || "-----";
  els.externalLinkText.textContent = onlineRoom?.external ? "外部可接入" : "未启用";
  els.setupPanel.classList.toggle("hidden", mode === "online" || mode === "model");
  els.onlinePanel.classList.toggle("hidden", mode !== "online");
  els.modelPanel.classList.toggle("hidden", mode !== "model");
  els.playerCountField.classList.toggle("hidden", mode === "ai");
  els.difficultyField.classList.toggle("hidden", mode !== "ai");
}

function renderControls() {
  els.modeTabs.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  els.toolbox.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === tool);
  });
}

function render() {
  if (currentPlayer()?.walls <= 0 && tool !== "move") tool = "move";
  renderControls();
  renderStatus();
  renderPlayers();
  renderLog();
  renderBoard();
}

els.modeTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  mode = button.dataset.mode;
  if (mode === "online") {
    aiRequestId += 1;
    restoreActiveRoom({ quiet: true }).then((restored) => {
      if (restored) return;
      game = createInitialState({ playerCount: Number(els.onlinePlayerCount.value), mode: "online" });
      onlineRoom = null;
      onlineStep = "home";
      closeEvents();
      render();
    });
    return;
  }
  if (mode === "model") {
    resetModelHome();
    return;
  }
  resetOfflineGame();
});

els.toolbox.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tool]");
  if (!button) return;
  tool = button.dataset.tool;
  render();
});

els.newGame.addEventListener("click", resetOfflineGame);
els.playerCount.addEventListener("change", () => {
  if (mode === "local") resetOfflineGame();
  if (mode === "online" && !onlineRoom) {
    game = createInitialState({ playerCount: Number(els.playerCount.value), mode: "online" });
    render();
  }
});
els.onlinePlayerCount.addEventListener("change", () => {
  if (mode === "online" && !onlineRoom) {
    game = createInitialState({ playerCount: Number(els.onlinePlayerCount.value), mode: "online" });
    render();
  }
});
els.difficulty.addEventListener("change", resetOfflineGame);
els.chooseLocalModel.addEventListener("click", () => {
  modelStep = "local";
  render();
});
els.chooseApiModel.addEventListener("click", () => {
  modelStep = "api";
  render();
});
els.modelLocalBack.addEventListener("click", resetModelHome);
els.modelApiBack.addEventListener("click", resetModelHome);
els.copyOllamaCommand.addEventListener("click", async () => {
  await navigator.clipboard?.writeText(els.ollamaCommand.textContent);
  showToast("启动命令已复制");
});
els.startLocalModel.addEventListener("click", () => {
  startModelGame({
    provider: "ollama",
    difficulty: els.modelLocalDifficulty.value,
    ollamaUrl: els.ollamaUrl.value.trim(),
    ollamaModel: els.ollamaModel.value.trim()
  });
});
els.startApiModel.addEventListener("click", () => {
  if (!els.apiKey.value.trim()) return showToast("请输入 API Key");
  startModelGame({
    provider: "api",
    difficulty: els.modelApiDifficulty.value,
    apiKey: els.apiKey.value.trim(),
    apiBaseUrl: els.apiBaseUrl.value.trim(),
    apiModel: els.apiModel.value.trim()
  });
});
els.createRoom.addEventListener("click", createRoom);
els.chooseJoin.addEventListener("click", () => {
  onlineStep = "join";
  onlineRoom = null;
  closeEvents();
  render();
  els.joinCode.focus();
});
els.joinRoom.addEventListener("click", joinRoom);
els.joinBack.addEventListener("click", resetOnlineLobby);
els.roomBack.addEventListener("click", resetOnlineLobby);
els.joinCode.addEventListener("input", () => {
  els.joinCode.value = els.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
});
els.copyRoom.addEventListener("click", async () => {
  if (!onlineRoom) return;
  await navigator.clipboard?.writeText(onlineRoom.code);
  showToast("房间码已复制");
});
els.copyExternal.addEventListener("click", async () => {
  const text = externalAccessText() || externalStateUrl();
  if (!text) return;
  await navigator.clipboard?.writeText(text);
  showToast("外部接入链接已复制");
});

restoreActiveRoom({ quiet: true }).then((restored) => {
  if (!restored) render();
});
