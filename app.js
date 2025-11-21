// app.js - Instruction Replay with realistic transitions + clock scheduling
// Replace your current file with this version.

const fileInput = document.getElementById("fileInput");
const instrFile = document.getElementById("instrFile");
const loadInstrBtn = document.getElementById("loadInstrBtn");
const playInstrBtn = document.getElementById("playInstrBtn");
const pauseInstrBtn = document.getElementById("pauseInstrBtn");
const prevInstrBtn = document.getElementById("prevInstrBtn");
const nextInstrBtn = document.getElementById("nextInstrBtn");
const instrDelayEl = document.getElementById("instrDelay");

const homeSelect = document.getElementById("homeSelect");
const awaySelect = document.getElementById("awaySelect");
const teamSelectors = document.getElementById("teamSelectors");
const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const speedSlider = document.getElementById("speed");
const modeSelect = document.getElementById("modeSelect");

const logEl = document.getElementById("log");
const canvas = document.getElementById("court");
const ctx = canvas.getContext("2d");

// --- realistic tuning constants ---
const PLAYER_BASE_SPEED = 120; // px/sec baseline
const STEAL_RADIUS = 36; // px
const STEAL_APPROACH_SPEED = 160; // px/sec when approaching to steal
const THREE_PT_DIST = 220; // px from basket to be considered a 3-pointer

let league = null;
let teams = [];
let playersGlobal = [];
let game = null;
let animRequest = null;

// Instruction replay state
let instructions = []; // array of event objects (may include synthetic)
let instrIndex = 0;
let instrPlaying = false;
let instrTimer = null;

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

loadInstrBtn.addEventListener("click", async () => {
  const f = instrFile.files[0];
  if (!f) {
    log("Select an instructions .json file first.");
    return;
  }
  try {
    const text = await f.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      log("Instructions file must be a JSON array of events.");
      return;
    }
    // parse and preprocess (clock parsing, assist pass insertion, gap-filling)
    instructions = preprocessInstructions(data);
    instrIndex = 0;
    log(`Loaded ${instructions.length} instructions (with preprocessing).`);
    render(); // show initial state
  } catch (err) {
    log("Error loading instructions: " + err.message);
  }
});

playInstrBtn.addEventListener("click", () => {
  if (!instructions.length) {
    log("No instructions loaded.");
    return;
  }
  instrPlaying = true;
  // if playing by clock, animLoop will dispatch events as time elapses
  if (!game) {
    const home = teams[0],
      away = teams[1];
    if (home && away) startGame(home, away);
  }
});

pauseInstrBtn.addEventListener("click", () => {
  instrPlaying = false;
  if (instrTimer) {
    clearTimeout(instrTimer);
    instrTimer = null;
  }
});

