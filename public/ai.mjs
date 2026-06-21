import {
  BOARD_SIZE,
  applyAction,
  getValidMoves,
  isLegalWall,
  shortestPath,
  shortestPathRoute
} from "./engine.mjs";

const DIFFICULTY = {
  easy: { jitter: 7, searchDepth: 1, wallLimit: 6, mistakeRate: 0.34 },
  steady: { jitter: 2.2, searchDepth: 1, wallLimit: 10, mistakeRate: 0.08 },
  hard: { jitter: 0.15, searchDepth: 2, wallLimit: 9, mistakeRate: 0 }
};

function scoreState(state, playerId) {
  const me = state.players[playerId];
  if (state.winner === playerId) return 10000;
  if (state.winner !== null) return -10000;

  const myDistance = shortestPath(state, playerId);
  const opponents = state.players.filter((player) => player.id !== playerId);
  const opponentDistances = opponents.map((player) => shortestPath(state, player.id));
  const nearestOpponent = Math.min(...opponentDistances);
  const averageOpponent = opponentDistances.reduce((sum, distance) => sum + distance, 0) / opponents.length;
  const reserve = me.walls * 0.8 - opponents.reduce((sum, player) => sum + player.walls, 0) * 0.18;
  const tempo = state.current === playerId ? 1.1 : 0;
  const threat = nearestOpponent <= 2 ? -18 / Math.max(1, nearestOpponent) : 0;
  const finishPressure = myDistance <= 2 ? 22 / Math.max(1, myDistance) : 0;
  const center = 2.8 - Math.abs(me.col - 4) * 0.15 - Math.abs(me.row - 4) * 0.08;
  const progress = goalProgress(me) * 1.6;

  return nearestOpponent * 10 + averageOpponent * 2.5 - myDistance * 15 + reserve + center + tempo + threat + finishPressure + progress;
}

function goalProgress(player) {
  const startDistance = player.goal.edge === "row"
    ? Math.abs(player.start.row - player.goal.value)
    : Math.abs(player.start.col - player.goal.value);
  const currentDistance = player.goal.edge === "row"
    ? Math.abs(player.row - player.goal.value)
    : Math.abs(player.col - player.goal.value);
  return startDistance - currentDistance;
}

function stepProgress(player, action) {
  if (action.type !== "move") return 0;
  if (player.goal.edge === "row") {
    const direction = Math.sign(player.goal.value - player.row);
    return (action.row - player.row) * direction;
  }
  const direction = Math.sign(player.goal.value - player.col);
  return (action.col - player.col) * direction;
}

function sameCell(a, b) {
  return a && b && a.row === b.row && a.col === b.col;
}

function recentMovesFor(state, playerId) {
  return (state.moveHistory || []).filter((entry) => entry.type === "move" && entry.player === playerId);
}

function actionAdjustment(state, resultState, playerId, action) {
  if (action.type !== "move") return 0;

  const player = state.players[playerId];
  const destination = { row: action.row, col: action.col };
  const history = recentMovesFor(state, playerId);
  const route = shortestPathRoute(state, playerId);
  const beforeDistance = shortestPath(state, playerId);
  const afterDistance = shortestPath(resultState, playerId);
  let score = 0;

  const progress = stepProgress(player, action);
  if (progress > 0) score += 7;
  if (progress < 0) score -= 14;

  if (afterDistance < beforeDistance) score += 5;
  if (afterDistance > beforeDistance) score -= 9;

  if (route[1] && sameCell(destination, route[1])) score += 8;
  if (route.length > 2 && sameCell(destination, route[2])) score += 3;

  if (history[0]?.from && sameCell(destination, history[0].from)) score -= 32;
  if (history[1]?.from && sameCell(destination, history[1].from)) score -= 12;

  for (const entry of history.slice(0, 8)) {
    if (sameCell(destination, entry.to)) score -= 5;
    if (sameCell(destination, entry.from)) score -= 3;
  }

  return score;
}

function moveActions(state, playerId = state.current) {
  return getValidMoves(state, playerId).map((cell) => ({ type: "move", row: cell.row, col: cell.col }));
}

function blockWallsForStep(a, b) {
  const walls = [];
  if (a.row !== b.row) {
    const row = Math.min(a.row, b.row);
    for (const col of [a.col - 1, a.col]) {
      if (col >= 0 && col < BOARD_SIZE - 1) walls.push({ type: "wall", orientation: "h", row, col });
    }
  } else {
    const col = Math.min(a.col, b.col);
    for (const row of [a.row - 1, a.row]) {
      if (row >= 0 && row < BOARD_SIZE - 1) walls.push({ type: "wall", orientation: "v", row, col });
    }
  }
  return walls;
}

