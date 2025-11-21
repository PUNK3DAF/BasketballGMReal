// BasketballGM 2D visualizer - realism fixes (shot-clock, steals/intercepts, pacing)
// + fix: offense moves into opponent half and inbound targets handler's attack position
const fileInput = document.getElementById("fileInput");
const homeSelect = document.getElementById("homeSelect");
const awaySelect = document.getElementById("awaySelect");
const teamSelectors = document.getElementById("teamSelectors");
const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const speedSlider = document.getElementById("speed");
const logEl = document.getElementById("log");
const canvas = document.getElementById("court");
const ctx = canvas.getContext("2d");

let league = null;
let teams = [];
let playersGlobal = [];
let game = null;
let animRequest = null;

fileInput.addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    league = JSON.parse(text);
    parseLeague(league);
    populateTeamSelectors();
    teamSelectors.style.display = "";
    log("League loaded. Pick teams and press Start.");
  } catch (err) {
    log("Error loading JSON: " + err.message);
  }
});

startBtn.addEventListener("click", () => {
  const homeId = homeSelect.value;
  const awayId = awaySelect.value;
  if (!homeId || !awayId || homeId === awayId) {
    alert("Choose two different teams.");
    return;
  }
  const home = teams.find((t) => t.id === homeId);
  const away = teams.find((t) => t.id === awayId);
  startGame(home, away);
});

pauseBtn.addEventListener("click", () => {
  if (!game) return;
  game.paused = !game.paused;
  pauseBtn.textContent = game.paused ? "Resume" : "Pause";
});

speedSlider.addEventListener("input", () => {
  if (game) game.speed = parseFloat(speedSlider.value);
});

function log(s) {
  const p = document.createElement("div");
  p.textContent = s;
  logEl.prepend(p);
}

// --- league parsing (unchanged) ---
function parseLeague(leagueJson) {
  teams = [];
  playersGlobal = leagueJson.players || [];
  if (Array.isArray(leagueJson.teams)) {
    leagueJson.teams.forEach((t) => {
      const id = String(
        t.tid ?? t.id ?? t._id ?? (t.abbrev || t.region + " " + t.name)
      );
      const display =
        t.region && t.name
          ? `${t.region} ${t.name}`
          : t.name || t.abbrev || "Team " + id;
      const roster = playersGlobal
        .filter((p) => String(p.tid) === String(t.tid))
        .map((p) => {
          const r0 = (p.ratings && p.ratings[0]) || {};
          const ovr = r0.ovr ?? r0.pot ?? r0.hgt ?? p.ovr ?? 60;
          return {
            id: p.pid ?? p.id ?? p._id,
            name: p.firstName
              ? p.firstName + " " + (p.lastName || "")
              : p.name || "Player",
            rating: ovr,
            pos: p.pos || r0.pos || null,
          };
        });
      teams.push({ id, name: display, raw: t, roster });
    });
  } else {
    const byTid = {};
    (playersGlobal || []).forEach((p) => {
      const tid = String(p.tid ?? "0");
      byTid[tid] = byTid[tid] || [];
      const r0 = (p.ratings && p.ratings[0]) || {};
      const ovr = r0.ovr ?? r0.pot ?? p.ovr ?? 60;
      byTid[tid].push({
        id: p.pid ?? p.id,
        name: p.firstName
          ? p.firstName + " " + (p.lastName || "")
          : p.name || "Player",
        rating: ovr,
        pos: p.pos || r0.pos || null,
      });
    });
    Object.keys(byTid).forEach((tid) =>
      teams.push({ id: tid, name: "Team " + tid, roster: byTid[tid] })
    );
  }
}