prevInstrBtn.addEventListener("click", () => {
  stepInstr(-1);
});
nextInstrBtn.addEventListener("click", () => {
  stepInstr(1);
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

modeSelect.addEventListener("change", () => {
  const mode = modeSelect.value;
  if (mode === "replay") {
    teamSelectors.style.display = "";
  }
});

function log(s) {
  const p = document.createElement("div");
  p.textContent = s;
  logEl.prepend(p);
}

// --- parse league and roster ---
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

// --- game state and animation ---
function startGame(home, away) {
  // if instructions provide a max clock, start there so events happen as expected
  let startClock = 12 * 60;
  if (instructions && instructions.length) {
    const maxTrigger = Math.max(
      0,
      ...instructions.map((e) => (e.triggerAt !== undefined ? e.triggerAt : 0))
    );
    // If maxTrigger provided and less than 12*60, keep 12*60; else use maxTrigger
    startClock = Math.max(12 * 60, maxTrigger);
  }

  game = {
    home,
    away,
    homeScore: 0,
    awayScore: 0,
    period: 1,
    timeLeft: startClock,
    ball: {
      x: canvas.width / 2,
      y: canvas.height / 2,
      vx: 0,
      vy: 0,
      state: "held", // held, flying, ground
      holder: null,
      pendingArrival: null,
      ttl: 0,
      flightType: null,
    },
    players: [],
    offense: Math.random() < 0.5 ? "home" : "away",
    paused: false,
    speed: parseFloat(speedSlider.value) || 1,
    possessionTime: 24,
    lastUpdate: performance.now(),
    currentPlay: null,
    pendingSteals: [],
  };

  function chooseFive(roster) {
    if (!roster || roster.length === 0) {
      const res = [];
      for (let i = 0; i < 5; i++) res.push({ name: `P${i + 1}`, rating: 60 });
      return res;
    }
    const sorted = roster
      .slice()
      .sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const five = sorted.slice(0, Math.min(5, sorted.length));
    while (five.length < 5) five.push({ name: "Sub", rating: 55 });
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

  homeFive.forEach((pl, i) =>
    game.players.push({
      team: "home",
      name: pl.name,
      rating: pl.rating || 60,
      x: positionsHome[i].x,
      y: positionsHome[i].y,
      tx: positionsHome[i].x,
      ty: positionsHome[i].y,
      move: null,
    })
  );
  awayFive.forEach((pl, i) =>
    game.players.push({
      team: "away",
      name: pl.name,
      rating: pl.rating || 60,
      x: positionsAway[i].x,
      y: positionsAway[i].y,
      tx: positionsAway[i].x,
      ty: positionsAway[i].y,
      move: null,
    })
  );

  document.getElementById("homeLabel").textContent = home.name;
  document.getElementById("awayLabel").textContent = away.name;
  document.getElementById("homeScore").textContent = "0";
  document.getElementById("awayScore").textContent = "0";
  log(`Game started (${modeSelect.value}) at ${formatClock(game.timeLeft)}.`);

  if (animRequest) cancelAnimationFrame(animRequest);
  game.lastUpdate = performance.now();
  animLoop();
}

// animation loop: always update physics (players + ball)
function animLoop(t) {
  if (!game) return;
  animRequest = requestAnimationFrame(animLoop);
  const now = performance.now();
  const dtReal = (now - game.lastUpdate) / 1000;
  game.lastUpdate = now;
  if (game.paused) return;
  const dt = dtReal * game.speed;

  // decrement game clock so timestamped events can trigger
  game.timeLeft = Math.max(0, game.timeLeft - dt);

  // update players and ball each frame so transitions animate
  updatePhysics(dt);

  // dispatch timed instructions when playing by clock
  if (instrPlaying) dispatchTimedInstructions();

  render();
}

function updatePhysics(dt) {
  if (!game) return;

  game.players.forEach((p) => {
    if (p.move) {
      p.move.tleft -= dt;
      const dur = p.move.duration || 0.001;
      const frac = Math.max(0, Math.min(1, 1 - p.move.tleft / dur));
      p.x = p.move.sx + (p.move.tx - p.move.sx) * frac;
      p.y = p.move.sy + (p.move.ty - p.move.sy) * frac;
      if (p.move.tleft <= 0) {
        p.x = p.move.tx;
        p.y = p.move.ty;
        p.move = null;
      }
    } else {
      const dx = p.tx - p.x,
        dy = p.ty - p.y,
        dist = Math.hypot(dx, dy);
      if (dist > 1) {
        const step = Math.min(dist, PLAYER_BASE_SPEED * (1 / 60));
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
      }
    }
  });

  // pending steals approach logic
  if (game.pendingSteals && game.pendingSteals.length) {
    for (let i = game.pendingSteals.length - 1; i >= 0; i--) {
      const ps = game.pendingSteals[i];
      const thief = ps.thief;
      const from = ps.from;
      if (!thief || !from) {
        game.pendingSteals.splice(i, 1);
        continue;
      }
      const d = Math.hypot(thief.x - from.x, thief.y - from.y);
      if (d <= STEAL_RADIUS) {
        finalizeSteal(thief, from);
        game.pendingSteals.splice(i, 1);
      } else {
        const approachDist = Math.max(10, d - STEAL_RADIUS / 2);
        const nx = from.x + ((thief.x - from.x) / d) * approachDist || from.x;
        const ny = from.y + ((thief.y - from.y) / d) * approachDist || from.y;
        if (!thief.move) {
          const travel = Math.min(approachDist / STEAL_APPROACH_SPEED, 0.6);
          setMoveTween(thief, nx, ny, travel);
        }
      }
    }
  }

  // update ball flight
  const b = game.ball;
  if (b && b.state === "flying") {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.ttl !== undefined) {
      b.ttl -= dt;
      if (b.ttl <= 0) {
        const pending = b.pendingArrival;
        b.state = "held";
        b.pendingArrival = null;
        b.flightType = null;
        b.ttl = 0;
        if (pending) finalizeBallArrival(pending);
      }
    }
  }
}

function dispatchTimedInstructions() {
  if (!instructions || instrIndex >= instructions.length) return;
  // instructions are sorted descending by triggerAt (seconds left)
  // Apply all events whose triggerAt >= game.timeLeft (i.e., time has passed to or past that clock)
  while (instrIndex < instructions.length) {
    const ev = instructions[instrIndex];
    if (ev.triggerAt === undefined) {
      // immediate (no clock) events: apply only if playback requested via step / play
      // apply now if instrPlaying and no triggerAt
      applyInstruction(ev);
      instrIndex++;
      continue;
    }
    // If game.timeLeft <= ev.triggerAt then it's time (clock counts down)
    if (game.timeLeft <= ev.triggerAt) {
      applyInstruction(ev);
      instrIndex++;
      continue;
    }
    break;
  }
}

function stepInstr(dir) {
  instrPlaying = false;
  if (instrTimer) {
    clearTimeout(instrTimer);
    instrTimer = null;
  }
  if (dir > 0) {
    if (instrIndex < instructions.length) {
      const ev = instructions[instrIndex];
      applyInstruction(ev);
      instrIndex++;
    }
  } else {
    if (instrIndex <= 0) return;
    instrIndex = Math.max(0, instrIndex - 1);
    rebuildStateToIndex(instrIndex);
  }
  render();
}

function rebuildStateToIndex(index) {
  if (!game) return;
  const home = game.home,
    away = game.away;
  startGame(home, away);
  for (let i = 0; i < index; i++) {
    applyInstruction(instructions[i], { silent: true });
  }
}

function findPlayer(team, name) {
  if (!game) return null;
  const pool = game.players.filter((p) => p.team === team);
  let p =
    pool.find((x) => x.name === name) ||
    pool.find((x) => (x.name || "").startsWith(name)) ||
    pool[0];
  return p;
}

function setMoveTween(p, tx, ty, duration) {
  if (!p) return;
  p.move = {
    sx: p.x,
    sy: p.y,
    tx: tx,
    ty: ty,
    tleft: duration || 0.001,
    duration: duration || 0.001,
  };
  p.tx = tx;
  p.ty = ty;
}

function finalizeSteal(thief, from) {
  game.ball.state = "held";
  game.ball.holder = thief;
  game.offense = thief.team;
  game.ball.x = thief.x + (thief.team === "home" ? 10 : -10);
  game.ball.y = thief.y - 8;
  log(`${thief.name} stole the ball (instruction)`);
}

function finalizeBallArrival(pending) {
  if (!pending) return;
  if (pending.type === "pass") {
    const pTo = pending.to;
    if (pTo) {
      game.ball.state = "held";
      game.ball.holder = pTo;
      game.ball.x = pTo.x + (pTo.team === "home" ? 10 : -10);
      game.ball.y = pTo.y - 8;
    } else {
      game.ball.state = "ground";
    }
  } else if (pending.type === "inbound") {
    const handler = pending.handler;
    if (handler) {
      game.ball.state = "held";
      game.ball.holder = handler;
      game.ball.x = handler.x + (handler.team === "home" ? 10 : -10);
      game.ball.y = handler.y - 8;
    }
  } else if (pending.type === "shot") {
    const shooter = pending.shooter;
    if (pending.made) {
      if (shooter.team === "home") game.homeScore += pending.points || 2;
      else game.awayScore += pending.points || 2;
      document.getElementById("homeScore").textContent = game.homeScore;
      document.getElementById("awayScore").textContent = game.awayScore;
      log(`${shooter.name} scored ${pending.points || 2} (instruction)`);
      setInboundAfterScore();
    } else {
      log(`${shooter.name} missed (instruction)`);
      if (pending.rebound) {
        const r = pending.rebound;
        const rb = findPlayer(r.team, r.name);
        if (rb) {
          game.ball.state = "held";
          game.ball.holder = rb;
          game.offense = rb.team;
          game.ball.x = rb.x + (rb.team === "home" ? 10 : -10);
          game.ball.y = rb.y - 8;
        } else {
          game.ball.state = "ground";
        }
      } else {
        game.ball.state = "ground";
      }
    }
  }
}

function setInboundAfterScore() {
  game.ball.state = "ground";
  game.ball.holder = null;
  game.ball.vx = 0;
  game.ball.vy = 0;
  game.ball.ttl = 0;
  game.ball.pendingArrival = null;
  game.ball.flightType = null;
  game.ball.x = canvas.width / 2;
  game.ball.y = canvas.height / 2;
}

// main instruction application (uses pendingArrival)
function applyInstruction(ev, opts = {}) {
  if (!game) return;
  switch (ev.type) {
    case "setPositions":
      if (Array.isArray(ev.positions)) {
        ev.positions.forEach((pos) => {
          const p = findPlayer(pos.team, pos.name);
          if (p) {
            p.tx = pos.x;
            p.ty = pos.y;
            p.x = pos.x;
            p.y = pos.y;
            p.move = null;
          }
        });
      } else if (ev.team && Array.isArray(ev.list)) {
        ev.list.forEach((pos, i) => {
          const p = game.players.filter((pl) => pl.team === ev.team)[i];
          if (p) {
            p.tx = pos.x;
            p.ty = pos.y;
            p.x = pos.x;
            p.y = pos.y;
            p.move = null;
          }
        });
      }
      break;

    case "inbound": {
      const to = ev.to;
      const handler = findPlayer(to.team, to.name);
      if (handler) {
        if (ev.to && ev.to.tx !== undefined) {
          handler.tx = ev.to.tx;
          handler.ty = ev.to.ty;
          if (ev.duration)
            setMoveTween(handler, handler.tx, handler.ty, ev.duration);
        }
        const target = { x: handler.tx, y: handler.ty };
        game.ball.state = "flying";
        game.ball.flightType = "inbound";
        const travel = ev.duration || 0.6;
        game.ball.vx = (target.x - game.ball.x) / travel;
        game.ball.vy = (target.y - game.ball.y) / travel;
        game.ball.ttl = travel;
        game.ball.pendingArrival = { type: "inbound", handler };
      }
      break;
    }

    case "move": {
      const team = ev.team,
        name = ev.name;
      const p = findPlayer(team, name);
      if (p) {
        if (ev.x !== undefined && ev.y !== undefined) {
          if (ev.duration && !ev.instant)
            setMoveTween(p, ev.x, ev.y, ev.duration);
          else {
            p.tx = ev.x;
            p.ty = ev.y;
            if (ev.instant) {
              p.x = p.tx;
              p.y = p.ty;
              p.move = null;
            } else {
              setMoveTween(p, ev.x, ev.y, ev.duration || 0.45);
            }
          }
        }
      }
      break;
    }

    case "pass": {
      const from = ev.from,
        to = ev.to;
      const pFrom = findPlayer(from.team, from.name);
      const pTo = findPlayer(to.team, to.name);
      if (pFrom && pTo) {
        const travel =
          ev.duration ||
          Math.max(0.25, Math.hypot(pFrom.x - pTo.x, pFrom.y - pTo.y) / 400);
        game.ball.state = "flying";
        game.ball.flightType = "pass";
        game.ball.vx = (pTo.x - pFrom.x) / travel;
        game.ball.vy = (pTo.y - pFrom.y) / travel;
        game.ball.ttl = travel;
        game.ball.pendingArrival = { type: "pass", to: pTo };
        game.ball.holder = null;
        // optionally nudge receiver position
        if (ev.to && ev.to.tx !== undefined)
          setMoveTween(
            pTo,
            ev.to.tx,
            ev.to.ty || pTo.ty,
            Math.min(travel, ev.to.moveDur || 0.4)
          );
      }
      break;
    }

    case "shot": {
      const shooterRef = ev.shooter;
      const shooter = findPlayer(shooterRef.team, shooterRef.name);
      if (shooter) {
        const targetX = getOpponentBasketX(shooter.team),
          targetY = getBasketY();
        const distToBasket = Math.hypot(
          targetX - shooter.x,
          targetY - shooter.y
        );
        let points = ev.points || 2;
        if (points === 3 && distToBasket < THREE_PT_DIST) {
          points = 2;
          log(`${shooter.name}'s 3-pointer downgraded to 2 (too close)`);
        }
        // allow short pre-shot move if coordinates provided
        if (ev.shooter && ev.shooter.tx !== undefined && ev.duration) {
          setMoveTween(
            shooter,
            ev.shooter.tx,
            ev.shooter.ty || shooter.ty,
            Math.min(ev.duration, 0.6)
          );
        }
        const travel =
          ev.flight ||
          Math.max(
            0.45,
            Math.hypot(targetX - shooter.x, targetY - shooter.y) / 420
          );
        game.ball.state = "flying";
        game.ball.flightType = "shot";
        game.ball.shooter = shooter;
        game.ball.shootTarget = { x: targetX, y: targetY };
        game.ball.vx = (targetX - shooter.x) / travel;
        game.ball.vy = (targetY - shooter.y) / travel;
        game.ball.ttl = travel;
        game.ball.holder = null;
        game.ball.pendingArrival = {
          type: "shot",
          shooter,
          made: !!ev.made,
          points,
          rebound: ev.rebound,
        };
      }
      break;
    }

    case "score":
      if (ev.team === "home") game.homeScore += ev.points || 2;
      else game.awayScore += ev.points || 2;
      document.getElementById("homeScore").textContent = game.homeScore;
      document.getElementById("awayScore").textContent = game.awayScore;
      break;

    case "rebound": {
      const p = findPlayer(ev.team, ev.name);
      if (p) {
        game.ball.state = "held";
        game.ball.holder = p;
        game.offense = p.team;
        game.ball.x = p.x + (p.team === "home" ? 10 : -10);
        game.ball.y = p.y - 8;
      }
      break;
    }

    case "steal": {
      const thief = findPlayer(ev.to.team, ev.to.name);
      const from = findPlayer(ev.from.team, ev.from.name);
      if (thief && from) {
        const d = Math.hypot(thief.x - from.x, thief.y - from.y);
        if (d <= STEAL_RADIUS) finalizeSteal(thief, from);
        else {
          game.pendingSteals = game.pendingSteals || [];
          if (
            !game.pendingSteals.find(
              (ps) => ps.thief === thief && ps.from === from
            )
          ) {
            game.pendingSteals.push({ thief, from });
            setMoveTween(
              thief,
              from.x,
              from.y,
              Math.min(0.9, Math.max(0.3, d / STEAL_APPROACH_SPEED))
            );
          }
        }
      }
      break;
    }

    case "setScore":
      game.homeScore = ev.home || 0;
      game.awayScore = ev.away || 0;
      document.getElementById("homeScore").textContent = game.homeScore;
      document.getElementById("awayScore").textContent = game.awayScore;
      break;

    default:
      console.warn("Unknown instruction type", ev);
  }

  if (!opts.silent) render();
}

// ---------------- helpers reused ----------------
function getOpponentBasketX(team) {
  return team === "home" ? canvas.width - 30 : 30;
}
function getBasketY() {
  return canvas.height / 2;
}

// ---------------- rendering ----------------
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawCourt();

  if (!game) return;

  // players
  game.players.forEach((p) => {
    ctx.beginPath();
    ctx.fillStyle = p.team === "home" ? "#1e90ff" : "#ff4500";
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#222";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText((p.name || "").split(" ")[0], p.x, p.y + 4);
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
  ctx.fillRect(10, 10, 360, 56);
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
      game.possessionTime || 0
    )}`,
    canvas.width - 300,
    36
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

// ----------------- Preprocessing / scheduling helpers -----------------

// Accepts events array (original play-by-play). Returns new instruction list
// with parsed triggerAt (seconds left) and synthetic passes/moves inserted.
function preprocessInstructions(orig) {
  const list = orig.map((e) => ({ ...e })); // shallow clone
  // parse clock strings into triggerAt (seconds left). Accept "M:SS" or numeric seconds.
  list.forEach((ev) => {
    if (ev.clock !== undefined && ev.clock !== null) {
      ev.triggerAt = parseClock(ev.clock);
    }
    // keep any explicit duration/flight as-is
  });

  // sort descending by triggerAt (clock decreases)
  list.sort((a, b) => {
    const A = a.triggerAt !== undefined ? a.triggerAt : -1;
    const B = b.triggerAt !== undefined ? b.triggerAt : -1;
    return B - A;
  });

  // Simulate through events to track who currently holds the ball (approx)
  let simulatedHolder = null; // {team,name}
  let simulatedTeam = null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    // If this is a shot with an assist, insert an assist pass just before the shot
    if (ev.type === "shot" && ev.assist && ev.triggerAt !== undefined) {
      // schedule assist pass ~0.6s before shot (or half the gap if next event was earlier)
      const passTime = Math.max(0, ev.triggerAt + 0.0 - 0.6);
      const assistEv = {
        type: "pass",
        from: { team: ev.assist.team, name: ev.assist.name },
        to: { team: ev.shooter.team, name: ev.shooter.name },
        duration: 0.35,
        generated: true,
        triggerAt: passTime,
      };
      out.push(assistEv);
      // also schedule a small move for shooter to get into shot position just before shot
      const preMove = {
        type: "move",
        team: ev.shooter.team,
        name: ev.shooter.name,
        duration: 0.4,
        generated: true,
        // no coordinates — renderer will simply nudge if coordinates provided later
        triggerAt: Math.max(0, ev.triggerAt + 0.0 - 0.9),
      };
      out.push(preMove);
      simulatedHolder = { team: ev.shooter.team, name: ev.shooter.name };
      simulatedTeam = ev.shooter.team;
      out.push(ev);
      continue;
    }

    // otherwise, if this event is a rebound/inbound/pass/steal it determines holder
    if (ev.type === "inbound" && ev.to) {
      simulatedHolder = { team: ev.to.team, name: ev.to.name };
      simulatedTeam = ev.to.team;
      out.push(ev);
      continue;
    }
    if (ev.type === "pass" && ev.to) {
      simulatedHolder = { team: ev.to.team, name: ev.to.name };
      simulatedTeam = ev.to.team;
      out.push(ev);
      continue;
    }
    if (ev.type === "rebound" && ev.name) {
      simulatedHolder = { team: ev.team, name: ev.name };
      simulatedTeam = ev.team;
      out.push(ev);
      continue;
    }
    if (ev.type === "steal" && ev.to) {
      simulatedHolder = { team: ev.to.team, name: ev.to.name };
      simulatedTeam = ev.to.team;
      out.push(ev);
      continue;
    }
    if (ev.type === "shot") {
      // after a shot, holder becomes null until rebound/inbound unless shot has rebound info
      if (ev.made) {
        simulatedHolder = null;
        simulatedTeam = null;
      } else if (ev.rebound) {
        simulatedHolder = { team: ev.rebound.team, name: ev.rebound.name };
        simulatedTeam = ev.rebound.team;
      } else {
        simulatedHolder = null;
        simulatedTeam = null;
      }
      out.push(ev);
      continue;
    }

    // For other event types, simply push through
    out.push(ev);
  }

  // Now we have 'out' (with assist passes inserted). Next: fill gaps between sequential events
  // by adding simple move/pass events where helpful.
  const filled = [];
  for (let i = 0; i < out.length; i++) {
    const ev = out[i];
    filled.push(ev);
    const next = out[i + 1];
    if (!next || ev.triggerAt === undefined || next.triggerAt === undefined)
      continue;
    const gap = ev.triggerAt - next.triggerAt; // positive if ev earlier than next
    if (gap > 0.7) {
      // create a synthetic "move" for upcoming actor to get into position halfway through gap
      // identify the primary next actor (target shooter, rebounder, or inbound)
      let actor = null;
      if (next.type === "shot" && next.shooter) actor = next.shooter;
      else if (next.type === "rebound" && next.name)
        actor = { team: next.team, name: next.name };
      else if (next.type === "inbound" && next.to) actor = next.to;
      // schedule move at mid-gap
      if (actor) {
        const mv = {
          type: "move",
          team: actor.team,
          name: actor.name,
          duration: Math.min(0.9, gap * 0.6),
          generated: true,
          triggerAt: next.triggerAt + gap * 0.5,
        };
        filled.push(mv);
      }
      // if previous event left a simulated holder and next is same team shot and holder != shooter, insert pass shortly before next
      // We'll try to infer holder by scanning back for last holder-setting event
      let lastHolder = null;
      for (let j = i; j >= 0; j--) {
        const e2 = filled[j];
        if (!e2) continue;
        if (e2.type === "inbound" && e2.to) {
          lastHolder = e2.to;
          break;
        }
        if (e2.type === "pass" && e2.to) {
          lastHolder = e2.to;
          break;
        }
        if (e2.type === "rebound" && e2.name) {
          lastHolder = { team: e2.team, name: e2.name };
          break;
        }
        if (e2.type === "steal" && e2.to) {
          lastHolder = e2.to;
          break;
        }
        if (e2.type === "shot" && e2.made === false && e2.rebound) {
          lastHolder = { team: e2.rebound.team, name: e2.rebound.name };
          break;
        }
      }
      if (
        lastHolder &&
        next.type === "shot" &&
        lastHolder.team === next.shooter.team &&
        lastHolder.name !== next.shooter.name
      ) {
        const passTime = Math.max(next.triggerAt + 0.05, next.triggerAt - 0.45);
        const synthPass = {
          type: "pass",
          from: { team: lastHolder.team, name: lastHolder.name },
          to: { team: next.shooter.team, name: next.shooter.name },
          duration: 0.35,
          generated: true,
          triggerAt: passTime,
        };
        filled.push(synthPass);
      }
    }
  }

  // final sort descending by triggerAt with fallback for items lacking triggerAt (put at end)
  filled.sort((a, b) => {
    const A = a.triggerAt !== undefined ? a.triggerAt : -99999;
    const B = b.triggerAt !== undefined ? b.triggerAt : -99999;
    return B - A;
  });

  // normalize index order for runtime (we will apply while clock decreases)
  return filled;
}

// parse "M:SS" or numeric seconds into seconds-left number
function parseClock(s) {
  if (s === null || s === undefined) return undefined;
  if (typeof s === "number") return s;
  if (typeof s === "string") {
    const m = s.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
    if (m) {
      const mins = parseInt(m[1], 10);
      const secs = parseInt(m[2], 10);
      const frac = m[3] ? parseFloat("0." + m[3]) : 0;
      return mins * 60 + secs + frac;
    }
    const n = parseFloat(s);
    if (!isNaN(n)) return n;
  }
  return undefined;
}
function formatClock(sec) {
  if (sec === undefined || sec === null) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}