function candidateBlockingWalls(state, playerId) {
  const seen = new Set();
  const result = [];

  for (const opponent of state.players.filter((player) => player.id !== playerId)) {
    const route = shortestPathRoute(state, opponent.id);
    for (let index = 0; index < route.length - 1; index += 1) {
      for (const wall of blockWallsForStep(route[index], route[index + 1])) {
        const id = `${wall.orientation}:${wall.row}:${wall.col}`;
        if (!seen.has(id) && isLegalWall(state, wall, playerId)) {
          seen.add(id);
          result.push(wall);
        }
      }
    }
  }

  return result;
}

function candidateRaceWalls(state, playerId) {
  const route = shortestPathRoute(state, playerId);
  const seen = new Set();
  const result = [];

  for (let index = 0; index < Math.min(4, route.length - 1); index += 1) {
    for (const wall of blockWallsForStep(route[index], route[index + 1])) {
      for (const orientation of ["h", "v"]) {
        for (const dr of [0, 1]) {
          for (const dc of [0, 1]) {
            const candidate = {
              type: "wall",
              orientation,
              row: wall.row + dr,
              col: wall.col + dc
            };
            const id = `${candidate.orientation}:${candidate.row}:${candidate.col}`;
            if (!seen.has(id) && isLegalWall(state, candidate, playerId)) {
              seen.add(id);
              result.push(candidate);
            }
          }
        }
      }
    }
  }

  return result;
}

function rankActions(state, playerId, actions, limit, jitter = 0) {
  return actions
    .map((action) => {
      const result = applyAction(state, action);
      return result.ok
        ? { action, score: scoreState(result.state, playerId) + actionAdjustment(state, result.state, playerId, action) + (Math.random() - 0.5) * jitter }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.action);
}

function actionKey(action) {
  return action.type === "move"
    ? `m:${action.row}:${action.col}`
    : `w:${action.orientation}:${action.row}:${action.col}`;
}

function candidateActions(state, playerId, config) {
  const moves = moveActions(state, playerId);
  const walls = state.players[playerId].walls > 0
    ? [...candidateBlockingWalls(state, playerId), ...candidateRaceWalls(state, playerId)]
    : [];
  const uniqueWalls = [];
  const seen = new Set();

  for (const wall of walls) {
    const id = actionKey(wall);
    if (!seen.has(id)) {
      seen.add(id);
      uniqueWalls.push(wall);
    }
  }

  const rankedWalls = rankActions(state, playerId, uniqueWalls, config.wallLimit, config.jitter);
  const actions = [...moves, ...rankedWalls];
  return actions.length ? actions : moves;
}

function minimax(state, rootPlayer, depth, alpha, beta, config) {
  if (depth <= 0 || state.winner !== null) return scoreState(state, rootPlayer);

  const actor = state.current;
  const actions = candidateActions(state, actor, {
    ...config,
    wallLimit: Math.max(5, Math.floor(config.wallLimit * 0.72))
  });
  if (!actions.length) return scoreState(state, rootPlayer);

  if (actor === rootPlayer) {
    let value = -Infinity;
    for (const action of actions) {
      const result = applyAction(state, action);
      if (!result.ok) continue;
      value = Math.max(value, minimax(result.state, rootPlayer, depth - 1, alpha, beta, config));
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    return value;
  }

  let value = Infinity;
  for (const action of actions) {
    const result = applyAction(state, action);
    if (!result.ok) continue;
    value = Math.min(value, minimax(result.state, rootPlayer, depth - 1, alpha, beta, config));
    beta = Math.min(beta, value);
    if (alpha >= beta) break;
  }
  return value;
}

function bestBySearch(state, playerId, actions, config) {
  let best = null;
  let bestScore = -Infinity;

  for (const action of actions) {
    const result = applyAction(state, action);
    if (!result.ok) continue;
    const score = minimax(result.state, playerId, config.searchDepth - 1, -Infinity, Infinity, config) +
      actionAdjustment(state, result.state, playerId, action) +
      (Math.random() - 0.5) * config.jitter;
    if (score > bestScore) {
      best = action;
      bestScore = score;
    }
  }

  return best || actions[0] || null;
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function chooseAiAction(state, difficulty = "steady") {
  const playerId = state.current;
  const player = state.players[playerId];
  const moves = moveActions(state, playerId);
  const config = DIFFICULTY[difficulty] || DIFFICULTY.steady;
  if (!moves.length) return null;

  const actions = candidateActions(state, playerId, config);
  const ranked = rankActions(state, playerId, actions, Math.max(3, actions.length), config.jitter);

  if (difficulty === "easy") {
    const pool = Math.random() < config.mistakeRate ? moves : ranked;
    return randomItem(pool.slice(0, Math.min(pool.length, 5))) || randomItem(moves);
  }

  if (difficulty === "steady") {
    if (Math.random() < config.mistakeRate) return randomItem(ranked.slice(0, Math.min(ranked.length, 3))) || randomItem(moves);
    return ranked[0] || randomItem(moves);
  }

  return bestBySearch(state, playerId, ranked, config) || ranked[0] || randomItem(moves);
}