function populateTeamSelectors() {
  [homeSelect, awaySelect].forEach((s) => (s.innerHTML = ""));
  teams.forEach((t) => {
    const opt1 = document.createElement("option");
    opt1.value = t.id;
    opt1.textContent = t.name;
    const opt2 = opt1.cloneNode(true);
    homeSelect.appendChild(opt1);
    awaySelect.appendChild(opt2);
  });
  if (teams.length >= 2) {
    homeSelect.selectedIndex = 0;
    awaySelect.selectedIndex = 1;
  }
}

// --- start and setup ---
function startGame(home, away) {
  game = {
    home,
    away,
    homeScore: 0,
    awayScore: 0,
    period: 1,
    timeLeft: 12 * 60,
    ball: {
      x: canvas.width / 2,
      y: canvas.height / 2,
      vx: 0,
      vy: 0,
      state: "held",
      holder: null,
    },
    players: [],
    offense: Math.random() < 0.5 ? "home" : "away",
    paused: false,
    speed: parseFloat(speedSlider.value) || 1,
    possessionTime: 24,
    lastUpdate: performance.now(),
    currentPlay: null,
  };

  function chooseFive(roster) {
    if (!roster || roster.length === 0) {
      const res = [];
      for (let i = 0; i < 5; i++)
        res.push({ name: `P${i + 1}`, rating: 60, pos: "G" });
      return res;
    }
    const sorted = roster
      .slice()
      .sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const five = sorted.slice(0, Math.min(5, sorted.length));
    while (five.length < 5) five.push({ name: "Sub", rating: 55, pos: "F" });
    return five;
  }

  const homeFive = chooseFive(home.roster);
  const awayFive = chooseFive(away.roster);

  const positionsHome = [
    { x: 200, y: 250 },
    { x: 120, y: 140 },
    { x: 120, y: 360 },
    { x: 300, y: 110 },
    { x: 300, y: 390 },
  ];
  const positionsAway = positionsHome.map((p) => ({
    x: canvas.width - p.x,
    y: p.y,
  }));

  homeFive.forEach((pl, i) => {
    game.players.push({
      team: "home",
      name: pl.name,
      rating: pl.rating || 60,
      x: positionsHome[i].x,
      y: positionsHome[i].y,
      tx: positionsHome[i].x,
      ty: positionsHome[i].y,
      energy: 100,
    });
  });
  awayFive.forEach((pl, i) => {
    game.players.push({
      team: "away",
      name: pl.name,
      rating: pl.rating || 60,
      x: positionsAway[i].x,
      y: positionsAway[i].y,
      tx: positionsAway[i].x,
      ty: positionsAway[i].y,
      energy: 100,
    });
  });

  document.getElementById("homeLabel").textContent = home.name;
  document.getElementById("awayLabel").textContent = away.name;
  document.getElementById("homeScore").textContent = "0";
  document.getElementById("awayScore").textContent = "0";
  log(
    `Starting: ${home.name} (home) vs ${away.name} (away). First possession: ${game.offense}`
  );

  if (animRequest) cancelAnimationFrame(animRequest);
  game.lastUpdate = performance.now();
  animLoop();
}

// --- main loop ---
function animLoop(t) {
  if (!game) return;
  animRequest = requestAnimationFrame(animLoop);
  const now = performance.now();
  const dtReal = (now - game.lastUpdate) / 1000;
  game.lastUpdate = now;
  if (game.paused) return;
  const dt = dtReal * game.speed;
  stepGame(dt);
  render();
}

