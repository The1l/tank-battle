"use strict";

/* ============================================================
 * 坦克大战 · Tank Battle
 * 经典红白机《Battle City》风格的网页复刻
 * 纯 HTML5 Canvas 实现，无需任何依赖
 * ============================================================ */

// ---------- 常量 ----------
const TILE = 40;            // 单个格子像素
const COLS = 13;            // 场地列数
const ROWS = 13;            // 场地行数
const W = COLS * TILE;      // 画布宽
const H = ROWS * TILE;      // 画布高
const TANK = TILE - 4;      // 坦克边长（略小于格子，便于移动）
const BULLET = 8;           // 子弹边长
const PUPSIZE = 26;         // 道具边长

// 地形类型
const EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, GRASS = 4, BASE = 5;

// 方向（与旋转角度对应）
const UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3;
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

// 出生点（顶部左/中/右）
const SPAWNS = [{ c: 0, r: 0 }, { c: 6, r: 0 }, { c: 12, r: 0 }];

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const scoreEl = document.getElementById("score");
const hiscoreEl = document.getElementById("hiscore");
const stageEl = document.getElementById("stage");
const livesEl = document.getElementById("lives");
const enemiesEl = document.getElementById("enemies");

// ---------- 关卡地图（13×13，字符含义见 buildLevel） ----------
const LEVELS = [
  [
    ".............",
    ".BB.......BB.",
    ".BB.......BB.",
    ".............",
    "...BBBBBBB...",
    "..B...B...B..",
    "..B...B...B..",
    "..BBBB.BBBB..",
    ".WW.......WW.",
    ".WW.......WW.",
    ".....BBBB....",
    ".....BEEB....",
    ".....BEEB....",
  ],
  [
    ".............",
    ".SS.......SS.",
    ".SS.......SS.",
    "..GGGGGGGGG..",
    "..BBBBBBBBB..",
    ".BB..BB..BB..",
    ".BB..BB..BB..",
    "..SSSSSSSSS..",
    "WW.........WW",
    "WW.........WW",
    ".....BBBB....",
    ".....BEEB....",
    ".....BEEB....",
  ],
  [
    ".............",
    ".BB..BBB..BB.",
    ".BB..BBB..BB.",
    ".GGG.....GGG.",
    "..S..B.B..S..",
    ".BB..B.B..BB.",
    ".BB..B.B..BB.",
    "..S..BBB..S..",
    ".WW..SSS..WW.",
    ".WW..SSS..WW.",
    ".....BBBB....",
    ".....BEEB....",
    ".....BEEB....",
  ],
];

// ---------- 音频（WebAudio，无需外部文件） ----------
const audio = {
  ctx: null,
  enabled: true,

  ensure() {
    if (!this.ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      } catch (e) { /* 忽略 */ }
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  },

  beep(freq, dur, type = "square", vol = 0.12) {
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur);
  },

  shoot() { this.beep(880, 0.08, "square", 0.06); },
  explode() { this.beep(160, 0.18, "sawtooth", 0.15); },
  bigExplode() { this.beep(90, 0.4, "sawtooth", 0.2); },
  hitSteel() { this.beep(1400, 0.05, "triangle", 0.06); },
  pickup() { this.beep(660, 0.12, "sine", 0.14); this.beep(990, 0.15, "sine", 0.14); },
  toggle() { this.enabled = !this.enabled; },
};

// ---------- 游戏状态 ----------
let mode = "title";           // title | play | gameover | clear
let paused = false;
let level = 0;
let score = 0;
let lives = 3;
let hiScore = 0;

let tiles = [];               // ROWS × COLS 地形数组
let baseTiles = [];           // 老鹰基地占用的格子
let baseDestroyed = false;

let player = null;
let bullets = [];
let enemies = [];
let powerups = [];
let particles = [];

let enemiesTotal = 0;         // 本关敌人总数
let enemiesSpawned = 0;       // 已生成数量
let spawnTimer = 1;           // 生成间隔倒计时
let spawnIndex = 0;           // 轮换出生点

let fortify = null;           // 铁铲加固：{ tiles: [{r,c}], timer }

let time = 0;                 // 全局时间（用于动画）
let clearTimer = 0;           // 过关 / 结束后的延迟
let titleBlink = 0;

try { hiScore = parseInt(localStorage.getItem("tankBattleHiScore"), 10) || 0; } catch (e) { hiScore = 0; }

