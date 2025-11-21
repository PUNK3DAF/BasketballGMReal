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
  if (!instructions || !instructions.length) {
    log("No instructions loaded.");
    return;
  }

  instrPlaying = true;

  // ensure teams exist: if instructions included a lineup, preprocess may have populated playersGlobal
  if (!teams || teams.length < 2) {
    // try to build teams from playersGlobal (which preprocess may have filled)
    const homeRoster = (playersGlobal || [])
      .filter((p) => p.team === "home")
      .map((p) => ({ name: p.name, rating: p.rating || 60 }));
    const awayRoster = (playersGlobal || [])
      .filter((p) => p.team === "away")
      .map((p) => ({ name: p.name, rating: p.rating || 60 }));
    if (homeRoster.length && awayRoster.length) {
      teams = [
        { id: "home", name: "Home", roster: homeRoster },
        { id: "away", name: "Away", roster: awayRoster },
      ];
      populateTeamSelectors();
      log("Built teams from instruction lineups.");
    }
  }

  // fallback: if still no teams, create minimal dummy teams so startGame can run
  if (!teams || teams.length < 2) {
    teams = [
      {
        id: "home",
        name: "Home",
        roster: [
          { name: "P1" },
          { name: "P2" },
          { name: "P3" },
          { name: "P4" },
          { name: "P5" },
        ],
      },
      {
        id: "away",
        name: "Away",
        roster: [
          { name: "Q1" },
          { name: "Q2" },
          { name: "Q3" },
          { name: "Q4" },
          { name: "Q5" },
        ],
      },
    ];
    populateTeamSelectors();
    log("Created fallback teams to start the replay.");
  }

  // start game if needed
  if (!game) {
    const home = teams[0],
      away = teams[1];
    if (home && away) {
      startGame(home, away);
      // immediately dispatch any events that should fire at the starting clock
      dispatchTimedInstructions();
    } else {
      log("Cannot start game: teams missing.");
      instrPlaying = false;
    }
  } else {
    // if already running, ensure dispatch gets called now
    dispatchTimedInstructions();
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
    repositionTimer: 0.6,
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
  // periodic team repositioning so players don't wait until the last second
  game.repositionTimer = (game.repositionTimer || 0) - dt;
  if (game.repositionTimer <= 0) {
    game.repositionTimer = 0.6; // call every ~0.6s
    setTeamAttackPositions(game.offense);
  }
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
          // more purposeful drifting (60% chance) across the half
          if (Math.random() < 0.6) {
            const mid = canvas.width / 2;
            const tgtX =
              p.team === "home"
                ? clamp(mid + 40 + Math.random() * 140, 40, canvas.width - 40)
                : clamp(mid - 40 - Math.random() * 140, 40, canvas.width - 40);
            const tgtY = clamp(
              canvas.height * 0.25 + Math.random() * canvas.height * 0.5,
              40,
              canvas.height - 40
            );
            const dur = Math.random() * 1.0 + 0.5;
            setMoveTween(p, tgtX, tgtY, dur);
          } else {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * IDLE_MOVE_RADIUS * 0.9;
            const nx = clamp(p.x + Math.cos(angle) * r, 40, canvas.width - 40);
            const ny = clamp(p.y + Math.sin(angle) * r, 40, canvas.height - 40);
            setMoveTween(
              p,
              nx,
              ny,
              Math.random() * (IDLE_MAX_DUR - IDLE_MIN_DUR) + IDLE_MIN_DUR
            );
          }
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
  if (!(timeToEvent > 0 && timeToEvent <= Math.max(APPROACH_THRESHOLD, 0.5)))
    return;

  // figure which team will be on offense for the upcoming event
  let offenseTeam = null;
  if (ev.type === "inbound") offenseTeam = ev.to && ev.to.team;
  else if (
    ev.type === "pass" ||
    ev.type === "shot" ||
    ev.type === "freethrow"
  ) {
    offenseTeam =
      (ev.from && ev.from.team) ||
      (ev.shooter && ev.shooter.team) ||
      (ev.to && ev.to.team);
  } else if (ev.type === "rebound") offenseTeam = ev.team;
  else if (ev.type === "steal") offenseTeam = ev.to && ev.to.team;
  else if (ev.type === "outOfBounds" && ev.awardedTo)
    offenseTeam = ev.awardedTo.team;

  const offsetAttack = 120;
  const guardOffset = 80;
  const centerY = canvas.height / 2;
  const offsets = [-120, -40, 40, 120, 0];

  // helper: own basket x
  const ownBasketX = (team) => (team === "home" ? 30 : canvas.width - 30);
  const oppBasketX = (team) => getOpponentBasketX(team);

  game.players.forEach((p, idx) => {
    // compute desired target
    const target = { x: p.tx, y: p.ty };
    if (offenseTeam && p.team === offenseTeam) {
      // offense: move toward opponent basket (attacking side) but not on top of rim
      const dirSign = p.team === "home" ? -1 : 1;
      target.x = oppBasketX(p.team) + dirSign * -offsetAttack;
      target.y = centerY + offsets[idx % offsets.length] + idx * 6;
    } else if (offenseTeam) {
      // defense: position near own basket to guard it (don't go to opponent half)
      target.x =
        ownBasketX(p.team) + (p.team === "home" ? guardOffset : -guardOffset);
      target.y = centerY + offsets[idx % offsets.length] + idx * -6;
    } else {
      // no clear offense: mild halfcourt setup
      target.x = canvas.width / 2 + (p.team === "home" ? -80 : 80);
      target.y = centerY + offsets[idx % offsets.length];
    }

    // Only set a new tween if not already moving toward roughly the same spot,
    // or if current move is nearly finished (prevents overwrite every frame).
    const targetDelta = Math.hypot(
      (p.tx || p.x) - target.x,
      (p.ty || p.y) - target.y
    );
    const needReset =
      !p.move || targetDelta > 18 || (p.move && p.move.tleft < 0.12);

    if (needReset) {
      // duration scaled by distance and available time; ensure sensible min/max
      const dx = target.x - p.x;
      const dy = target.y - p.y;
      const dist = Math.hypot(dx, dy);
      const maxDur = Math.max(0.35, timeToEvent * 0.9);
      const speed = PLAYER_BASE_SPEED * 1.8;
      const dur = Math.max(0.18, Math.min(maxDur, dist / speed));
      setMoveTween(p, target.x, target.y, dur);
    }
  });
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
  const margin = 40;
  tx = Math.max(margin, Math.min(canvas.width - margin, tx));
  ty = Math.max(margin, Math.min(canvas.height - margin, ty));
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
  // ensure team positions update immediately
  setTeamAttackPositions(game.offense);
  game.ball.x = thief.x + (thief.team === "home" ? 10 : -10);
  game.ball.y = thief.y - 8;
  log(`${thief.name} stole the ball (instruction)`);
  // reposition both teams proactively
  setTeamAttackPositions(game.offense);
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
      const pFrom = findPlayer(ev.from.team, ev.from.name);
      const pTo = findPlayer(ev.to.team, ev.to.name);
      if (pFrom && pTo) {
        // clamp receiver tx/ty to court
        const margin = 40;
        const rx = clamp(pTo.tx || pTo.x, margin, canvas.width - margin);
        const ry = clamp(pTo.ty || pTo.y, margin, canvas.height - margin);
        pTo.tx = rx;
        pTo.ty = ry;
        const travel =
          ev.duration ||
          Math.max(0.2, Math.hypot(pFrom.x - rx, pFrom.y - ry) / 420);
        game.ball.state = "flying";
        game.ball.flightType = "pass";
        game.ball.vx = (rx - pFrom.x) / travel;
        game.ball.vy = (ry - pFrom.y) / travel;
        game.ball.ttl = travel;
        game.ball.pendingArrival = { type: "pass", to: pTo };
        game.ball.holder = null;
      }
      break;
    }

    case "shot": {
      const shooter = findPlayer(ev.shooter.team, ev.shooter.name);
      if (shooter) {
        const midX = canvas.width / 2;
        const oppX = getOpponentBasketX(shooter.team);
        const isThree = ev.points === 3;
        const shootOffset = isThree ? 180 : 100;
        // ideal spot: between mid and near rim, clamped to court
        let shootX =
          shooter.team === "home"
            ? clamp(
                Math.max(midX + 50, oppX - shootOffset),
                40,
                canvas.width - 40
              )
            : clamp(
                Math.min(midX - 50, oppX + shootOffset),
                40,
                canvas.width - 40
              );
        const shootY = clamp(
          canvas.height / 2 + (Math.random() * 80 - 40),
          40,
          canvas.height - 40
        );

        const dx = shootX - shooter.x,
          dy = shootY - shooter.y,
          dist = Math.hypot(dx, dy);
        const timeToEvent = Math.max(
          0.18,
          (game.timeLeft - (ev.triggerAt || 0)) * 0.6 || 0.35
        );
        const moveDur = Math.min(
          Math.max(0.18, dist / (PLAYER_BASE_SPEED * 1.6)),
          Math.max(0.25, timeToEvent)
        );
        if (
          !shooter.move ||
          Math.hypot(shooter.tx - shootX, shooter.ty - shootY) > 12
        ) {
          setMoveTween(shooter, shootX, shootY, moveDur);
        }

        // start shot flight from clamped shooter pos (use shooter.x at moment)
        const travel = ev.travel || 0.7;
        const targetX = clamp(oppX, 40, canvas.width - 40);
        const targetY = getBasketY();
        game.ball.state = "flying";
        game.ball.flightType = "shot";
        game.ball.vx = (targetX - shooter.x) / travel;
        game.ball.vy = (targetY - shooter.y) / travel;
        game.ball.ttl = travel;
        game.ball.pendingArrival = {
          type: "shot",
          shooter,
          made: !!ev.made,
          points: ev.points,
          assist: ev.assist,
          andOne: !!ev.andOne,
        };
        game.ball.holder = null;
        log(
          `${shooter.name} shoots (${ev.points}) at ${ev.clock} - ${
            ev.made ? "made" : "missed"
          }`
        );
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
    // name: black, slightly above the circle
    ctx.fillStyle = "#000";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    const displayName = (p.name || "Player").split(" ")[0];
    ctx.fillText(displayName, p.x, p.y - 18);
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
  const hudW = 360;
  const hudX = Math.round((canvas.width - hudW) / 2);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(hudX, 10, hudW, 52);
  ctx.fillStyle = "#fff";
  ctx.font = "14px sans-serif";
  ctx.fillText(
    `${game.home.name} ${game.homeScore}  -  ${game.awayScore} ${game.away.name}`,
    hudX + 12,
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
    hudX + hudW - 160,
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
  // 3-point arcs (both ends)
  ctx.strokeStyle = "#999";
  ctx.lineWidth = 1.2;
  const threeR = THREE_PT_DIST;
  ctx.beginPath();
  ctx.arc(
    30,
    canvas.height / 2,
    threeR,
    -Math.PI / 2 + 0.25,
    Math.PI / 2 - 0.25
  );
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(
    canvas.width - 30,
    canvas.height / 2,
    threeR,
    Math.PI / 2 + 0.25,
    (3 * Math.PI) / 2 - 0.25
  );
  ctx.stroke();
}

drawCourt();

// ----------------- Preprocessing / scheduling helpers -----------------

// preprocess: parse clock -> triggerAt, auto-insert passes (when possession known),
// insert small move fillers only, and handle freethrow for and-ones.
function preprocessInstructions(orig) {
  // accept instructions that include a 'lineups' entry (home/away arrays)
  let list = orig.map((e) => ({ ...e }));
  // extract lineup instruction if present
  const lineupIndex = list.findIndex(
    (e) => e && (e.type === "lineups" || e.type === "lineup")
  );
  if (lineupIndex !== -1) {
    const lu = list.splice(lineupIndex, 1)[0];
    // build playersGlobal from provided lineups (flatten home+away arrays)
    playersGlobal = [];
    if (lu.home && Array.isArray(lu.home)) {
      lu.home.forEach((p) => playersGlobal.push({ ...p, team: "home" }));
    }
    if (lu.away && Array.isArray(lu.away)) {
      lu.away.forEach((p) => playersGlobal.push({ ...p, team: "away" }));
    }
    // populate minimal teams array so UI can start without league.json
    if (!teams.length) {
      teams = [
        {
          id: "home",
          name: "Home",
          roster: (lu.home || []).map((n) =>
            typeof n === "string" ? { name: n } : n
          ),
        },
        {
          id: "away",
          name: "Away",
          roster: (lu.away || []).map((n) =>
            typeof n === "string" ? { name: n } : n
          ),
        },
      ];
      populateTeamSelectors();
    }
  }

  // parse clocks into triggerAt
  list.forEach((ev) => {
    if (ev.clock !== undefined) ev.triggerAt = parseClock(ev.clock);
  });

  // sort descending (clock counts down)
  list.sort((a, b) => (b.triggerAt || 0) - (a.triggerAt || 0));

  // helper: choose teammate name from playersGlobal for a team
  function chooseTeammate(team, excludeName) {
    const pool = playersGlobal
      .filter((p) => p.team === team)
      .map((x) => x.name);
    if (!pool.length) return excludeName ? excludeName + "_alt" : "Player";
    let choices = pool.filter((n) => n !== excludeName);
    if (!choices.length) choices = pool;
    return choices[Math.floor(Math.random() * choices.length)];
  }

  const filled = [];
  let currentPossession = undefined;
  let currentHolder = undefined;

  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    filled.push(ev);

    // update possession/holder based on explicit events
    switch (ev.type) {
      case "inbound":
        currentPossession = ev.to && ev.to.team;
        currentHolder = ev.to && ev.to.name;
        break;
      case "pass":
        currentPossession = ev.from && ev.from.team;
        currentHolder = ev.to && ev.to.name;
        break;
      case "rebound":
        currentPossession = ev.team;
        currentHolder = ev.name;
        break;
      case "steal":
        currentPossession = ev.to && ev.to.team;
        currentHolder = ev.to && ev.to.name;
        break;
      case "outOfBounds":
        if (ev.awardedTo) {
          currentPossession = ev.awardedTo.team;
          currentHolder = ev.awardedTo.name;
        }
        break;
      case "shot":
        if (ev.made) {
          currentPossession = currentPossession === "home" ? "away" : "home";
          currentHolder = null;
        } else {
          currentHolder = null;
        }
        break;
      case "freethrow":
        if (ev.shooter) {
          currentPossession = ev.shooter.team;
          currentHolder = ev.shooter.name;
        }
        break;
      default:
        break;
    }

    // synthesize passes between this event and next if possession known
    const next = list[i + 1];
    if (!next || currentPossession === undefined) continue;
    if (ev.type === "pass" || ev.type === "steal" || ev.type === "inbound")
      continue;

    const tStart = ev.triggerAt || 0;
    const tEnd = next.triggerAt !== undefined ? next.triggerAt : 0;
    let gap = tStart - tEnd;
    if (gap <= 0.5) continue;

    const passInterval = 1.25; // tunable
    let t = tStart - passInterval;
    const syntheticPasses = [];
    let safety = 0;
    while (t > tEnd + 0.05 && safety++ < 12) {
      const fromName = currentHolder || chooseTeammate(currentPossession);
      const toName = chooseTeammate(currentPossession, fromName);
      const passEv = {
        type: "pass",
        from: { team: currentPossession, name: fromName },
        to: { team: currentPossession, name: toName },
        clock: formatClock(t),
        triggerAt: t,
        synthetic: true,
      };
      syntheticPasses.push(passEv);
      currentHolder = toName;
      t -= passInterval;
    }
    // insert synthetic passes immediately after current event (keep chronological)
    syntheticPasses.sort((a, b) => (b.triggerAt || 0) - (a.triggerAt || 0));
    filled.push(...syntheticPasses);
  }

  // handle shot.andOne by injecting freethrow events
  const finalList = [];
  for (let i = 0; i < filled.length; i++) {
    const ev = filled[i];
    finalList.push(ev);
    if (ev.type === "shot" && ev.andOne && ev.shooter) {
      const ft = {
        type: "freethrow",
        shooter: ev.shooter,
        made: !!ev.made,
        clock: ev.clock,
        triggerAt: ev.triggerAt,
        synthetic: true,
      };
      finalList.push(ft);
    }
  }

  finalList.sort((a, b) => (b.triggerAt || 0) - (a.triggerAt || 0));
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

// --- helpers: clamp + team positioning ---
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function setTeamAttackPositions(offenseTeam) {
  if (!game) return;
  const centerY = canvas.height / 2;
  const midX = canvas.width / 2;
  const offsets = [-110, -45, 45, 110, 0];
  const margin = 40;
  const attackOffset = 120;
  const guardOffset = 80;

  // build list of offensive players to follow
  const offensePlayers = game.players.filter(
    (p) => offenseTeam && p.team === offenseTeam
  );

  game.players.forEach((p, idx) => {
    let tx = p.tx,
      ty = p.ty;

    if (offenseTeam && p.team === offenseTeam) {
      // offense: approach attacking side but keep on screen and within attacking half
      const oppX = getOpponentBasketX(p.team);
      // place attackers between mid and near the rim (clamped)
      const desiredX =
        p.team === "home"
          ? Math.max(midX + 40, Math.min(oppX - 40, oppX - attackOffset))
          : Math.min(midX - 40, Math.max(oppX + 40, oppX + attackOffset));
      tx = clamp(desiredX, margin, canvas.width - margin);
      ty = clamp(
        centerY + offsets[idx % offsets.length] + idx * 4,
        margin,
        canvas.height - margin
      );
    } else if (offenseTeam) {
      // defense: shadow a likely attacker (nearest offensive player) but stay on own half
      let mark = null;
      if (offensePlayers.length) {
        // prefer same-index if available, otherwise nearest
        mark =
          offensePlayers[idx] ||
          offensePlayers.reduce((a, b) =>
            Math.hypot(a.x - p.x, a.y - p.y) < Math.hypot(b.x - p.x, b.y - p.y)
              ? a
              : b
          );
      }
      if (mark) {
        // position near that opponent with small offset
        const ox = mark.x + (Math.random() * 40 - 20);
        const oy = mark.y + (Math.random() * 30 - 15);
        // clamp to defender's own half
        if (p.team === "home") {
          tx = clamp(Math.min(ox, midX - 20), margin, midX - 20);
        } else {
          tx = clamp(Math.max(ox, midX + 20), midX + 20, canvas.width - margin);
        }
        ty = clamp(oy, margin, canvas.height - margin);
      } else {
        // fallback guard near own basket
        const ownX = p.team === "home" ? 60 : canvas.width - 60;
        tx = clamp(
          ownX + (p.team === "home" ? guardOffset : -guardOffset),
          margin,
          canvas.width - margin
        );
        ty = clamp(
          centerY + offsets[idx % offsets.length],
          margin,
          canvas.height - margin
        );
      }
    } else {
      // no offense known: mild halfcourt spread
      tx = clamp(
        canvas.width / 2 + (p.team === "home" ? -80 : 80),
        margin,
        canvas.width - margin
      );
      ty = clamp(
        centerY + offsets[idx % offsets.length],
        margin,
        canvas.height - margin
      );
    }

    // only retarget if meaningfully different to avoid jitter
    if (Math.hypot((p.tx || p.x) - tx, (p.ty || p.y) - ty) > 12 || !p.move) {
      const dx = tx - p.x,
        dy = ty - p.y,
        dist = Math.hypot(dx, dy);
      const travel = Math.max(
        0.25,
        Math.min(1.2, dist / (PLAYER_BASE_SPEED * 1.6))
      );
      setMoveTween(p, tx, ty, travel);
    }
  });
}