// --- game logic with state machine ---
// Fixes:
// - offense moves into attacking half (baseX changed)
// - inbound sends ball to handler's intended attack position (handler.tx/ty)
// - shot clock only decremented during active play (not inbound)
// - interceptions/steals restricted to nearby defenders
function stepGame(dt) {
  // advance game clock
  game.timeLeft -= dt;
  if (game.timeLeft <= 0) {
    game.period++;
    if (game.period > 4) {
      log("Game ended. Final: " + game.homeScore + "-" + game.awayScore);
      game = null;
      return;
    } else {
      game.timeLeft = 12 * 60;
      log("Start of period " + game.period);
    }
  }

  // if no play active, start a possession and skip shot-clock decrement for this frame
  if (!game.currentPlay) {
    startPossession();
    return;
  }

  // decrement shot clock only when not inbound (gives time to set up)
  if (game.currentPlay.phase !== "inbound") {
    game.possessionTime -= dt;
  }

  // update players movement towards targets
  game.players.forEach((p) => {
    const dx = p.tx - p.x,
      dy = p.ty - p.y;
    const dist = Math.hypot(dx, dy);
    const baseSpeed = 72; // slightly reduced walking/dribble speed
    const s = baseSpeed * (0.6 + (p.rating || 60) / 150) * (p.energy / 120);
    if (dist > 1) {
      p.x += (dx / dist) * s * dt;
      p.y += (dy / dist) * s * dt;
    }
    p.energy = Math.max(20, p.energy - dt * 0.35);
  });

  // handle ball physics if flying (pass/shot)
  if (game.ball.state === "flying") {
    game.ball.x += game.ball.vx * dt;
    game.ball.y += game.ball.vy * dt;
    if (game.ball.ttl !== undefined) {
      game.ball.ttl -= dt;
      if (game.ball.ttl <= 0) {
        // arrival
        if (game.ball.flightType === "pass") {
          // find receiving player (closest to arrival)
          let receiver = findClosestPlayer(
            game.ball.x,
            game.ball.y,
            game.offense
          );
          if (!receiver)
            receiver = game.players.find((p) => p.team === game.offense);
          // on pass arrival, set ball to held by receiver
          game.ball.state = "held";
          game.ball.holder = receiver;
          game.ball.x = receiver.x + (receiver.team === "home" ? 10 : -10);
          game.ball.y = receiver.y - 8;
          // set next play to dribble with the receiver as handler
          if (game.currentPlay) {
            game.currentPlay.handler = receiver;
            game.currentPlay.minDribble = 0.6 + Math.random() * 1.2;
            game.currentPlay.phase = "dribble";
            game.currentPlay.phaseStart = performance.now();
          }
        } else if (game.ball.flightType === "shot") {
          // shot arrival -> decide make/miss
          const shooter = game.ball.shooter;
          const made = resolveShotOutcome(shooter, game.ball.shotTarget);
          game.ball.state = "ground";
          game.ball.vx = game.ball.vy = 0;
          // schedule rebound or inbound after short delay
          game.ball.ttl = 0.42;
          game.ball.lastShot = { shooter, made, points: game.ball.points || 2 };
        } else if (game.ball.flightType === "inbound") {
          // inbound arrival -> attach to handler (start dribble)
          const handler = game.currentPlay && game.currentPlay.handler;
          if (handler) {
            game.ball.state = "held";
            game.ball.holder = handler;
            game.ball.x = handler.x + (handler.team === "home" ? 10 : -10);
            game.ball.y = handler.y - 8;
            if (game.currentPlay) {
              game.currentPlay.phase = "dribble";
              game.currentPlay.phaseStart = performance.now();
            }
          } else {
            // fallback
            game.ball.state = "held";
            game.ball.holder = null;
          }
        }
      }
    }
  } else if (game.ball.state === "ground") {
    if (game.ball.ttl !== undefined) {
      game.ball.ttl -= dt;
      if (game.ball.ttl <= 0) {
        if (game.ball.lastShot) {
          const sh = game.ball.lastShot;
          if (sh.made) {
            if (sh.shooter.team === "home") game.homeScore += sh.points;
            else game.awayScore += sh.points;
            document.getElementById("homeScore").textContent = game.homeScore;
            document.getElementById("awayScore").textContent = game.awayScore;
            log(
              `${sh.shooter.name} (${sh.shooter.team}) scored ${sh.points} — ${game.homeScore}-${game.awayScore}`
            );
            setInboundAfterScore();
          } else {
            log(`${sh.shooter.name} (${sh.shooter.team}) missed`);
            // rebound contest
            const rebounder = chooseRebounder(sh.shooter);
            if (rebounder) {
              game.ball.state = "held";
              game.ball.holder = rebounder;
              game.ball.x =
                rebounder.x + (rebounder.team === "home" ? 10 : -10);
              game.ball.y = rebounder.y - 8;
              game.offense = rebounder.team;
              game.possessionTime = 24;
              game.currentPlay = {
                phase: "dribble",
                handler: rebounder,
                phaseStart: performance.now(),
                minDribble: 0.6,
              };
            } else {
              // fallback: alternate possession
              game.offense = game.offense === "home" ? "away" : "home";
              game.possessionTime = 24;
              game.currentPlay = null;
            }
          }
          game.ball.lastShot = null;
        }
      }
    }
  }

  // if no active play (e.g., after inbound/rebound handling) then start possession
  if (!game.currentPlay) {
    startPossession();
    return;
  }

  // handle play phases
  const cp = game.currentPlay;
  const elapsed = (performance.now() - cp.phaseStart) / 1000;

  if (cp.phase === "inbound") {
    if (elapsed > cp.duration) {
      cp.phase = "dribble";
      cp.phaseStart = performance.now();
      // move handler toward attack area (handler.tx already set by startPossession)
      // ball will be attached when inbound arrival finalizes
    }
  } else if (cp.phase === "dribble") {
    if (elapsed > (cp.minDribble || 0.9)) {
      const handler = cp.handler;
      const teammates = game.players.filter(
        (p) => p.team === handler.team && p !== handler
      );
      const defendersNearby = findClosestPlayers(
        handler,
        2,
        handler.team === "home" ? "away" : "home"
      );
      const defenderPressure =
        defendersNearby.reduce((s, p) => s + (120 - p.rating), 0) /
        (defendersNearby.length || 1);
      const shotDist = Math.hypot(
        getOpponentBasketX(handler.team) - handler.x,
        getBasketY() - handler.y
      );
      // Favor passing and longer dribbles to reduce constant shooting
      const shotScore =
        (handler.rating - 55) / 60 - shotDist / 700 - defenderPressure / 240;
      const passScore = teammates.length
        ? Math.max(
            ...teammates.map(
              (t) =>
                (t.rating - 55) / 60 -
                Math.hypot(handler.x - t.x, handler.y - t.y) / 450
            )
          )
        : -1;
      const choiceRand = Math.random();
      if (choiceRand < 0.22 + Math.max(0, 0.35 * passScore)) {
        const target = weightedChoice(
          teammates,
          (t) => t.rating + 20 - Math.hypot(handler.x - t.x, handler.y - t.y)
        );
        if (target) {
          initiatePass(handler, target);
          cp.phase = "pass";
          cp.phaseStart = performance.now();
        }
      } else if (choiceRand < 0.28 + Math.max(0, 0.5 * shotScore)) {
        initiateShot(handler);
        cp.phase = "shoot";
        cp.phaseStart = performance.now();
      } else {
        cp.minDribble = 0.9 + Math.random() * 2.2;
        cp.phaseStart = performance.now();
        handler.tx = Math.max(
          60,
          Math.min(canvas.width - 60, handler.x + (Math.random() * 160 - 80))
        );
        handler.ty = Math.max(
          60,
          Math.min(canvas.height - 60, handler.y + (Math.random() * 120 - 60))
        );
        const nearestDef = findNearestDefender(handler);
        const defDist = nearestDef
          ? Math.hypot(nearestDef.x - handler.x, nearestDef.y - handler.y)
          : 999;
        const stealProb = Math.max(
          0,
          0.005 + (100 - defDist) / 1000 + (80 - handler.energy) / 2000
        );
        if (Math.random() < stealProb) {
          handleTurnover(handler);
        }
      }
    }
  } else if (cp.phase === "pass") {
    // pass flight handles arrival/interception
  } else if (cp.phase === "shoot") {
    // waiting for shot flight resolution
  }

  // shot clock turnover
  if (game.possessionTime <= 0) {
    log(`Shot clock violation for ${game.offense}`);
    game.offense = game.offense === "home" ? "away" : "home";
    game.possessionTime = 24;
    game.currentPlay = null;
    game.ball.state = "held";
    const newHandler = game.players.find((p) => p.team === game.offense);
    if (newHandler) {
      game.ball.holder = newHandler;
      game.ball.x = newHandler.x + (newHandler.team === "home" ? 10 : -10);
      game.ball.y = newHandler.y - 8;
    }
  }
}