// ---------- 工具函数 ----------
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function rectsOverlap(x1, y1, w1, h1, x2, y2, w2, h2) {
  return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
}
function isSolidTile(t) { return t === BRICK || t === STEEL || t === WATER || t === BASE; }

function rectHitsSolid(x, y, w, h) {
  const c0 = Math.floor(x / TILE), c1 = Math.floor((x + w - 1) / TILE);
  const r0 = Math.floor(y / TILE), r1 = Math.floor((y + h - 1) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
      if (isSolidTile(tiles[r][c])) return true;
    }
  }
  return false;
}

function tileToPixel(c, r) {
  return { x: c * TILE + (TILE - TANK) / 2, y: r * TILE + (TILE - TANK) / 2 };
}

function allTanks() {
  const list = [];
  if (player && !player.dead) list.push(player);
  for (const e of enemies) if (!e.dead) list.push(e);
  return list;
}

// ---------- 关卡构建 ----------
function buildLevel(map) {
  tiles = [];
  baseTiles = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const ch = (map[r] && map[r][c]) || ".";
      let t = EMPTY;
      if (ch === "B") t = BRICK;
      else if (ch === "S") t = STEEL;
      else if (ch === "W") t = WATER;
      else if (ch === "G") t = GRASS;
      else if (ch === "E") { t = BASE; baseTiles.push({ r, c }); }
      row.push(t);
    }
    tiles.push(row);
  }
}

function enemiesCount(n) { return Math.min(12 + n * 2, 24); }

function makePlayer() {
  // 出生在老鹰左侧
  const bc = baseTiles.length ? Math.min(...baseTiles.map(b => b.c)) : 6;
  const p = tileToPixel(Math.max(0, bc - 2), ROWS - 1);
  player = {
    x: p.x, y: p.y, dir: UP, isPlayer: true,
    speed: 130, power: 0, invuln: 2, dead: false, shootCooldown: 0,
  };
}

function makeEnemy(type) {
  const p = tileToPixel(SPAWNS[spawnIndex].c, SPAWNS[spawnIndex].r);
  const base = 68 + level * 5;
  const speeds = { 0: base, 1: base * 1.45, 2: base * 1.1 };
  const scores = { 0: 100, 1: 200, 2: 300 };
  return {
    x: p.x, y: p.y, dir: DOWN, isPlayer: false, type,
    speed: speeds[type] || base, score: scores[type] || 100,
    dead: false, spawning: 1.1, dirTimer: 0, shootTimer: 1 + Math.random() * 2,
  };
}

function pickEnemyType() {
  const r = Math.random();
  if (level >= 2 && r < 0.25) return 2;      // 重装（红）
  if (level >= 1 && r < 0.5) return 1;       // 快速（绿）
  return 0;                                   // 普通（灰）
}

function spawnEnemy() {
  if (enemiesSpawned >= enemiesTotal) return;
  // 找一个空闲出生点
  for (let i = 0; i < SPAWNS.length; i++) {
    const idx = (spawnIndex + i) % SPAWNS.length;
    const p = tileToPixel(SPAWNS[idx].c, SPAWNS[idx].r);
    let free = !rectHitsSolid(p.x, p.y, TANK, TANK);
    if (free) {
      for (const t of allTanks()) {
        if (rectsOverlap(p.x, p.y, TANK, TANK, t.x, t.y, TANK, TANK)) { free = false; break; }
      }
    }
    if (free) {
      spawnIndex = idx;
      enemies.push(makeEnemy(pickEnemyType()));
      enemiesSpawned++;
      break;
    }
  }
}

// ---------- 移动与碰撞 ----------
function canMoveTo(t, nx, ny) {
  if (nx < 0 || ny < 0 || nx + TANK > W || ny + TANK > H) return false;
  if (rectHitsSolid(nx, ny, TANK, TANK)) return false;
  for (const o of allTanks()) {
    if (o === t || o.spawning > 0) continue;
    if (rectsOverlap(nx, ny, TANK, TANK, o.x, o.y, TANK, TANK)) return false;
  }
  return true;
}

// ---------- 射击 ----------
function playerBulletLimit() { return player.power >= 2 ? 2 : 1; }
function bulletSpeed(friendly) { return friendly ? (player.power >= 1 ? 470 : 330) : 220 + level * 8; }

