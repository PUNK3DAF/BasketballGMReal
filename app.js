// app.js - Instruction Replay (updated):
// - No automatic passes inserted
// - Start clock uses first instruction time (so 10:00 won't wait 2 minutes)
// - Continuous idle motion + proactive approach to next instruction
// - Keeps previous features: subs, FT, and-ones, OOB, timeouts, steal proximity, etc.

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

// tuning
const PLAYER_BASE_SPEED = 120;
const STEAL_RADIUS = 36;
const STEAL_APPROACH_SPEED = 160;
const THREE_PT_DIST = 220;

// approach/anticipation
const APPROACH_THRESHOLD = 3.5; // seconds before an event to begin approach
const IDLE_MOVE_RADIUS = 28; // px for small idle wandering
const IDLE_MIN_DUR = 0.8;
const IDLE_MAX_DUR = 1.8;

let league = null;
let teams = [];
let playersGlobal = [];
let game = null;
let animRequest = null;

let instructions = [];
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
    instructions = preprocessInstructions(data);
    instrIndex = 0;
    log(`Loaded ${instructions.length} instructions (with preprocessing).`);
    render();
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
  if (mode === "replay") teamSelectors.style.display = "";
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
  // Fix: if instructions include a trigger time (clock), start the simulation at that time.
  // Use earliest meaningful trigger (maxTrigger) if present; otherwise default to 12*60.
  let startClock = 12 * 60;
  if (instructions && instructions.length) {
    const maxTrigger = Math.max(
      ...instructions.map((e) => (e.triggerAt !== undefined ? e.triggerAt : -1))
    );
    if (maxTrigger > 0) startClock = maxTrigger;
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
      idleTimer: Math.random() * 1.5 + 0.2,
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
      idleTimer: Math.random() * 1.5 + 0.2,
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

  // proactively prepare players for the next instruction so the scene morphs
  prepareForNextInstruction();

  // dispatch timed instructions when playing by clock
  if (instrPlaying) dispatchTimedInstructions();

  render();
}

function updatePhysics(dt) {
  if (!game) return;

  // idle movement and active tweens
  game.players.forEach((p) => {
    // reduce idle timer even if move active so idle resets later
    p.idleTimer = (p.idleTimer || 0) - dt;

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
        p.idleTimer =
          Math.random() * (IDLE_MAX_DUR - IDLE_MIN_DUR) + IDLE_MIN_DUR;
      }
    } else {
      // idle drift toward tx,ty
      const dx = p.tx - p.x,
        dy = p.ty - p.y,
        dist = Math.hypot(dx, dy);
      if (dist > 1) {
        const step = Math.min(dist, PLAYER_BASE_SPEED * (1 / 60));
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
      } else {
        // random small idle moves to avoid standing still
        if (!p.move && p.idleTimer <= 0) {
          const angle = Math.random() * Math.PI * 2;
          const r = Math.random() * IDLE_MOVE_RADIUS * 0.6;
          const nx = Math.max(
            30,
            Math.min(canvas.width - 30, p.x + Math.cos(angle) * r)
          );
          const ny = Math.max(
            30,
            Math.min(canvas.height - 30, p.y + Math.sin(angle) * r)
          );
          setMoveTween(
            p,
            nx,
            ny,
            Math.random() * (IDLE_MAX_DUR - IDLE_MIN_DUR) + IDLE_MIN_DUR
          );
          p.idleTimer =
            Math.random() * (IDLE_MAX_DUR - IDLE_MIN_DUR) + IDLE_MIN_DUR;
        }
      }
    }
  });

  // pending steal approaches
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

  // ball flight
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