// ---- helpers ----
function startPossession() {
  const offenseTeam = game.offense;
  const offensePlayers = game.players.filter((p) => p.team === offenseTeam);
  const handler = weightedChoice(offensePlayers, (p) => p.rating + 10);
  if (!handler) return;

  // choose attacking X so offense is placed on opponent half
  const attackBaseX = offenseTeam === "home" ? canvas.width - 160 : 160; // attack toward opponent basket
  game.currentPlay = {
    phase: "inbound",
    handler,
    phaseStart: performance.now(),
    duration: 0.7 + Math.random() * 1.0,
    minDribble: 0.9 + Math.random() * 1.4,
  };
  // set shot clock full on new possession
  game.possessionTime = 24;

  // position offensive and defensive shapes (offense on attacking half)
  const spreadY = [-80, -40, 0, 40, 80];
  const offPlayers = game.players.filter((p) => p.team === offenseTeam);
  offPlayers.forEach((p, i) => {
    p.tx = attackBaseX + (Math.random() * 40 - 20);
    p.ty = canvas.height / 2 + spreadY[i] + (Math.random() * 30 - 15);
  });
  const defPlayers = game.players.filter((p) => p.team !== offenseTeam);
  // defenders positioned more toward their own basket (defending)
  const defBaseX = offenseTeam === "home" ? 120 : canvas.width - 120;
  defPlayers.forEach((p, i) => {
    p.tx = defBaseX + (Math.random() * 40 - 20);
    p.ty = canvas.height / 2 + spreadY[i] + (Math.random() * 30 - 15);
  });

  // inbound target should be the handler's intended attack position (handler.tx/ty)
  const inboundTarget = { x: handler.tx, y: handler.ty };
  // visual inbound flight from center to handler's attack spot
  game.ball.state = "flying";
  game.ball.flightType = "inbound";
  const travel = 0.55;
  // move ball from center to inboundTarget
  game.ball.vx = (inboundTarget.x - game.ball.x) / travel;
  game.ball.vy = (inboundTarget.y - game.ball.y) / travel;
  game.ball.ttl = travel;
  game.ball.holder = null;
}