function tryShoot(t, friendly) {
  if (t.shootCooldown > 0) return;
  const limit = friendly ? playerBulletLimit() : 1;
  let mine = 0;
  for (const b of bullets) if (b.owner === t) mine++;
  if (mine >= limit) return;

  const off = TANK / 2 + 2;
  bullets.push({
    x: t.x + TANK / 2 + DX[t.dir] * off - BULLET / 2,
    y: t.y + TANK / 2 + DY[t.dir] * off - BULLET / 2,
    dir: t.dir,
    speed: bulletSpeed(friendly),
    friendly,
    owner: t,
  });
  t.shootCooldown = friendly ? 0.32 : 0.5;
  audio.shoot();
}

// ---------- 爆炸 / 粒子 ----------
function spawnExplosion(x, y, size) {
  const n = Math.round((size > 1 ? 26 : 14) * size);
  const colors = ["#ffd24a", "#ff9a3a", "#ff5a2a", "#f5f5f5"];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (30 + Math.random() * 110) * size;
    particles.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0.45 + Math.random() * 0.35, max: 0.8,
      r: (2 + Math.random() * 3) * size,
      color: colors[(Math.random() * colors.length) | 0],
    });
  }
}

// ---------- 道具 ----------
const PUP_TYPES = ["star", "helmet", "life", "grenade", "shovel"];

function dropPowerup(e) {
  if (Math.random() > 0.22) return;
  const type = PUP_TYPES[(Math.random() * PUP_TYPES.length) | 0];
  powerups.push({ type, x: e.x + (TANK - PUPSIZE) / 2, y: e.y + (TANK - PUPSIZE) / 2, t: 0 });
}

function applyPowerup(p) {
  audio.pickup();
  switch (p.type) {
    case "star":
      player.power = Math.min(2, player.power + 1);
      break;
    case "helmet":
      player.invuln = Math.max(player.invuln, 10);
      break;
    case "life":
      lives = Math.min(6, lives + 1);
      break;
    case "grenade":
      for (const e of enemies) {
        if (e.dead) continue;
        e.dead = true;
        spawnExplosion(e.x + TANK / 2, e.y + TANK / 2, 1.2);
        score += e.score;
      }
      audio.bigExplode();
      break;
    case "shovel":
      fortifyBase();
      break;
  }
  updateHud();
}

function fortifyBase() {
  const set = new Set();
  for (const b of baseTiles) {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const r = b.r + dr, c = b.c + dc;
        if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
        if (tiles[r][c] === BRICK) {
          tiles[r][c] = STEEL;
          set.add(r + "," + c);
        }
      }
    }
  }
  fortify = { keys: set, timer: 12 };
}

function updateFortify(dt) {
  if (!fortify) return;
  fortify.timer -= dt;
  if (fortify.timer <= 0) {
    for (const k of fortify.keys) {
      const [r, c] = k.split(",").map(Number);
      if (tiles[r][c] === STEEL) tiles[r][c] = BRICK;
    }
    fortify = null;
  }
}

// ---------- 击杀 / 胜负 ----------
function hitPlayer() {
  if (player.invuln > 0) { audio.hitSteel(); return; }
  player.dead = true;
  spawnExplosion(player.x + TANK / 2, player.y + TANK / 2, 1.5);
  audio.bigExplode();
  lives--;
  updateHud();
  if (lives <= 0) {
    scheduleGameOver();
  } else {
    player.respawnTimer = 1.4;
  }
}

function hitEnemy(e) {
  e.dead = true;
  spawnExplosion(e.x + TANK / 2, e.y + TANK / 2, 1.2);
  audio.bigExplode();
  score += e.score;
  dropPowerup(e);
  updateHud();
}

function destroyBase() {
  if (baseDestroyed) return;
  baseDestroyed = true;
  for (const b of baseTiles) tiles[b.r][b.c] = EMPTY;
  const c0 = Math.min(...baseTiles.map(b => b.c));
  const r0 = Math.min(...baseTiles.map(b => b.r));
  spawnExplosion(c0 * TILE + TILE, r0 * TILE + TILE, 2);
  audio.bigExplode();
  scheduleGameOver();
}

function scheduleGameOver() { mode = "gameover"; clearTimer = 2; saveHiScore(); }

function checkLevelClear() {
  if (enemiesSpawned >= enemiesTotal && enemies.length === 0) {
    mode = "clear";
    clearTimer = 2.5;
    score += 500;
    saveHiScore();
    updateHud();
  }
}