// proactively prepare players for the upcoming instruction so the scene morphs
function prepareForNextInstruction() {
  if (!instructions || instrIndex >= instructions.length) return;
  const ev = instructions[instrIndex];
  if (!ev || ev.triggerAt === undefined) return;
  const timeToEvent = game.timeLeft - ev.triggerAt;
  if (timeToEvent > 0 && timeToEvent <= APPROACH_THRESHOLD) {
    // only run once per event — mark a flag
    if (ev._prepared) return;
    ev._prepared = true;

    // For a shot: move shooter toward shooting spot and spread teammates into simple offensive positions
    if (ev.type === "shot" && ev.shooter) {
      const shooter = findPlayer(ev.shooter.team, ev.shooter.name);
      if (shooter) {
        // move shooter closer to basket a bit
        const basketX = getOpponentBasketX(shooter.team);
        const basketY = getBasketY();
        // choose a shot spot roughly between current position and basket
        const tx = shooter.x + (basketX - shooter.x) * 0.55;
        const ty = shooter.y + (basketY - shooter.y) * 0.2;
        setMoveTween(
          shooter,
          tx,
          ty,
          Math.min(1.0, Math.max(0.4, timeToEvent * 0.9))
        );
      }
      // nudge teammates to offensive spacing
      const teamPlayers = game.players.filter(
        (p) => p.team === ev.shooter.team && p.name !== ev.shooter.name
      );
      teamPlayers.forEach((p, idx) => {
        const side = idx % 2 ? 1 : -1;
        const tx = Math.max(80, Math.min(canvas.width - 80, p.x + side * 60));
        const ty = Math.max(
          60,
          Math.min(canvas.height - 60, canvas.height / 2 + (idx - 2) * 36)
        );
        setMoveTween(
          p,
          tx,
          ty,
          Math.min(1.2, Math.max(0.5, timeToEvent * 0.8))
        );
      });
    }

    // For inbound: move handler to inbound catch location and opponent defenders to contest area
    if (ev.type === "inbound" && ev.to) {
      const handler = findPlayer(ev.to.team, ev.to.name);
      if (handler) {
        // place handler near sideline inbound spot (simple heuristic)
        const inboundX =
          handler.team === "home" ? canvas.width * 0.15 : canvas.width * 0.85;
        const inboundY = canvas.height / 2;
        setMoveTween(
          handler,
          inboundX,
          inboundY,
          Math.min(1.0, Math.max(0.4, timeToEvent))
        );
      }
      // defenders move toward handler
      const defenderTeam = ev.to.team === "home" ? "away" : "home";
      game.players
        .filter((p) => p.team === defenderTeam)
        .forEach((d, idx) => {
          setMoveTween(
            d,
            Math.max(40, Math.min(canvas.width - 40, (idx + 1) * 90)),
            canvas.height / 2 + (idx - 2) * 30,
            Math.min(1.0, timeToEvent)
          );
        });
    }

    // For rebound events: move likely rebounders toward rim
    if (ev.type === "rebound") {
      const candidates = game.players.filter((p) => p.team === ev.team);
      candidates.forEach((p, idx) => {
        const rimX = ev.team === "home" ? canvas.width - 60 : 60;
        const rimY = canvas.height / 2 + (idx - 2) * 18;
        setMoveTween(
          p,
          rimX + (Math.random() - 0.5) * 40,
          rimY,
          Math.min(1.0, Math.max(0.4, timeToEvent))
        );
      });
    }

    // For timeout/inbound/outOfBounds: nudge the awarded handler into position (if given)
    if (ev.type === "outOfBounds" && ev.awardedTo) {
      const handler = findPlayer(ev.awardedTo.team, ev.awardedTo.name);
      if (handler)
        setMoveTween(
          handler,
          Math.max(80, Math.min(canvas.width - 80, handler.x)),
          handler.y - 20,
          Math.min(1.0, Math.max(0.3, timeToEvent))
        );
    }

    // For steals: nudge the thief towards the from player
    if (ev.type === "steal" && ev.to && ev.from) {
      const thief = findPlayer(ev.to.team, ev.to.name);
      const from = findPlayer(ev.from.team, ev.from.name);
      if (thief && from)
        setMoveTween(
          thief,
          from.x,
          from.y,
          Math.min(0.9, Math.max(0.3, timeToEvent))
        );
    }

    // for subs, just move the incoming player to the out player's spot
    if (ev.type === "sub" && ev.team && ev.in && ev.out) {
      const outP = game.players.find(
        (p) => p.team === ev.team && p.name === ev.out
      );
      const inRoster =
        teams.find((t) => t.id === game[ev.team].id) ||
        teams.find((t) => t.name === game[ev.team].name);
      // we will place incoming at out player's spot when sub occurs; we can nudge roster bench area
      const benchX = ev.team === game.home.id ? 40 : canvas.width - 40;
      const benchY = canvas.height - 80;
      const inP = findPlayer(ev.team, ev.in);
      if (inP)
        setMoveTween(
          inP,
          benchX + (Math.random() - 0.5) * 20,
          benchY + (Math.random() - 0.5) * 18,
          Math.min(1.0, timeToEvent)
        );
    }
  }
}

// SIMPLE simulate fallback kept (not used for instruction mode)
function stepGame(dt) {
  game.timeLeft -= dt;
  // we don't use heavy AI here
}

// ---------------- Instruction interpreter ----------------
// NOTE: removed automatic pass insertion from preprocessing; assists no longer create passes automatically

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
  if (ev.type === "shot") return 600;
  if (ev.type === "inbound") return 600;
  return parseInt(instrDelayEl.value || 800, 10);
}

