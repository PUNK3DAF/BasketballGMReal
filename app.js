// BasketballGM 2D visualizer
// Drop a `league.json` file from Basketball GM and animate a simplified game.

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

function parseLeague(leagueJson) {
  teams = [];
  playersGlobal = leagueJson.players || [];
  // Common BasketballGM has `teams` array with .tid and .region/.name or .abbrev
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
    // fallback: only players, try grouping by tid values found
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
    Object.keys(byTid).forEach((tid) => {
      teams.push({ id: tid, name: "Team " + tid, roster: byTid[tid] });
    });
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

function startGame(home, away) {
  // reset
  game = {
    home,
    away,
    homeScore: 0,
    awayScore: 0,
    period: 1,
    timeLeft: 12 * 60, // quarter minutes -> seconds (12-min quarter)
    ball: { x: canvas.width / 2, y: canvas.height / 2, vx: 0, vy: 0 },
    players: [],
    offense: Math.random() < 0.5 ? "home" : "away",
    paused: false,
    speed: parseFloat(speedSlider.value) || 1,
    possessionTime: 24,
    lastUpdate: performance.now(),
    rngSeed: Math.random(),
  };

  // assign player sprites: pick 5 from roster or fill with placeholders
  function chooseFive(roster) {
    if (!roster || roster.length === 0) {
      // dummy five
      const res = [];
      for (let i = 0; i < 5; i++)
        res.push({ name: `P${i + 1}`, rating: 60, pos: "G" });
      return res;
    }
    const sorted = roster
      .slice()
      .sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const five = sorted.slice(0, Math.min(5, sorted.length));
    while (five.length < 5) {
      five.push({ name: "Sub", rating: 55, pos: "F" });
    }
    return five;
  }

  const homeFive = chooseFive(home.roster);
  const awayFive = chooseFive(away.roster);

  // place players on court with simple formations
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

  // push player objects
  homeFive.forEach((pl, i) => {
    game.players.push({
      team: "home",
      name: pl.name,
      rating: pl.rating || 60,
      x: positionsHome[i].x,
      y: positionsHome[i].y,
      tx: positionsHome[i].x,
      ty: positionsHome[i].y,
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
    });
  });

  // reset scoreboard UI
  document.getElementById("homeLabel").textContent = home.name;
  document.getElementById("awayLabel").textContent = away.name;
  document.getElementById("homeScore").textContent = "0";
  document.getElementById("awayScore").textContent = "0";
  log(
    `Starting: ${home.name} (home) vs ${away.name} (away). First possession: ${game.offense}`
  );

  // start animation
  if (animRequest) cancelAnimationFrame(animRequest);
  game.lastUpdate = performance.now();
  animLoop();
}

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

function stepGame(dt) {
  // advance shot clock and game clock
  game.possessionTime -= dt;
  game.timeLeft -= dt;
  if (game.timeLeft <= 0) {
    // quarter end
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

  // simple possession logic: every time possessionTime <= 0, attempt shot
  if (!game.currentPlay) {
    // pick ball handler
    const offensePlayers = game.players.filter((p) => p.team === game.offense);
    const handler = weightedChoice(offensePlayers, (p) => p.rating + 1);
    // set ball target towards defending basket (left/right)
    const shotTarget =
      game.offense === "home"
        ? { x: canvas.width - 30, y: canvas.height / 2 }
        : { x: 30, y: canvas.height / 2 };
    // move handler to shoot position
    handler.tx = shotTarget.x - (game.offense === "home" ? 30 : -30);
    handler.ty = canvas.height / 2;
    game.currentPlay = { handler, startTime: performance.now(), shotTarget };
    game.possessionTime = 24; // reset for this possession
  } else {
    // animate players towards tx,ty
    game.players.forEach((p) => {
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const dist = Math.hypot(dx, dy);
      const speed = 60; // pixels per second
      if (dist > 1) {
        const nx = dx / dist,
          ny = dy / dist;
        p.x += nx * speed * dt * (0.8 + p.rating / 100);
        p.y += ny * speed * dt * (0.8 + p.rating / 100);
      }
    });

    // move ball with handler
    const handler = game.currentPlay.handler;
    game.ball.x = handler.x + (handler.team === "home" ? 10 : -10);
    game.ball.y = handler.y - 8;

    // after short delay attempt shot
    const elapsed = (performance.now() - game.currentPlay.startTime) / 1000;
    if (elapsed > 0.6 || game.possessionTime < 1) {
      attemptShot(game.currentPlay);
      game.currentPlay = null;
      // swap possession
      game.offense = game.offense === "home" ? "away" : "home";
      game.possessionTime = 24;
    }
  }
}

function attemptShot(play) {
  const handler = play.handler;
  // base chance from rating and distance from basket
  const rating = handler.rating || 60;
  // distance relative to midcourt (closer => easier)
  const dx = play.shotTarget.x - handler.x;
  const dy = play.shotTarget.y - handler.y;
  const dist = Math.hypot(dx, dy);
  const distFactor = Math.max(0.2, 1 - dist / 400); // closer => higher
  const baseProb = 0.35 + (rating - 60) / 200; // range approx [0.2,0.6]
  const makeProb = Math.min(
    0.95,
    Math.max(0.05, baseProb * distFactor + (Math.random() - 0.5) * 0.1)
  );
  const made = Math.random() < makeProb;
  const points = Math.random() < 0.15 ? 3 : 2; // occasional 3s
  if (made) {
    if (handler.team === "home") game.homeScore += points;
    else game.awayScore += points;
    document.getElementById("homeScore").textContent = game.homeScore;
    document.getElementById("awayScore").textContent = game.awayScore;
    log(
      `${handler.name} (${handler.team}) scored ${points} pts — ${game.homeScore}-${game.awayScore}`
    );
  } else {
    log(`${handler.name} (${handler.team}) missed`);
  }
  // brief rebound event: assign ball to random rebounder on defense or offense
  const rebounders = game.players.filter((p) => p.team !== handler.team);
  const reacquirer = weightedChoice(rebounders, (p) => p.rating + 10) || null;
  if (reacquirer) {
    // place reacquirer with ball for next possession
    reacquirer.tx = canvas.width / 2;
    reacquirer.ty = canvas.height / 2;
    // set next offense possibly to reacquirer
    // if made, possession switches to opponent after inbound. We simply alternate already.
  }
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

function render() {
  // clear
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // draw court background lines
  drawCourt();

  if (!game) return;

  // draw players
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

  // draw ball if available
  if (game.ball) {
    ctx.beginPath();
    ctx.fillStyle = "#e09b2c";
    ctx.arc(game.ball.x, game.ball.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6b3a12";
    ctx.stroke();
  }

  // HUD
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(10, 10, 220, 42);
  ctx.fillStyle = "#fff";
  ctx.font = "14px sans-serif";
  ctx.fillText(
    `${game.home.name} ${game.homeScore}  -  ${game.awayScore} ${game.away.name}`,
    20,
    32
  );

  // shot clock & time
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
    canvas.width - 220,
    30
  );
}

function drawCourt() {
  // floor
  ctx.fillStyle = "#f0e6c8";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // center line
  ctx.strokeStyle = "#b17b3a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 0);
  ctx.lineTo(canvas.width / 2, canvas.height);
  ctx.stroke();
  // hoops
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(30, canvas.height / 2, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(canvas.width - 30, canvas.height / 2, 6, 0, Math.PI * 2);
  ctx.fill();
  // three-point arcs (simple)
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
  // center circle
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, 50, 0, Math.PI * 2);
  ctx.stroke();
}

window.addEventListener("resize", () => {
  // optional: keep canvas fixed size for now
});

// initial draw
drawCourt();
