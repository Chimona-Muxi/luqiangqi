export const BOARD_SIZE = 9;
export const WALL_LIMITS = { 2: 10, 3: 6, 4: 5 };

export const PLAYER_TEMPLATES = [
  { label: "南", color: "#1b7f67", row: 8, col: 4, goal: { edge: "row", value: 0 } },
  { label: "北", color: "#d6534f", row: 0, col: 4, goal: { edge: "row", value: 8 } },
  { label: "西", color: "#2f5fb3", row: 4, col: 0, goal: { edge: "col", value: 8 } },
  { label: "东", color: "#b98a14", row: 4, col: 8, goal: { edge: "col", value: 0 } }
];

const DIRS = [
  { dr: -1, dc: 0 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
  { dr: 0, dc: 1 }
];

export function createInitialState(options = {}) {
  const playerCount = Math.max(2, Math.min(4, Number(options.playerCount) || 2));
  const wallLimit = WALL_LIMITS[playerCount] || 10;
  const aiSlots = new Set(options.aiSlots || []);

  return {
    boardSize: BOARD_SIZE,
    playerCount,
    mode: options.mode || "local",
    aiDifficulty: options.aiDifficulty || "steady",
    current: 0,
    turn: 1,
    winner: null,
    walls: { h: [], v: [] },
    log: [],
    moveHistory: [],
    players: PLAYER_TEMPLATES.slice(0, playerCount).map((template, index) => ({
      id: index,
      label: template.label,
      name: options.names?.[index] || (aiSlots.has(index) ? "AI" : `玩家 ${index + 1}`),
      color: template.color,
      row: template.row,
      col: template.col,
      start: { row: template.row, col: template.col },
      goal: template.goal,
      walls: wallLimit,
      kind: aiSlots.has(index) ? "ai" : "human"
    }))
  };
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function cellName(row, col) {
  return `${String.fromCharCode(65 + col)}${BOARD_SIZE - row}`;
}

export function wallName(wall) {
  return `${wall.orientation === "h" ? "横墙" : "竖墙"} ${cellName(wall.row, wall.col)}`;
}

function key(row, col) {
  return `${row},${col}`;
}

function wallKey(wall) {
  return `${wall.row},${wall.col}`;
}

function normalizeWall(wall) {
  return {
    orientation: wall?.orientation === "v" ? "v" : "h",
    row: Number(wall?.row),
    col: Number(wall?.col)
  };
}

function wallSets(state) {
  return {
    h: new Set((state.walls?.h || []).map((wall) => wallKey(wall))),
    v: new Set((state.walls?.v || []).map((wall) => wallKey(wall)))
  };
}

export function inBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

export function reachedGoal(player) {
  return player.goal.edge === "row" ? player.row === player.goal.value : player.col === player.goal.value;
}

export function isBlocked(state, from, to) {
  if (!inBounds(to.row, to.col)) return true;
  const dr = to.row - from.row;
  const dc = to.col - from.col;
  if (Math.abs(dr) + Math.abs(dc) !== 1) return true;
  const walls = wallSets(state);

  if (dr === 0) {
    const row = from.row;
    const col = Math.min(from.col, to.col);
    return walls.v.has(key(row, col)) || walls.v.has(key(row - 1, col));
  }

  const row = Math.min(from.row, to.row);
  const col = from.col;
  return walls.h.has(key(row, col)) || walls.h.has(key(row, col - 1));
}

export function simpleNeighbors(state, row, col) {
  const result = [];
  for (const dir of DIRS) {
    const next = { row: row + dir.dr, col: col + dir.dc };
    if (inBounds(next.row, next.col) && !isBlocked(state, { row, col }, next)) result.push(next);
  }
  return result;
}

function occupiedMap(state, ignoredPlayer = -1) {
  const map = new Map();
  for (const player of state.players) {
    if (player.id !== ignoredPlayer) map.set(key(player.row, player.col), player.id);
  }
  return map;
}

function uniqCells(cells) {
  const seen = new Set();
  const result = [];
  for (const cell of cells) {
    const id = key(cell.row, cell.col);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(cell);
    }
  }
  return result;
}

export function getValidMoves(state, playerId = state.current) {
  if (state.winner !== null) return [];
  const player = state.players[playerId];
  if (!player) return [];
  const occupied = occupiedMap(state, playerId);
  const moves = [];
  const from = { row: player.row, col: player.col };

  for (const dir of DIRS) {
    const adjacent = { row: player.row + dir.dr, col: player.col + dir.dc };
    if (!inBounds(adjacent.row, adjacent.col) || isBlocked(state, from, adjacent)) continue;

    if (!occupied.has(key(adjacent.row, adjacent.col))) {
      moves.push(adjacent);
      continue;
    }

    const behind = { row: adjacent.row + dir.dr, col: adjacent.col + dir.dc };
    if (
      inBounds(behind.row, behind.col) &&
      !isBlocked(state, adjacent, behind) &&
      !occupied.has(key(behind.row, behind.col))
    ) {
      moves.push(behind);
      continue;
    }

    const sideDirs = dir.dr !== 0
      ? [{ dr: 0, dc: -1 }, { dr: 0, dc: 1 }]
      : [{ dr: -1, dc: 0 }, { dr: 1, dc: 0 }];

    for (const side of sideDirs) {
      const diagonal = { row: adjacent.row + side.dr, col: adjacent.col + side.dc };
      if (
        inBounds(diagonal.row, diagonal.col) &&
        !isBlocked(state, adjacent, diagonal) &&
        !occupied.has(key(diagonal.row, diagonal.col))
      ) {
        moves.push(diagonal);
      }
    }
  }

  return uniqCells(moves);
}

function hasOverlap(state, wall) {
  const same = state.walls[wall.orientation] || [];
  if (same.some((item) => item.row === wall.row && item.col === wall.col)) return true;

  if (wall.orientation === "h") {
    return same.some((item) => item.row === wall.row && Math.abs(item.col - wall.col) < 2);
  }

  return same.some((item) => item.col === wall.col && Math.abs(item.row - wall.row) < 2);
}

export function isLegalWall(state, rawWall, playerId = state.current) {
  if (state.winner !== null) return false;
  const wall = normalizeWall(rawWall);
  const player = state.players[playerId];
  if (!player || player.walls <= 0) return false;
  if (!Number.isInteger(wall.row) || !Number.isInteger(wall.col)) return false;
  if (wall.row < 0 || wall.row > BOARD_SIZE - 2 || wall.col < 0 || wall.col > BOARD_SIZE - 2) return false;
  if (hasOverlap(state, wall)) return false;

  const opposite = wall.orientation === "h" ? "v" : "h";
  if ((state.walls[opposite] || []).some((item) => item.row === wall.row && item.col === wall.col)) return false;

  const next = cloneState(state);
  next.walls[wall.orientation].push(wall);
  return next.players.every((item) => shortestPath(next, item.id) < Infinity);
}

export function getLegalWalls(state, playerId = state.current) {
  const walls = [];
  for (const orientation of ["h", "v"]) {
    for (let row = 0; row < BOARD_SIZE - 1; row += 1) {
      for (let col = 0; col < BOARD_SIZE - 1; col += 1) {
        const wall = { orientation, row, col };
        if (isLegalWall(state, wall, playerId)) walls.push(wall);
      }
    }
  }
  return walls;
}

function goalReachedBy(player, row, col) {
  return player.goal.edge === "row" ? row === player.goal.value : col === player.goal.value;
}

export function shortestPath(state, playerId) {
  const route = shortestPathRoute(state, playerId);
  return route.length ? route.length - 1 : Infinity;
}

export function shortestPathRoute(state, playerId) {
  const player = state.players[playerId];
  if (!player) return [];
  const start = key(player.row, player.col);
  const queue = [{ row: player.row, col: player.col }];
  const seen = new Set([start]);
  const parent = new Map();

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const cell = queue[cursor];
    if (goalReachedBy(player, cell.row, cell.col)) {
      const path = [cell];
      let id = key(cell.row, cell.col);
      while (parent.has(id)) {
        const prev = parent.get(id);
        path.push(prev);
        id = key(prev.row, prev.col);
      }
      return path.reverse();
    }

    for (const next of simpleNeighbors(state, cell.row, cell.col)) {
      const id = key(next.row, next.col);
      if (!seen.has(id)) {
        seen.add(id);
        parent.set(id, cell);
        queue.push(next);
      }
    }
  }

  return [];
}