function dispatchTimedInstructions() {
  if (!instructions || instrIndex >= instructions.length) return;
  while (instrIndex < instructions.length) {
    const ev = instructions[instrIndex];
    if (ev.triggerAt === undefined) {
      // immediate (no clock) events: apply now
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
    } else game.ball.state = "ground";
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
      if (pending.andOne) {
        performFreeThrow(
          shooter,
          pending.ftMade !== undefined ? !!pending.ftMade : true
        );
        return;
      } else setInboundAfterScore();
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
        } else game.ball.state = "ground";
      } else game.ball.state = "ground";
    }
  } else if (pending.type === "freethrow") {
    const shooter = pending.shooter;
    if (pending.made) {
      if (shooter.team === "home") game.homeScore += 1;
      else game.awayScore += 1;
      document.getElementById("homeScore").textContent = game.homeScore;
      document.getElementById("awayScore").textContent = game.awayScore;
      log(`${shooter.name} made a free throw`);
    } else log(`${shooter.name} missed a free throw`);
    if (pending.next) {
      performFreeThrow(pending.shooter, pending.next.made, pending.next);
    } else {
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

function performFreeThrow(shooter, made = true, opts = {}) {
  if (!shooter) return;
  const ftX = shooter.team === "home" ? canvas.width - 120 : 120;
  const ftY = canvas.height / 2;
  setMoveTween(shooter, ftX, ftY, 0.6);
  const targetX = getOpponentBasketX(shooter.team);
  const targetY = getBasketY();
  const travel = 0.8;
  game.ball.state = "flying";
  game.ball.flightType = "freethrow";
  game.ball.vx = (targetX - shooter.x) / travel;
  game.ball.vy = (targetY - shooter.y) / travel;
  game.ball.ttl = travel;
  game.ball.pendingArrival = {
    type: "freethrow",
    shooter,
    made: !!made,
    next: opts.next,
    rebound: opts.rebound,
  };
  game.ball.holder = null;
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

// instruction application (no auto-pass generation)
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
        const travel = ev.duration || 0.6;
        game.ball.state = "flying";
        game.ball.flightType = "inbound";
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
      if (p && ev.x !== undefined && ev.y !== undefined) {
        if (ev.duration && !ev.instant)
          setMoveTween(p, ev.x, ev.y, ev.duration);
        else {
          p.tx = ev.x;
          p.ty = ev.y;
          if (ev.instant) {
            p.x = p.tx;
            p.y = p.ty;
            p.move = null;
          } else setMoveTween(p, ev.x, ev.y, ev.duration || 0.45);
        }
      }
      break;
    }

    case "pass": {
      // keep pass handling (visual pass) only if event explicitly contains a pass
      const pFrom = findPlayer(ev.from.team, ev.from.name);
      const pTo = findPlayer(ev.to.team, ev.to.name);
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
      const shooter = findPlayer(ev.shooter.team, ev.shooter.name);
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
        if (ev.shooter && ev.shooter.tx !== undefined && ev.duration)
          setMoveTween(
            shooter,
            ev.shooter.tx,
            ev.shooter.ty || shooter.ty,
            Math.min(ev.duration, 0.6)
          );
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
          andOne: !!ev.andOne,
        };
      }
      break;
    }

    case "freethrow": {
      const shooter = findPlayer(ev.shooter.team, ev.shooter.name);
      if (shooter)
        performFreeThrow(shooter, !!ev.made, {
          next: ev.next,
          rebound: ev.rebound,
        });
      break;
    }

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

    case "sub": {
      const outName = ev.out,
        inName = ev.in;
      const outIdx = game.players.findIndex(
        (p) => p.team === ev.team && p.name === outName
      );
      if (outIdx >= 0) {
        const teamObj =
          teams.find((t) => t.id === game[ev.team].id) ||
          teams.find((t) => t.name === game[ev.team].name);
        let inRating = 60;
        if (teamObj && Array.isArray(teamObj.roster)) {
          const found = teamObj.roster.find((r) => r.name === inName);
          if (found) inRating = found.rating || inRating;
        }
        const outP = game.players[outIdx];
        const newP = {
          team: outP.team,
          name: inName,
          rating: inRating,
          x: outP.x,
          y: outP.y,
          tx: outP.x,
          ty: outP.y,
          move: null,
          idleTimer: Math.random() * 1.5 + 0.2,
        };
        game.players[outIdx] = newP;
        log(`Substitution: ${outName} out, ${inName} in (${ev.team})`);
      }
      break;
    }

    case "outOfBounds": {
      if (ev.x !== undefined && ev.y !== undefined) {
        game.ball.x = ev.x;
        game.ball.y = ev.y;
      }
      game.ball.state = "ground";
      game.ball.holder = null;
      game.ball.vx = 0;
      game.ball.vy = 0;
      if (ev.awardedTo) {
        const handler = findPlayer(ev.awardedTo.team, ev.awardedTo.name);
        if (handler) {
          setTimeout(() => {
            applyInstruction(
              {
                type: "inbound",
                to: { team: handler.team, name: handler.name },
                duration: 0.6,
              },
              {}
            );
          }, 120);
        }
      }
      log("Ball out of bounds");
      break;
    }

    case "timeout": {
      const team = ev.team;
      const handler = ev.handlerName
        ? findPlayer(team, ev.handlerName)
        : game.players.find((p) => p.team === team);
      if (handler) {
        const oppHalfX =
          handler.team === "home" ? canvas.width * 0.65 : canvas.width * 0.35;
        game.players
          .filter((p) => p.team === team)
          .forEach((p, idx) => {
            const offsetY = (idx - 2) * 40;
            setMoveTween(
              p,
              oppHalfX + (idx % 2 ? 30 : -30),
              canvas.height / 2 + offsetY,
              0.8
            );
          });
        setTimeout(() => {
          handler.x = oppHalfX + 10;
          handler.y = canvas.height / 2;
          handler.tx = handler.x;
          handler.ty = handler.y;
          game.ball.state = "held";
          game.ball.holder = handler;
          game.offense = team;
        }, 850);
      }
      log(`Timeout (${team})`);
      break;
    }

    case "offensiveFoul":
      log("Offensive foul ignored (instruction)");
      break;

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
  ctx.fillRect(10, 10, 360, 52);
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