function saveHiScore() {
  if (score > hiScore) {
    hiScore = score;
    try { localStorage.setItem("tankBattleHiScore", String(hiScore)); } catch (e) { /* 忽略 */ }
  }
}

// ---------- 更新逻辑 ----------
function update(dt) {
  time += dt;

  updateFortify(dt);
  updatePlayer(dt);
  updateEnemies(dt);

  for (const b of bullets) updateBullet(b, dt);
  bullets = bullets.filter(b => !b.dead);

  updatePowerups(dt);
  powerups = powerups.filter(p => !p.dead);

  updateParticles(dt);
  particles = particles.filter(p => p.life > 0);

  // 生成敌人
  spawnTimer -= dt;
  const activeCount = enemies.filter(e => !e.dead).length;
  if (spawnTimer <= 0 && enemiesSpawned < enemiesTotal && activeCount < 4) {
    spawnEnemy();
    spawnTimer = 1.4;
  }

  enemies = enemies.filter(e => !e.dead);

  if (mode === "play") checkLevelClear();
}

function updatePlayer(dt) {
  if (player.dead) {
    player.respawnTimer -= dt;
    if (player.respawnTimer <= 0) respawnPlayer();
    return;
  }
  player.shootCooldown = Math.max(0, player.shootCooldown - dt);
  player.invuln = Math.max(0, player.invuln - dt);

  let dir = -1;
  if (keys.up) dir = UP;
  else if (keys.down) dir = DOWN;
  else if (keys.left) dir = LEFT;
  else if (keys.right) dir = RIGHT;

  if (dir >= 0) {
    player.dir = dir;
    const nx = player.x + DX[dir] * player.speed * dt;
    const ny = player.y + DY[dir] * player.speed * dt;
    if (canMoveTo(player, nx, ny)) { player.x = nx; player.y = ny; }
  }
  if (keys.fire) tryShoot(player, true);
}

function respawnPlayer() {
  const bc = baseTiles.length ? Math.min(...baseTiles.map(b => b.c)) : 6;
  const p = tileToPixel(Math.max(0, bc - 2), ROWS - 1);
  player.x = p.x; player.y = p.y; player.dir = UP;
  player.dead = false; player.invuln = 2; player.shootCooldown = 0;
}

function updateEnemies(dt) {
  for (const e of enemies) {
    if (e.dead) continue;
    if (e.spawning > 0) { e.spawning -= dt; continue; }

    e.shootCooldown = Math.max(0, e.shootCooldown - dt);
    e.dirTimer -= dt;

    // 决定方向
    if (e.dirTimer <= 0) {
      e.dir = chooseEnemyDir(e);
      e.dirTimer = 0.5 + Math.random() * 1.4;
    }

    // 移动
    const nx = e.x + DX[e.dir] * e.speed * dt;
    const ny = e.y + DY[e.dir] * e.speed * dt;
    if (canMoveTo(e, nx, ny)) {
      e.x = nx; e.y = ny;
    } else {
      e.dirTimer = 0; // 被挡住，下一帧重新选方向
    }

    // 射击
    if (e.shootCooldown <= 0) {
      if (tryAimAtPlayer(e)) tryShoot(e, false);
      e.shootCooldown = 0.8 + Math.random() * 1.6;
    }
  }
}

function chooseEnemyDir(e) {
  const px = player && !player.dead ? player.x + TANK / 2 : null;
  const py = player && !player.dead ? player.y + TANK / 2 : null;
  const ex = e.x + TANK / 2, ey = e.y + TANK / 2;

  // 与玩家对齐时，倾向瞄准玩家
  if (px != null && Math.abs(ex - px) < TILE * 0.6 && Math.random() < 0.55) {
    return py < ey ? UP : DOWN;
  }
  if (py != null && Math.abs(ey - py) < TILE * 0.6 && Math.random() < 0.55) {
    return px < ex ? LEFT : RIGHT;
  }
  // 否则随机，略微偏向下（朝基地方向推进）
  const dirs = [UP, DOWN, LEFT, RIGHT];
  const weights = [0.18, 0.46, 0.18, 0.18];
  let r = Math.random(), sum = 0;
  for (let i = 0; i < dirs.length; i++) {
    sum += weights[i];
    if (r < sum) return dirs[i];
  }
  return DOWN;
}