function nextPlayerIndex(state) {
  return (state.current + 1) % state.playerCount;
}

function formatAction(before, player, action, winner) {
  const prefix = player.name || `玩家 ${player.id + 1}`;
  const text = action.type === "move"
    ? `${prefix} 移动到 ${cellName(action.row, action.col)}`
    : `${prefix} 放置${wallName(action)}`;
  return winner !== null ? `${text}，抵达终点` : text;
}

export function applyAction(state, rawAction) {
  if (!rawAction || state.winner !== null) return { ok: false, reason: "对局已经结束" };
  const action = rawAction.type === "wall" ? { type: "wall", ...normalizeWall(rawAction) } : rawAction;
  const player = state.players[state.current];
  if (!player) return { ok: false, reason: "当前玩家不存在" };

  if (action.type === "move") {
    const row = Number(action.row);
    const col = Number(action.col);
    const legal = getValidMoves(state, state.current).some((cell) => cell.row === row && cell.col === col);
    if (!legal) return { ok: false, reason: "不能移动到这里" };

    const next = cloneState(state);
    const from = { row: next.players[state.current].row, col: next.players[state.current].col };
    next.players[state.current].row = row;
    next.players[state.current].col = col;
    const won = reachedGoal(next.players[state.current]);
    next.winner = won ? state.current : null;
    next.moveHistory = [
      {
        type: "move",
        turn: next.turn,
        player: state.current,
        from,
        to: { row, col }
      },
      ...(next.moveHistory || [])
    ].slice(0, 24);
    next.log = [
      { turn: next.turn, player: state.current, text: formatAction(state, player, { type: "move", row, col }, next.winner) },
      ...(next.log || [])
    ].slice(0, 40);
    if (!won) {
      next.current = nextPlayerIndex(state);
      next.turn += 1;
    }
    return { ok: true, state: next };
  }

  if (action.type === "wall") {
    if (!isLegalWall(state, action, state.current)) return { ok: false, reason: "这面墙不合法" };

    const next = cloneState(state);
    next.walls[action.orientation].push({ orientation: action.orientation, row: action.row, col: action.col });
    next.players[state.current].walls -= 1;
    next.log = [
      { turn: next.turn, player: state.current, text: formatAction(state, player, action, null) },
      ...(next.log || [])
    ].slice(0, 40);
    next.current = nextPlayerIndex(state);
    next.turn += 1;
    return { ok: true, state: next };
  }

  return { ok: false, reason: "未知动作" };
}

export function legalMoveSet(state, playerId = state.current) {
  return new Set(getValidMoves(state, playerId).map((cell) => key(cell.row, cell.col)));
}

export function legalWallKey(state, wall, playerId = state.current) {
  return isLegalWall(state, wall, playerId);
}