// ----------------- Preprocessing / scheduling helpers -----------------

// preprocess: parse clock -> triggerAt, remove auto-pass insertion, insert small move fillers only
function preprocessInstructions(orig) {
  const list = orig.map((e) => ({ ...e }));
  list.forEach((ev) => {
    if (ev.clock !== undefined && ev.clock !== null)
      ev.triggerAt = parseClock(ev.clock);
  });

  // sort descending (clock counts down)
  list.sort((a, b) => {
    const A = a.triggerAt !== undefined ? a.triggerAt : -99999;
    const B = b.triggerAt !== undefined ? b.triggerAt : -99999;
    return B - A;
  });

  // We will NOT auto-insert passes. We'll only insert small move fillers (no passes)
  const filled = [];
  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    filled.push(ev);
    const next = list[i + 1];
    if (!next || ev.triggerAt === undefined || next.triggerAt === undefined)
      continue;
    const gap = ev.triggerAt - next.triggerAt;
    if (gap > 0.9) {
      // create move for next primary actor to make the animation morph
      let actor = null;
      if (next.type === "shot" && next.shooter) actor = next.shooter;
      else if (next.type === "inbound" && next.to) actor = next.to;
      else if (next.type === "rebound" && next.name)
        actor = { team: next.team, name: next.name };
      if (actor) {
        filled.push({
          type: "move",
          team: actor.team,
          name: actor.name,
          duration: Math.min(1.0, gap * 0.45),
          generated: true,
          triggerAt: next.triggerAt + gap * 0.5,
        });
      }
      // If long gap after rebound (>24s) and next is shot by same team, insert sideline inbound
      if (
        ev.type === "rebound" &&
        next.type === "shot" &&
        ev.team === next.shooter.team &&
        gap > 24
      ) {
        const inboundTime = Math.min(ev.triggerAt - 0.1, next.triggerAt + 0.4);
        filled.push({
          type: "inbound",
          to: { team: next.shooter.team, name: next.shooter.name },
          duration: 0.6,
          generated: true,
          reason: "sideline",
          triggerAt: inboundTime,
        });
      }
    }
  }

  // handle shot.andOne by injecting freethrow (unchanged)
  const finalList = [];
  for (let i = 0; i < filled.length; i++) {
    const ev = filled[i];
    finalList.push(ev);
    if (ev.type === "shot" && ev.andOne) {
      finalList.push({
        type: "freethrow",
        shooter: ev.shooter,
        made: ev.ftMade !== undefined ? ev.ftMade : true,
        generated: true,
        triggerAt: ev.triggerAt !== undefined ? ev.triggerAt - 0.2 : undefined,
      });
    }
  }

  finalList.sort((a, b) => {
    const A = a.triggerAt !== undefined ? a.triggerAt : -99999;
    const B = b.triggerAt !== undefined ? b.triggerAt : -99999;
    return B - A;
  });

  return finalList;
}

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