function initiatePass(from, to) {
  const travel =
    0.28 + Math.min(1.0, Math.hypot(from.x - to.x, from.y - to.y) / 420);
  const midX = (from.x + to.x) / 2,
    midY = (from.y + to.y) / 2;
  const defenders = game.players.filter((p) => p.team !== from.team);
  const interceptors = defenders.filter(
    (d) => Math.hypot(d.x - midX, d.y - midY) < 140
  );
  if (interceptors.length) {
    interceptors.sort(
      (a, b) =>
        Math.hypot(a.x - midX, a.y - midY) - Math.hypot(b.x - midX, b.y - midY)
    );
    for (let d of interceptors) {
      const dDist = Math.hypot(d.x - midX, d.y - midY);
      const base = 0.06 + Math.max(0, (140 - dDist) / 800);
      const rated = base + (d.rating - 60) / 600;
      const chance = Math.min(0.5, Math.max(0.02, rated));
      if (Math.random() < chance) {
        game.ball.state = "held";
        game.ball.holder = d;
        d.tx = d.x;
        d.ty = d.y;
        log(`${d.name} (${d.team}) intercepted a pass!`);
        game.offense = d.team;
        game.possessionTime = 24;
        game.currentPlay = {
          phase: "dribble",
          handler: d,
          phaseStart: performance.now(),
          minDribble: 0.6,
        };
        return;
      }
    }
  }
  game.ball.state = "flying";
  game.ball.flightType = "pass";
  game.ball.ttl = travel;
  game.ball.vx = (to.x - from.x) / travel;
  game.ball.vy = (to.y - from.y) / travel;
  game.ball.points = 0;
  game.ball.holder = null;
}

