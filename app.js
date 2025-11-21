// app.js - Instruction Replay with realistic transitions
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
const PLAYER_BASE_SPEED = 120; // px/sec for a full-duration move interpolation baseline
const STEAL_RADIUS = 36; // px -- must be within this to steal
const STEAL_APPROACH_SPEED = 160; // px/sec when approaching to steal
const THREE_PT_DIST = 220; // px from basket to be considered a 3-pointer
const PASS_INTERCEPT_RADIUS = 28; // px for simple pass interception (not used aggressively here)

let league = null;
let teams = [];
let playersGlobal = [];
let game = null;
let animRequest = null;

// Instruction replay state
let instructions = []; // array of events
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
    instructions = data;
    instrIndex = 0;
    log(`Loaded ${instructions.length} instructions.`);
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
  advanceInstr(); // starts playback
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
  // start chosen mode (both modes need initial player placement)
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
      state: "held", // held, flying, ground
      holder: null,
      pendingArrival: null, // object describing finalization when ttl hits zero
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
    pendingSteals: [], // array of {thief, from}
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
      move: null, // {sx,sy,tx,ty,tleft,duration}
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
  log(`Game started (${modeSelect.value}).`);

  if (animRequest) cancelAnimationFrame(animRequest);
  game.lastUpdate = performance.now();
  animLoop();
}

// animation loop: always update physics (players + ball), regardless of mode
function animLoop(t) {
  if (!game) return;
  animRequest = requestAnimationFrame(animLoop);
  const now = performance.now();
  const dtReal = (now - game.lastUpdate) / 1000;
  game.lastUpdate = now;
  if (game.paused) return;
  const dt = dtReal * game.speed;

  // update players and ball each frame so replay transitions animate correctly
  updatePhysics(dt);

  // if simulate mode, you might still want more AI; keep stepGame for fallback
  if (modeSelect.value === "simulate") stepGame(dt);

  render();
}

function updatePhysics(dt) {
  if (!game) return;

  // update players' active tweens (move)
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
      // subtle smoothing toward tx/ty when not doing a scheduled tween
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

  // handle pending steal attempts (approach then finalize if close)
  if (game.pendingSteals && game.pendingSteals.length) {
    for (let i = game.pendingSteals.length - 1; i >= 0; i--) {
      const ps = game.pendingSteals[i];
      const thief = ps.thief;
      const from = ps.from;
      // if either missing, remove
      if (!thief || !from) {
        game.pendingSteals.splice(i, 1);
        continue;
      }
      const d = Math.hypot(thief.x - from.x, thief.y - from.y);
      if (d <= STEAL_RADIUS) {
        finalizeSteal(thief, from);
        game.pendingSteals.splice(i, 1);
      } else {
        // keep moving thief toward the ball holder (approach)
        // set a short move tween toward a point near the target
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
        // finalize according to pendingArrival object (deterministic)
        const pending = b.pendingArrival;
        b.state = "held"; // default until overridden
        b.pendingArrival = null;
        b.flightType = null;
        b.ttl = 0;
        if (pending) finalizeBallArrival(pending);
      }
    }
  }
}

// minimal simulate fallback kept (not used in replay except for extra behavior)
function stepGame(dt) {
  game.timeLeft -= dt;
  // minor player drift handled in updatePhysics
}

// ---------------- Instruction interpreter ----------------
// Event examples in prior file

function advanceInstr() {
  if (!instructions.length) return;
  if (instrIndex >= instructions.length) {
    instrPlaying = false;
    return;
  }
  const ev = instructions[instrIndex];
  applyInstruction(ev);
  instrIndex++;
  if (instrPlaying && instrIndex < instructions.length) {
    const delay = evtDelay(ev) || parseInt(instrDelayEl.value || 800, 10);
    instrTimer = setTimeout(advanceInstr, delay);
  } else {
    instrPlaying = false;
  }
}

function evtDelay(ev) {
  if (!ev) return 0;
  if (ev.delay !== undefined) return ev.delay;
  if (ev.duration !== undefined) return Math.round(ev.duration * 1000);
  if (ev.type === "pass") return 350;
  if (ev.type === "shot") return 600;
  if (ev.type === "inbound") return 600;
  return parseInt(instrDelayEl.value || 800, 10);
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

// helper to set a move tween on a player
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
  // keep target tx/ty for fallback smoothing as well
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
      // leave ball ground and wait for explicit inbound or next event
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

// simple post-score handler so instructions can remain deterministic (inbound events preferred)
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

// main instruction application (no timeouts; uses pendingArrival)
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
          if (ev.duration && !ev.instant) {
            setMoveTween(p, ev.x, ev.y, ev.duration);
          } else {
            p.tx = ev.x;
            p.ty = ev.y;
            if (ev.instant) {
              p.x = p.tx;
              p.y = p.ty;
              p.move = null;
            } else {
              // small default tween
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
      }
      break;
    }

    case "shot": {
      const shooterRef = ev.shooter;
      const shooter = findPlayer(shooterRef.team, shooterRef.name);
      if (shooter) {
        const targetX = getOpponentBasketX(shooter.team),
          targetY = getBasketY();
        // validate three-pointer: if event claims 3 but shooter is inside THREE_PT_DIST, downgrade
        const distToBasket = Math.hypot(
          targetX - shooter.x,
          targetY - shooter.y
        );
        let points = ev.points || 2;
        if (points === 3 && distToBasket < THREE_PT_DIST) {
          points = 2;
          log(`${shooter.name}'s 3-pointer downgraded to 2 (too close)`);
        }
        const travel =
          ev.flight ||
          Math.max(
            0.5,
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
        // record pending shot result and rebound info
        game.ball.pendingArrival = {
          type: "shot",
          shooter,
          made: !!ev.made,
          madeFlag: ev.made,
          madePoints: points,
          rebound: ev.rebound,
          madeWas: ev.made,
          points,
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
        if (d <= STEAL_RADIUS) {
          finalizeSteal(thief, from);
        } else {
          // schedule approach and finalize when close enough
          game.pendingSteals = game.pendingSteals || [];
          // avoid duplicate entries
          if (
            !game.pendingSteals.find(
              (ps) => ps.thief === thief && ps.from === from
            )
          ) {
            game.pendingSteals.push({ thief, from });
            // nudge thief toward the target
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
      game.possessionTime || 0
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