function tryAimAtPlayer(e) {
  const ex = e.x + TANK / 2, ey = e.y + TANK / 2;
  const px = player.x + TANK / 2, py = player.y + TANK / 2;
  if (Math.abs(ex - px) < TILE * 0.6) { e.dir = py < ey ? UP : DOWN; return true; }
  if (Math.abs(ey - py) < TILE * 0.6) { e.dir = px < ex ? LEFT : RIGHT; return true; }
  return true;
}

function updateBullet(b, dt) {
  let rem = b.speed * dt;
  while (rem > 0) {
    const inc = Math.min(rem, 4);
    b.x += DX[b.dir] * inc;
    b.y += DY[b.dir] * inc;
    rem -= inc;

    if (b.x < -BULLET || b.y < -BULLET || b.x > W || b.y > H) { b.dead = true; return; }

    const hit = bulletTileHit(b);
    if (hit) { handleBulletTile(b, hit); return; }

    if (bulletTankHit(b)) return;
    if (bulletBulletHit(b)) return;
  }
}

function bulletTileHit(b) {
  const c = Math.floor((b.x + BULLET / 2) / TILE);
  const r = Math.floor((b.y + BULLET / 2) / TILE);
  if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return null;
  const t = tiles[r][c];
  if (t === BRICK || t === STEEL) return { r, c, t };
  if (t === BASE && !b.friendly) return { r, c, t }; // 玩家子弹不会打坏自己的基地
  return null;
}

function handleBulletTile(b, hit) {
  if (hit.t === BRICK) {
    tiles[hit.r][hit.c] = EMPTY;
    spawnExplosion(hit.c * TILE + TILE / 2, hit.r * TILE + TILE / 2, 0.6);
    audio.explode();
    b.dead = true;
  } else if (hit.t === STEEL) {
    spawnExplosion(b.x + BULLET / 2, b.y + BULLET / 2, 0.35);
    audio.hitSteel();
    b.dead = true;
  } else if (hit.t === BASE) {
    b.dead = true;
    destroyBase();
  }
}

function bulletTankHit(b) {
  const bx = b.x + BULLET / 2, by = b.y + BULLET / 2;
  for (const t of allTanks()) {
    if (t.spawning > 0) continue;
    const valid = b.friendly ? !t.isPlayer : t.isPlayer;
    if (!valid) continue;
    if (bx >= t.x && bx <= t.x + TANK && by >= t.y && by <= t.y + TANK) {
      b.dead = true;
      if (t.isPlayer) hitPlayer();
      else hitEnemy(t);
      return true;
    }
  }
  return false;
}

function bulletBulletHit(b) {
  for (const o of bullets) {
    if (o === b || o.dead || o.friendly === b.friendly) continue;
    if (rectsOverlap(b.x, b.y, BULLET, BULLET, o.x, o.y, BULLET, BULLET)) {
      b.dead = true; o.dead = true;
      spawnExplosion(b.x, b.y, 0.4);
      return true;
    }
  }
  return false;
}

function updatePowerups(dt) {
  for (const p of powerups) {
    p.t += dt;
    if (p.t > 14) { p.dead = true; continue; }
    if (!player.dead && rectsOverlap(player.x, player.y, TANK, TANK, p.x, p.y, PUPSIZE, PUPSIZE)) {
      p.dead = true;
      applyPowerup(p);
    }
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.9; p.vy *= 0.9;
    p.life -= dt;
  }
}

// ---------- 渲染 ----------
function draw() {
  ctx.clearRect(0, 0, W, H);
  drawTiles();
  drawBase();
  drawPowerups();
  drawTank(player);
  for (const e of enemies) drawTank(e);
  drawBullets();
  drawParticles();
  drawGrassOverlay();
  drawOverlay();
}

function drawTiles() {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const t = tiles[r][c];
      const x = c * TILE, y = r * TILE;
      if (t === BRICK) drawBrick(x, y);
      else if (t === STEEL) drawSteel(x, y);
      else if (t === WATER) drawWater(x, y);
    }
  }
}

function drawBrick(x, y) {
  ctx.fillStyle = "#c0552f";
  ctx.fillRect(x, y, TILE, TILE);
  ctx.strokeStyle = "#7a3417";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + TILE / 2); ctx.lineTo(x + TILE, y + TILE / 2);
  ctx.moveTo(x + TILE / 2, y); ctx.lineTo(x + TILE / 2, y + TILE / 2);
  ctx.moveTo(x + TILE / 4, y + TILE / 2); ctx.lineTo(x + TILE / 4, y + TILE);
  ctx.moveTo(x + TILE * 3 / 4, y + TILE / 2); ctx.lineTo(x + TILE * 3 / 4, y + TILE);
  ctx.stroke();
  ctx.strokeStyle = "rgba(0,0,0,0.15)";
  ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
}

