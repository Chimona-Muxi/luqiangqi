import {
  BOARD_SIZE,
  applyAction,
  getValidMoves,
  isLegalWall,
  shortestPathRoute
} from "./engine.mjs";

const DIFFICULTY = {
  easy: { jitter: 7, wallLimit: 6, actionLimit: 10, replyLimit: 0, mistakeRate: 0.34, routeLookahead: 4 },
  steady: { jitter: 1.7, wallLimit: 10, actionLimit: 13, replyLimit: 0, mistakeRate: 0.07, routeLookahead: 5 },
  hard: { jitter: 0.08, wallLimit: 10, actionLimit: 12, replyLimit: 4, mistakeRate: 0, routeLookahead: 6 }
};

let pathCache = new WeakMap();

function resetPathCache() {
  pathCache = new WeakMap();
}

function pathRoute(state, playerId) {
  let routes = pathCache.get(state);
  if (!routes) {
    routes = new Map();
    pathCache.set(state, routes);
  }
  if (!routes.has(playerId)) routes.set(playerId, shortestPathRoute(state, playerId));
  return routes.get(playerId);
}

function pathDistance(state, playerId) {
  const route = pathRoute(state, playerId);
  return route.length ? route.length - 1 : Infinity;
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function sameCell(a, b) {
  return Boolean(a && b && a.row === b.row && a.col === b.col);
}

function actionKey(action) {
  return action.type === "move"
    ? `m:${action.row}:${action.col}`
    : `w:${action.orientation}:${action.row}:${action.col}`;
}

function uniqueActions(actions) {
  const seen = new Set();
  const result = [];
  for (const action of actions) {
    const id = actionKey(action);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(action);
    }
  }
  return result;
}