function initiateShot(shooter) {
  const targetX = getOpponentBasketX(shooter.team);
  const targetY = getBasketY();
  const dist = Math.hypot(targetX - shooter.x, targetY - shooter.y);
  const travel = 0.55 + Math.min(1.2, dist / 420);
  game.ball.state = "flying";
  game.ball.flightType = "shot";
  game.ball.shooter = shooter;
  game.ball.shotTarget = { x: targetX, y: targetY };
  game.ball.vx = (targetX - shooter.x) / travel;
  game.ball.vy = (targetY - shooter.y) / travel;
  game.ball.ttl = travel;
  game.ball.points = Math.random() < 0.12 ? 3 : 2;
  game.ball.holder = null;
}

function handleTurnover(handler) {
  const defenders = game.players.filter((p) => p.team !== handler.team);
  const nearby = defenders.filter(
    (d) => Math.hypot(d.x - handler.x, d.y - handler.y) < 100
  );
  if (nearby.length) {
    const thief = weightedChoice(
      nearby,
      (d) => d.rating + (120 - Math.hypot(d.x - handler.x, d.y - handler.y))
    );
    if (thief) {
      log(
        `${handler.name} (${handler.team}) lost the ball to ${thief.name} (${thief.team})`
      );
      game.offense = thief.team;
      game.possessionTime = 24;
      game.ball.state = "held";
      game.ball.holder = thief;
      game.currentPlay = {
        phase: "dribble",
        handler: thief,
        phaseStart: performance.now(),
        minDribble: 0.6,
      };
      return;
    }
  }
  game.offense = game.offense === "home" ? "away" : "home";
  game.currentPlay = null;
}

function setInboundAfterScore() {
  game.offense = game.offense === "home" ? "away" : "home";
  game.currentPlay = null;
  game.possessionTime = 24;
  game.ball.state = "held";
  game.ball.holder = null;
  game.ball.x = canvas.width / 2;
  game.ball.y = canvas.height / 2;
}

function resolveShotOutcome(shooter, shotTarget) {
  const rating = shooter.rating || 60;
  const dx = shotTarget.x - shooter.x;
  const dy = shotTarget.y - shooter.y;
  const dist = Math.hypot(dx, dy);
  const distFactor = Math.max(0.12, 1 - dist / 700);
  const defender = findNearestDefender(shooter);
  const pressure = defender ? Math.max(0, 70 - defender.rating) / 220 : 0;
  const base = 0.28 + (rating - 60) / 240;
  const makeProb = Math.max(
    0.03,
    Math.min(0.92, base * distFactor - pressure + (Math.random() - 0.5) * 0.07)
  );
  return Math.random() < makeProb;
}

function chooseRebounder(shooter) {
  const defenders = game.players.filter((p) => p.team !== shooter.team);
  const offense = game.players.filter((p) => p.team === shooter.team);
  const defProb = 0.68;
  if (Math.random() < defProb)
    return weightedChoice(
      defenders,
      (p) => p.rating + 20 - Math.hypot(p.x - shooter.x, p.y - shooter.y)
    );
  return weightedChoice(
    offense,
    (p) => p.rating + 5 - Math.hypot(p.x - shooter.x, p.y - shooter.y)
  );
}