function drawSteel(x, y) {
  ctx.fillStyle = "#a8a8a8";
  ctx.fillRect(x, y, TILE, TILE);
  ctx.fillStyle = "#d5d5d5";
  ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
  ctx.fillStyle = "#8a8a8a";
  ctx.fillRect(x + TILE / 2 - 1, y + 3, 2, TILE - 6);
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
}

function drawWater(x, y) {
  ctx.fillStyle = "#0b4fa0";
  ctx.fillRect(x, y, TILE, TILE);
  const ph = (time * 1.5) % 2;
  ctx.strokeStyle = "#3f87d6";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y + TILE * 0.32);
  ctx.lineTo(x + TILE / 2, y + TILE * 0.32);
  ctx.lineTo(x + TILE, y + TILE * (0.32 + 0.18));
  ctx.moveTo(x, y + TILE * 0.7);
  ctx.lineTo(x + TILE / 2, y + TILE * 0.7);
  ctx.lineTo(x + TILE, y + TILE * (0.7 + 0.18 * Math.sin(ph * Math.PI)));
  ctx.stroke();
}

function drawGrassOverlay() {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (tiles[r][c] === GRASS) {
        const x = c * TILE, y = r * TILE;
        ctx.fillStyle = "rgba(52, 140, 52, 0.55)";
        ctx.fillRect(x, y, TILE, TILE);
        ctx.fillStyle = "rgba(120, 190, 90, 0.5)";
        for (let i = 0; i < 5; i++) {
          const gx = x + (i * 8 + 3) % TILE;
          const gy = y + (i * 11 + 2) % TILE;
          ctx.fillRect(gx, gy, 3, 6);
        }
      }
    }
  }
}