function moveActions(state, playerId = state.current) {
  return getValidMoves(state, playerId).map((cell) => ({ type: "move", row: cell.row, col: cell.col }));
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

function recentMovesFor(state, playerId) {
  return (state.moveHistory || []).filter((entry) => entry.type === "move" && entry.player === playerId);
}

function playerMobility(state, playerId) {
  return getValidMoves(state, playerId).length;
}

function repetitionPenalty(state, playerId) {
  const player = state.players[playerId];
  const moves = recentMovesFor(state, playerId);
  if (!player || moves.length < 2) return 0;

  const current = { row: player.row, col: player.col };
  const recentVisits = moves.slice(0, 8).filter((entry) => sameCell(entry.to, current)).length;
  let penalty = Math.max(0, recentVisits - 1) * 4;

  const a = moves[0];
  const b = moves[1];
  if (a && b && sameCell(a.from, b.to) && sameCell(a.to, b.from)) penalty += 12;

  return -penalty;
}

function scoreState(state, playerId) {
  const me = state.players[playerId];
  if (!me) return -10000;
  if (state.winner === playerId) return 100000;
  if (state.winner !== null) return -100000;

  const myDistance = pathDistance(state, playerId);
  const opponents = state.players.filter((player) => player.id !== playerId);
  const opponentDistances = opponents.map((player) => pathDistance(state, player.id));
  const nearestOpponent = Math.min(...opponentDistances);
  const averageOpponent = opponentDistances.reduce((sum, distance) => sum + distance, 0) / opponents.length;
  const lead = nearestOpponent - myDistance;
  const reserve = me.walls * (myDistance <= 2 ? 0.35 : 0.95) -
    opponents.reduce((sum, player) => sum + player.walls, 0) * 0.2;
  const mobility = playerMobility(state, playerId) * 0.35 -
    opponents.reduce((sum, player) => sum + playerMobility(state, player.id), 0) * 0.1;
  const tempo = state.current === playerId ? 0.8 : 0;
  const threat = nearestOpponent <= 1 ? -80 : nearestOpponent === 2 ? -30 : nearestOpponent === 3 ? -9 : 0;
  const finishPressure = myDistance <= 1 ? 110 : myDistance === 2 ? 40 : myDistance === 3 ? 12 : 0;
  const center = 2.6 - Math.abs(me.col - 4) * 0.12 - Math.abs(me.row - 4) * 0.08;
  const progress = goalProgress(me) * 2.0;

  return (
    nearestOpponent * 9.8 +
    averageOpponent * 2.2 +
    lead * 6.5 -
    myDistance * 16.5 +
    reserve +
    mobility +
    center +
    tempo +
    threat +
    finishPressure +
    progress +
    repetitionPenalty(state, playerId)
  );
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

function routeBlockingWalls(state, playerId, config) {
  const result = [];
  for (const opponent of state.players.filter((player) => player.id !== playerId)) {
    const route = pathRoute(state, opponent.id);
    const distance = pathDistance(state, opponent.id);
    const lookahead = distance <= 2 ? route.length - 1 : Math.min(config.routeLookahead, route.length - 1);
    for (let index = 0; index < lookahead; index += 1) {
      result.push(...blockWallsForStep(route[index], route[index + 1]));
    }
  }
  return result;
}

function localFenceWalls(state) {
  const result = [];
  for (const orientation of ["h", "v"]) {
    for (const wall of state.walls[orientation] || []) {
      for (const nextOrientation of ["h", "v"]) {
        for (const dr of [-1, 0, 1]) {
          for (const dc of [-1, 0, 1]) {
            result.push({
              type: "wall",
              orientation: nextOrientation,
              row: wall.row + dr,
              col: wall.col + dc
            });
          }
        }
      }
    }
  }
  return result;
}

function selfRouteWalls(state, playerId) {
  const route = pathRoute(state, playerId);
  const result = [];
  for (let index = 0; index < Math.min(3, route.length - 1); index += 1) {
    for (const wall of blockWallsForStep(route[index], route[index + 1])) {
      for (const orientation of ["h", "v"]) {
        for (const dr of [0, 1]) {
          for (const dc of [0, 1]) {
            result.push({ type: "wall", orientation, row: wall.row + dr, col: wall.col + dc });
          }
        }
      }
    }
  }
  return result;
}

function legalWallCandidates(state, playerId, config) {
  if (state.players[playerId].walls <= 0) return [];
  return uniqueActions([
    ...routeBlockingWalls(state, playerId, config),
    ...localFenceWalls(state),
    ...selfRouteWalls(state, playerId)
  ]).filter((wall) => Number.isInteger(wall.row) && Number.isInteger(wall.col) && isLegalWall(state, wall, playerId));
}

function wallImpactScore(state, resultState, playerId, action) {
  if (action.type !== "wall") return 0;

  const beforeMine = pathDistance(state, playerId);
  const afterMine = pathDistance(resultState, playerId);
  const selfCost = afterMine - beforeMine;
  let opponentGain = 0;
  let urgentGain = 0;

  for (const opponent of state.players.filter((player) => player.id !== playerId)) {
    const before = pathDistance(state, opponent.id);
    const after = pathDistance(resultState, opponent.id);
    const gain = Math.max(0, after - before);
    const urgency = before <= 2 ? 3.0 : before <= 4 ? 1.7 : 1.0;
    opponentGain += gain * urgency;
    if (before <= 2 && after > before) urgentGain += 1;
  }

  const conserve = state.players[playerId].walls <= 2 ? -2.2 : -0.8;
  return opponentGain * 15 + urgentGain * 18 - selfCost * (selfCost > 1 ? 14 : 7) + conserve;
}

function actionAdjustment(state, resultState, playerId, action) {
  if (action.type === "wall") return wallImpactScore(state, resultState, playerId, action);

  const player = state.players[playerId];
  const destination = { row: action.row, col: action.col };
  const history = recentMovesFor(state, playerId);
  const route = pathRoute(state, playerId);
  const beforeDistance = pathDistance(state, playerId);
  const afterDistance = pathDistance(resultState, playerId);
  let score = 0;

  const progress = stepProgress(player, action);
  if (progress > 0) score += 8;
  if (progress < 0) score -= 16;

  if (afterDistance < beforeDistance) score += 6;
  if (afterDistance === beforeDistance && beforeDistance <= 3) score -= 3;
  if (afterDistance > beforeDistance) score -= 11;

  if (route[1] && sameCell(destination, route[1])) score += 9;
  if (route.length > 2 && sameCell(destination, route[2])) score += 2.5;

  if (history[0]?.from && sameCell(destination, history[0].from)) score -= 38;
  if (history[1]?.from && sameCell(destination, history[1].from)) score -= 14;

  for (const entry of history.slice(0, 8)) {
    if (sameCell(destination, entry.to)) score -= 4;
    if (sameCell(destination, entry.from)) score -= 2;
  }

  return score;
}

function scoreAction(state, playerId, action, jitter = 0) {
  const result = applyAction(state, action);
  if (!result.ok) return null;
  return {
    action,
    state: result.state,
    score: scoreState(result.state, playerId) +
      actionAdjustment(state, result.state, playerId, action) +
      (Math.random() - 0.5) * jitter
  };
}

function rankActionEntries(state, playerId, actions, limit, jitter = 0) {
  return actions
    .map((action) => scoreAction(state, playerId, action, jitter))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function candidateActions(state, playerId, config) {
  const moves = moveActions(state, playerId);
  const moveEntries = rankActionEntries(state, playerId, moves, moves.length, config.jitter);
  const bestMoveScore = moveEntries[0]?.score ?? -Infinity;
  const wallEntries = rankActionEntries(
    state,
    playerId,
    legalWallCandidates(state, playerId, config),
    config.wallLimit,
    config.jitter
  ).filter((entry) => {
    const impact = wallImpactScore(state, entry.state, playerId, entry.action);
    return impact >= -3 || entry.score >= bestMoveScore - 8;
  });

  return [...moveEntries, ...wallEntries]
    .sort((a, b) => b.score - a.score)
    .slice(0, config.actionLimit)
    .map((entry) => entry.action);
}

function immediateWinAction(state, playerId) {
  for (const action of moveActions(state, playerId)) {
    const result = applyAction(state, action);
    if (result.ok && result.state.winner === playerId) return action;
  }
  return null;
}

function urgentBlockAction(state, playerId, config) {
  if (state.players[playerId].walls <= 0) return null;

  const threats = state.players
    .filter((player) => player.id !== playerId)
    .map((player) => ({ player, distance: pathDistance(state, player.id) }))
    .filter((entry) => entry.distance <= 1)
    .sort((a, b) => a.distance - b.distance);

  if (!threats.length) return null;

  const walls = legalWallCandidates(state, playerId, {
    ...config,
    routeLookahead: BOARD_SIZE,
    wallLimit: Math.max(config.wallLimit, 18)
  });

  const scored = [];
  for (const wall of walls) {
    const result = applyAction(state, wall);
    if (!result.ok) continue;
    const useful = threats.some(({ player, distance }) => pathDistance(result.state, player.id) > distance);
    if (useful) {
      scored.push({
        action: wall,
        score: scoreState(result.state, playerId) + wallImpactScore(state, result.state, playerId, wall)
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.action || null;
}

function opponentReplyRisk(state, playerId, config) {
  if (!config.replyLimit || state.winner !== null) return 0;
  const actor = state.current;
  if (actor === playerId) return 0;
  const nextDistance = pathDistance(state, actor);
  const myDistance = pathDistance(state, playerId);
  if (state.playerCount > 2 && nextDistance > 4 && myDistance > 4) return 0;

  const replyLimit = state.playerCount > 2 ? Math.min(3, config.replyLimit) : config.replyLimit;
  const replyConfig = {
    ...config,
    wallLimit: state.playerCount > 2 ? 3 : Math.max(4, Math.floor(config.wallLimit * 0.45)),
    actionLimit: state.playerCount > 2 ? 4 : Math.max(5, Math.floor(config.actionLimit * 0.5)),
    routeLookahead: state.playerCount > 2 ? 2 : Math.max(3, Math.floor(config.routeLookahead * 0.55)),
    jitter: 0
  };
  const replies = rankActionEntries(
    state,
    actor,
    candidateActions(state, actor, replyConfig),
    replyLimit,
    0
  );

  if (!replies.length) return 0;

  let worst = Infinity;
  const baseline = scoreState(state, playerId);
  for (const reply of replies) {
    const result = applyAction(state, reply.action);
    if (!result.ok) continue;
    const score = scoreState(result.state, playerId);
    worst = Math.min(worst, score);
  }

  if (worst === Infinity) return 0;
  return (worst - baseline) * 0.8;
}

function bestHardAction(state, playerId, actions, config) {
  let best = null;
  let bestScore = -Infinity;

  for (const action of actions) {
    const result = applyAction(state, action);
    if (!result.ok) continue;
    const score = scoreState(result.state, playerId) +
      actionAdjustment(state, result.state, playerId, action) +
      opponentReplyRisk(result.state, playerId, config) +
      (Math.random() - 0.5) * config.jitter;
    if (score > bestScore) {
      best = action;
      bestScore = score;
    }
  }

  return best || actions[0] || null;
}

export function chooseAiAction(state, difficulty = "steady") {
  resetPathCache();
  const playerId = state.current;
  const moves = moveActions(state, playerId);
  const config = DIFFICULTY[difficulty] || DIFFICULTY.steady;
  if (!moves.length) return null;

  const winNow = immediateWinAction(state, playerId);
  if (winNow) return winNow;

  const urgentBlock = urgentBlockAction(state, playerId, config);
  if (urgentBlock) return urgentBlock;

  const actions = candidateActions(state, playerId, config);
  const ranked = rankActionEntries(state, playerId, actions, Math.max(3, actions.length), config.jitter)
    .map((entry) => entry.action);

  if (difficulty === "easy") {
    const pool = Math.random() < config.mistakeRate ? moves : ranked;
    return randomItem(pool.slice(0, Math.min(pool.length, 5))) || randomItem(moves);
  }

  if (difficulty === "steady") {
    if (Math.random() < config.mistakeRate) return randomItem(ranked.slice(0, Math.min(ranked.length, 3))) || randomItem(moves);
    return ranked[0] || randomItem(moves);
  }

  return bestHardAction(state, playerId, ranked, config) || ranked[0] || randomItem(moves);
}