function findNearestDefender(player) {
  const defenders = game.players.filter((p) => p.team !== player.team);
  if (!defenders.length) return null;
  let best = defenders[0],
    bestD = Math.hypot(defenders[0].x - player.x, defenders[0].y - player.y);
  for (let i = 1; i < defenders.length; i++) {
    const d = Math.hypot(defenders[i].x - player.x, defenders[i].y - player.y);
    if (d < bestD) {
      best = defenders[i];
      bestD = d;
    }
  }
  return best;
}

function findClosestPlayers(origin, n = 1, teamFilter) {
  const pool = game.players.filter((p) => p.team === teamFilter);
  return pool
    .sort(
      (a, b) =>
        Math.hypot(a.x - origin.x, a.y - origin.y) -
        Math.hypot(b.x - origin.x, b.y - origin.y)
    )
    .slice(0, n);
}

function findClosestPlayer(x, y, team) {
  const pool = game.players.filter((p) => p.team === team);
  if (!pool.length) return null;
  return pool.reduce((best, p) => {
    const d = Math.hypot(p.x - x, p.y - y);
    const bd = Math.hypot(best.x - x, best.y - y);
    return d < bd ? p : best;
  }, pool[0]);
}

function getOpponentBasketX(team) {
  return team === "home" ? canvas.width - 30 : 30;
}
function getBasketY() {
  return canvas.height / 2;
}

function weightedChoice(arr, weightFn) {
  if (!arr || arr.length === 0) return null;
  const weights = arr.map(weightFn);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < arr.length; i++) {
    if (r < weights[i]) return arr[i];
    r -= weights[i];
  }
  return arr[0];
}

// --- rendering ---
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawCourt();
  if (!game) return;

  // players
  game.players.forEach((p) => {
    ctx.beginPath();
    ctx.fillStyle = p.team === "home" ? "#1e90ff" : "#ff4500";
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 1;
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.name.split(" ")[0], p.x, p.y + 4);
  });

  // ball
  if (game.ball) {
    if (game.ball.state === "held" && game.ball.holder) {
      game.ball.x =
        game.ball.holder.x + (game.ball.holder.team === "home" ? 10 : -10);
      game.ball.y = game.ball.holder.y - 8;
    }
    ctx.beginPath();
    ctx.fillStyle = "#e09b2c";
    ctx.arc(game.ball.x, game.ball.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6b3a12";
    ctx.stroke();
  }

  // HUD
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(10, 10, 340, 52);
  ctx.fillStyle = "#fff";
  ctx.font = "14px sans-serif";
  ctx.fillText(
    `${game.home.name} ${game.homeScore}  -  ${game.awayScore} ${game.away.name}`,
    20,
    36
  );
  ctx.fillStyle = "#000";
  ctx.font = "12px monospace";
  const minutes = Math.floor(game.timeLeft / 60);
  const seconds = Math.floor(game.timeLeft % 60)
    .toString()
    .padStart(2, "0");
  ctx.fillText(
    `Q${game.period}  ${minutes}:${seconds}   Shot: ${Math.ceil(
      game.possessionTime
    )}`,
    canvas.width - 300,
    34
  );
}

function drawCourt() {
  ctx.fillStyle = "#f0e6c8";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#b17b3a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 0);
  ctx.lineTo(canvas.width / 2, canvas.height);
  ctx.stroke();
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(30, canvas.height / 2, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(canvas.width - 30, canvas.height / 2, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#b17b3a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(
    60,
    canvas.height / 2,
    70,
    140,
    0,
    Math.PI / 2,
    (Math.PI * 3) / 2
  );
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(
    canvas.width - 60,
    canvas.height / 2,
    70,
    140,
    0,
    (Math.PI * 3) / 2,
    Math.PI / 2
  );
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, 50, 0, Math.PI * 2);
  ctx.stroke();
}

drawCourt();