function drawBase() {
  if (!baseTiles.length) return;
  const c0 = Math.min(...baseTiles.map(b => b.c));
  const c1 = Math.max(...baseTiles.map(b => b.c));
  const r0 = Math.min(...baseTiles.map(b => b.r));
  const r1 = Math.max(...baseTiles.map(b => b.r));
  const x = c0 * TILE, y = r0 * TILE;
  const w = (c1 - c0 + 1) * TILE, h = (r1 - r0 + 1) * TILE;
  const cx = x + w / 2, cy = y + h / 2;

  ctx.fillStyle = "#cfcfcf";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#666";
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  // 老鹰徽记
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = "#d22";
  ctx.strokeStyle = "#8a0f0f";
  ctx.lineWidth = 2;
  ctx.beginPath();                                   // 身体
  ctx.moveTo(0, -16);
  ctx.lineTo(12, 12);
  ctx.lineTo(-12, 12);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.beginPath();                                   // 左翼
  ctx.moveTo(-9, 0); ctx.lineTo(-26, 16); ctx.lineTo(-7, 9);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath();                                   // 右翼
  ctx.moveTo(9, 0); ctx.lineTo(26, 16); ctx.lineTo(7, 9);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath();                                   // 头
  ctx.arc(0, -18, 6, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

function tankColors(t) {
  if (t.isPlayer) return { body: "#e8b23a", track: "#8a6a1e", turret: "#f5c84c", barrel: "#6a5210", dark: "#8a6a1e" };
  if (t.type === 2) return { body: "#c06056", track: "#5f2f2a", turret: "#e07a72", barrel: "#3f1f1c", dark: "#5f2f2a" };
  if (t.type === 1) return { body: "#7fa86b", track: "#3a5230", turret: "#96c082", barrel: "#28381f", dark: "#3a5230" };
  return { body: "#9aa0a6", track: "#565b60", turret: "#c2c7cc", barrel: "#3a3f44", dark: "#565b60" };
}

function drawTank(t) {
  if (!t || t.dead) return;

  const s = TANK;
  const blink = t.spawning > 0 && Math.floor(t.spawning * 12) % 2 === 0;
  const inv = t.isPlayer && t.invuln > 0 && Math.floor(t.invuln * 8) % 2 === 0;
  if (blink) return;

  ctx.save();
  ctx.globalAlpha = inv ? 0.45 : 1;
  ctx.translate(t.x + s / 2, t.y + s / 2);
  ctx.rotate(t.dir * Math.PI / 2);
  const c = tankColors(t);

  // 履带
  ctx.fillStyle = c.track;
  ctx.fillRect(-s / 2, -s / 2, 6, s);
  ctx.fillRect(s / 2 - 6, -s / 2, 6, s);
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  for (let i = -s / 2 + 4; i < s / 2; i += 5) {
    ctx.beginPath(); ctx.moveTo(-s / 2, i); ctx.lineTo(-s / 2 + 6, i); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s / 2 - 6, i); ctx.lineTo(s / 2, i); ctx.stroke();
  }

  // 车身
  ctx.fillStyle = c.body;
  ctx.fillRect(-s / 2 + 6, -s / 2 + 6, s - 12, s - 12);
  ctx.strokeStyle = c.dark;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-s / 2 + 6, -s / 2 + 6, s - 12, s - 12);

  // 炮塔
  ctx.fillStyle = c.turret;
  ctx.beginPath();
  ctx.arc(0, 0, s * 0.26, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = c.dark;
  ctx.stroke();

  // 炮管
  ctx.fillStyle = c.barrel;
  ctx.fillRect(-2.5, -s / 2 - 4, 5, s / 2 + 4);

  ctx.restore();
}

function drawBullets() {
  for (const b of bullets) {
    if (b.dead) continue;
    ctx.save();
    ctx.translate(b.x + BULLET / 2, b.y + BULLET / 2);
    ctx.rotate(b.dir * Math.PI / 2);
    ctx.fillStyle = b.friendly ? "#f5d24a" : "#e8e8e8";
    ctx.fillRect(-2, -BULLET / 2, 4, BULLET);
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPowerups() {
  for (const p of powerups) {
    if (p.dead || p.t > 11 && Math.floor(p.t * 8) % 2 === 0) continue;
    const x = p.x, y = p.y;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x, y, PUPSIZE, PUPSIZE);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, PUPSIZE - 2, PUPSIZE - 2);
    drawPowerupIcon(p.type, x + PUPSIZE / 2, y + PUPSIZE / 2);
  }
}

function drawPowerupIcon(type, cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);
  const s = PUPSIZE / 2;
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 1.5;
  if (type === "star") {
    ctx.fillStyle = "#f5d24a";
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / 5;
      const a2 = a + Math.PI / 5;
      ctx.lineTo(Math.cos(a) * s * 0.8, Math.sin(a) * s * 0.8);
      ctx.lineTo(Math.cos(a2) * s * 0.35, Math.sin(a2) * s * 0.35);
    }
    ctx.closePath();
    ctx.fill();
  } else if (type === "helmet") {
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.7);
    ctx.quadraticCurveTo(s * 0.7, -s * 0.6, s * 0.4, s * 0.3);
    ctx.lineTo(s * 0.4, s * 0.6);
    ctx.lineTo(-s * 0.4, s * 0.6);
    ctx.lineTo(-s * 0.4, s * 0.3);
    ctx.quadraticCurveTo(-s * 0.7, -s * 0.6, 0, -s * 0.7);
    ctx.stroke();
  } else if (type === "life") {
    ctx.fillStyle = "#e8b23a";
    ctx.fillRect(-s * 0.7, -s * 0.5, s * 1.4, s);
    ctx.fillRect(-s * 0.25, -s * 0.9, s * 0.5, s * 1.8);
  } else if (type === "grenade") {
    ctx.fillStyle = "#7fa86b";
    ctx.beginPath();
    ctx.arc(0, s * 0.1, s * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.fillStyle = "#fff";
    ctx.fillRect(-s * 0.12, -s * 0.7, s * 0.24, s * 0.7);
  } else if (type === "shovel") {
    ctx.fillStyle = "#c9c9c9";
    ctx.beginPath();
    ctx.moveTo(0, s * 0.7); ctx.lineTo(s * 0.6, -s * 0.5); ctx.lineTo(-s * 0.6, -s * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.5); ctx.lineTo(0, -s * 0.9);
    ctx.stroke();
  }
  ctx.restore();
}

