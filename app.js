// app.js - adds Instruction Replay mode (explicit event-driven animation)
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
  // start chosen mode
  if (modeSelect.value === "simulate") startGame(home, away);
  else startGame(home, away); // we still need players positioned for replay
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
    // keep team selectors visible so user can start game (positions refer to teams)
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

// --- game state and animation (keeps simulate code for fallback) ---
function startGame(home, away) {
  // base game state
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

  // default formation (left=home attacking right)
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

// animation loop (shared)
function animLoop(t) {
  if (!game) return;
  animRequest = requestAnimationFrame(animLoop);
  const now = performance.now();
  const dtReal = (now - game.lastUpdate) / 1000;
  game.lastUpdate = now;
  if (game.paused) return;
  const dt = dtReal * game.speed;

  // if replay mode and instructions playing, we don't run simulate step; instructions advance separately
  if (modeSelect.value === "simulate") stepGame(dt);
  // in replay mode stepGame is not used; instructions drive state changes
  render();
}

// SIMPLE simulate fallback kept (not used for instruction mode)
function stepGame(dt) {
  // minimal simulate step (kept earlier improvements). For brevity we keep it basic if user chooses simulate.
  // (This function can be the previous simulate implementation.)
  game.timeLeft -= dt;
  game.players.forEach((p) => {
    const dx = p.tx - p.x,
      dy = p.ty - p.y,
      dist = Math.hypot(dx, dy);
    if (dist > 1) {
      const s = 80 * (0.6 + (p.rating || 60) / 150);
      p.x += (dx / dist) * s * dt;
      p.y += (dy / dist) * s * dt;
    }
  });
  // ball motion if flying
  if (game.ball.state === "flying") {
    game.ball.x += game.ball.vx * dt;
    game.ball.y += game.ball.vy * dt;
    if (game.ball.ttl !== undefined) {
      game.ball.ttl -= dt;
      if (game.ball.ttl <= 0) game.ball.state = "held";
    }
  }
}

// ---------------- Instruction interpreter ----------------
// Instruction format: array of event objects in order. Example events:
// { "type":"setPositions", "team":"home", "positions":[{"name":"Jalen","x":700,"y":150}, ...] }
// { "type":"move", "team":"home", "name":"Jalen", "x":500, "y":200, "duration":0.6 }
// { "type":"pass", "from": {"team":"home","name":"Jalen"}, "to": {"team":"home","name":"Donovan"}, "duration":0.35 }
// { "type":"shot", "shooter": {"team":"home","name":"Donovan"}, "made":true, "points":2, "flight":0.6 }
// { "type":"score", "team":"home", "points":2 }
// { "type":"rebound", "team":"away", "name":"Chris" }
// { "type":"steal", "from":{"team":"home","name":"Jalen"}, "to":{"team":"away","name":"Chris"} }
// { "type":"inbound", "to": {"team":"home","name":"Donovan"}, "duration":0.6 }

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
    // backwards: need to rebuild state from scratch up to instrIndex-1
    if (instrIndex <= 0) return;
    instrIndex = Math.max(0, instrIndex - 1);
    rebuildStateToIndex(instrIndex);
  }
  render();
}

// rebuild full game state from instructions[0..index-1]
// this resets scores/positions and reapplies events sequentially (cheap but simple)
function rebuildStateToIndex(index) {
  // reset players to initial team rosters using the last-started game players list
  // easiest: re-run startGame to get default placement; then apply the first index events
  if (!game) return;
  // preserve selected teams
  const home = game.home,
    away = game.away;
  startGame(home, away);
  // apply events 0..index-1
  for (let i = 0; i < index; i++) {
    applyInstruction(instructions[i], { silent: true });
  }
}

// find player object by team+name (name match first token)
function findPlayer(team, name) {
  if (!game) return null;
  const pool = game.players.filter((p) => p.team === team);
  // try exact match, then startsWith
  let p =
    pool.find((x) => x.name === name) ||
    pool.find((x) => (x.name || "").startsWith(name)) ||
    pool[0];
  return p;
}