function drawOverlay() {
  if (mode === "title" || mode === "gameover" || mode === "clear" || paused) {
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, 0, W, H);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (mode === "title") {
    titleBlink += 0.03;
    ctx.fillStyle = "#f0c040";
    ctx.font = "bold 54px 'Microsoft YaHei', sans-serif";
    ctx.fillText("坦克大战", W / 2, H / 2 - 40);
    ctx.fillStyle = "#ccc";
    ctx.font = "16px 'Microsoft YaHei', sans-serif";
    ctx.fillText("TANK BATTLE", W / 2, H / 2 + 6);
    if (Math.floor(titleBlink) % 2 === 0) {
      ctx.fillStyle = "#fff";
      ctx.font = "18px 'Microsoft YaHei', sans-serif";
      ctx.fillText("按 Enter 开始游戏", W / 2, H / 2 + 60);
    }
  } else if (mode === "gameover") {
    ctx.fillStyle = "#e04a4a";
    ctx.font = "bold 46px 'Microsoft YaHei', sans-serif";
    ctx.fillText("游戏结束", W / 2, H / 2 - 30);
    ctx.fillStyle = "#fff";
    ctx.font = "18px 'Microsoft YaHei', sans-serif";
    ctx.fillText("得分 " + score, W / 2, H / 2 + 18);
    if (clearTimer < 1 && Math.floor(time * 2) % 2 === 0) {
      ctx.fillText("按 Enter 重新开始", W / 2, H / 2 + 62);
    }
  } else if (mode === "clear") {
    ctx.fillStyle = "#5ad05a";
    ctx.font = "bold 40px 'Microsoft YaHei', sans-serif";
    ctx.fillText("关卡完成！", W / 2, H / 2 - 10);
    ctx.fillStyle = "#fff";
    ctx.font = "16px 'Microsoft YaHei', sans-serif";
    ctx.fillText("进入下一关…", W / 2, H / 2 + 40);
  } else if (paused) {
    ctx.fillStyle = "#fff";
    ctx.font = "bold 36px 'Microsoft YaHei', sans-serif";
    ctx.fillText("已暂停", W / 2, H / 2);
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

// ---------- HUD ----------
function updateHud() {
  scoreEl.textContent = score;
  hiscoreEl.textContent = hiScore;
  stageEl.textContent = (level % LEVELS.length) + 1;
  livesEl.innerHTML = Array.from({ length: Math.max(0, lives) }, () => '<span class="dot gold"></span>').join("");
  const remaining = enemiesTotal - enemiesSpawned + enemies.filter(e => !e.dead).length;
  enemiesEl.innerHTML = remaining > 8
    ? "<span>" + remaining + "</span>"
    : Array.from({ length: remaining }, () => '<span class="dot enemy"></span>').join("");
}

// ---------- 流程控制 ----------
function loadLevel(n) {
  level = n;
  buildLevel(LEVELS[n % LEVELS.length]);
  bullets = [];
  enemies = [];
  powerups = [];
  particles = [];
  fortify = null;
  baseDestroyed = false;
  enemiesTotal = enemiesCount(level);
  enemiesSpawned = 0;
  spawnTimer = 1;
  spawnIndex = 0;
  makePlayer();
  updateHud();
}

function startGame() {
  score = 0;
  lives = 3;
  mode = "play";
  paused = false;
  loadLevel(0);
}

// ---------- 输入 ----------
const keys = { up: false, down: false, left: false, right: false, fire: false };

const KEYMAP = {
  ArrowUp: "up", KeyW: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
  Space: "fire", KeyJ: "fire",
  KeyP: "pause", KeyM: "mute", Enter: "enter",
};

window.addEventListener("keydown", (e) => {
  const action = KEYMAP[e.code];
  if (!action) return;
  e.preventDefault();
  audio.ensure();

  if (action === "enter") {
    if (mode === "title" || mode === "gameover") startGame();
    return;
  }
  if (action === "pause") {
    if (mode === "play") paused = !paused;
    return;
  }
  if (action === "mute") {
    audio.toggle();
    return;
  }
  keys[action] = true;
});

window.addEventListener("keyup", (e) => {
  const action = KEYMAP[e.code];
  if (action) keys[action] = false;
});

// ---------- 主循环 ----------
let last = performance.now();

function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.05) dt = 0.05;

  if (mode === "play" && !paused) update(dt);
  else time += dt;

  if (mode === "clear") {
    clearTimer -= dt;
    if (clearTimer <= 0) {
      loadLevel(level + 1);
      mode = "play";
    }
  }
  if (mode === "gameover") {
    clearTimer -= dt;
  }

  draw();
  requestAnimationFrame(frame);
}

// ---------- 启动 ----------
buildLevel(LEVELS[0]);
makePlayer();
updateHud();
requestAnimationFrame(frame);