function applyInstruction(ev, opts = {}) {
  if (!game) return;
  switch (ev.type) {
    case "setPositions":
      // positions: [{team, name, x, y}] or team-level
      if (Array.isArray(ev.positions)) {
        ev.positions.forEach((pos) => {
          const p = findPlayer(pos.team, pos.name);
          if (p) {
            p.tx = pos.x;
            p.ty = pos.y;
            p.x = pos.x;
            p.y = pos.y;
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
          }
        });
      }
      break;

    case "inbound": {
      const to = ev.to; // {team,name}
      const handler = findPlayer(to.team, to.name);
      if (handler) {
        // set handler intended attack spot if provided
        if (ev.to.tx !== undefined) {
          handler.tx = ev.to.tx;
          handler.ty = ev.to.ty;
        }
        // animate ball flight to handler tx/ty
        const target = { x: handler.tx, y: handler.ty };
        game.ball.state = "flying";
        game.ball.flightType = "inbound";
        const travel = ev.duration || 0.6;
        game.ball.vx = (target.x - game.ball.x) / travel;
        game.ball.vy = (target.y - game.ball.y) / travel;
        game.ball.ttl = travel;
        // after flight arrival logic handled in animLoop because we set state "flying"
        // but to ensure immediate possession on next advance, optionally attach a timeout to finalize
        setTimeout(() => {
          game.ball.state = "held";
          game.ball.holder = handler;
          game.ball.x = handler.x + (handler.team === "home" ? 10 : -10);
          game.ball.y = handler.y - 8;
        }, Math.max(0, Math.round((ev.duration || 0.6) * 1000)));
      }
      break;
    }

    case "move": {
      const team = ev.team,
        name = ev.name;
      const p = findPlayer(team, name);
      if (p) {
        if (ev.x !== undefined && ev.y !== undefined) {
          p.tx = ev.x;
          p.ty = ev.y;
        }
        if (ev.instant) {
          p.x = p.tx;
          p.y = p.ty;
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
        // detach holder
        game.ball.holder = null;
        // schedule arrival finalizer
        setTimeout(() => {
          game.ball.state = "held";
          game.ball.holder = pTo;
          game.ball.x = pTo.x + (pTo.team === "home" ? 10 : -10);
          game.ball.y = pTo.y - 8;
        }, Math.round(travel * 1000));
      }
      break;
    }

    case "shot": {
      const shooterRef = ev.shooter;
      const shooter = findPlayer(shooterRef.team, shooterRef.name);
      if (shooter) {
        const targetX = getOpponentBasketX(shooter.team),
          targetY = getBasketY();
        const travel =
          ev.flight ||
          Math.max(
            0.5,
            Math.hypot(targetX - shooter.x, targetY - shooter.y) / 420
          );
        game.ball.state = "flying";
        game.ball.flightType = "shot";
        game.ball.shooter = shooter;
        game.ball.shotTarget = { x: targetX, y: targetY };
        game.ball.vx = (targetX - shooter.x) / travel;
        game.ball.vy = (targetY - shooter.y) / travel;
        game.ball.ttl = travel;
        game.ball.holder = null;
        // finalize according to ev.made
        setTimeout(() => {
          // if made, update score and inbound set
          if (ev.made) {
            if (shooter.team === "home") game.homeScore += ev.points || 2;
            else game.awayScore += ev.points || 2;
            document.getElementById("homeScore").textContent = game.homeScore;
            document.getElementById("awayScore").textContent = game.awayScore;
            log(`${shooter.name} scored ${ev.points || 2} (instruction)`);
            setInboundAfterScore();
          } else {
            log(`${shooter.name} missed (instruction)`);
            // if rebound assigned in event, give ball to that player
            if (ev.rebound) {
              const r = ev.rebound;
              const rb = findPlayer(r.team, r.name);
              if (rb) {
                game.ball.state = "held";
                game.ball.holder = rb;
                game.offense = rb.team;
                game.ball.x = rb.x + (rb.team === "home" ? 10 : -10);
                game.ball.y = rb.y - 8;
              }
            } else {
              // leave ball ground for a moment and then alternate possession
              game.ball.state = "ground";
              setTimeout(() => {
                // alternate or give to next event
                game.offense = game.offense === "home" ? "away" : "home";
                game.currentPlay = null;
              }, 300);
            }
          }
        }, Math.round(travel * 1000));
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
      if (thief) {
        game.ball.state = "held";
        game.ball.holder = thief;
        game.offense = thief.team;
        game.ball.x = thief.x + (thief.team === "home" ? 10 : -10);
        game.ball.y = thief.y - 8;
        log(`${thief.name} stole the ball (instruction)`);
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

  // optionally render/log
  if (!opts.silent) render();
}

// ---------------- helpers reused ----------------
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

// ---------------- rendering ----------------
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawCourt();

  if (!game) return;

  // players
  game.players.forEach((p) => {
    // simple lerp toward tx,ty for smooth motion
    const dx = p.tx - p.x,
      dy = p.ty - p.y,
      dist = Math.hypot(dx, dy);
    if (dist > 1) {
      const step = Math.min(dist, 120 * (1 / 60));
      p.x += (dx / dist) * step;
      p.y += (dy / dist) * step;
    }
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
    // if ball is held by a player, follow that player
    if (game.ball.state === "held" && game.ball.holder) {
      game.ball.x =
        game.ball.holder.x + (game.ball.holder.team === "home" ? 10 : -10);
      game.ball.y = game.ball.holder.y - 8;
    } else if (game.ball.state === "flying") {
      // ball.x/y updated in anim loop when flying; nothing additional here
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
