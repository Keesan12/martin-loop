/**
 * MartinLoop Arcade — Space Invaders
 *
 * A terminal Space Invaders game that runs while a background task is in
 * flight. Resolves with the task result when the task completes and the
 * user exits, or immediately falls through if the terminal is not suitable.
 *
 * Zero external dependencies. Node 18+ required.
 *
 * Controls
 *   ← → / A D   move
 *   Space / ↑ / Z   fire
 *   P   pause / unpause
 *   R   restart  (game over screen only)
 *   Q   quit
 */

import * as readline from "node:readline";

// ─────────────────────────────────────────────────────────────────────────────
// ANSI helpers
// ─────────────────────────────────────────────────────────────────────────────

const ESC = "\x1b";

const ansi = {
  altOn:  `${ESC}[?1049h`,
  altOff: `${ESC}[?1049l`,
  hide:   `${ESC}[?25l`,
  show:   `${ESC}[?25h`,
  clear:  `${ESC}[2J`,
  reset:  `${ESC}[0m`,
  at:     (row: number, col: number) => `${ESC}[${row};${col}H`,
  rgb:    (r: number, g: number, b: number) => `${ESC}[38;2;${r};${g};${b}m`,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Palette
// ─────────────────────────────────────────────────────────────────────────────

const P = {
  border:      ansi.rgb(55,  155, 255),
  player:      ansi.rgb(84,  255, 198),
  playerWarn:  ansi.rgb(255, 240, 100),
  bullet:      ansi.rgb(255, 255, 255),
  enemyBullet: ansi.rgb(255, 180,  50),
  saucer:      ansi.rgb(255,  70, 190),
  score:       ansi.rgb(  0, 255, 214),
  ui:          ansi.rgb(160, 220, 255),
  accent:      ansi.rgb(120, 255, 255),
  danger:      ansi.rgb(255,  90,  90),
  // 4-tuple — indexed by enemy row 0-3, always valid when row: EnemyRow
  enemy: [
    ansi.rgb(255, 120, 120),
    ansi.rgb(255, 190,  85),
    ansi.rgb(255,  90, 230),
    ansi.rgb(255,  70,  90),
  ] as [string, string, string, string],
  // 3-tuple — indexed by 0/1/2 (low/mid/full hp), always valid
  shield: [
    ansi.rgb(255, 120, 120),
    ansi.rgb(255, 216,  76),
    ansi.rgb( 98, 255, 109),
  ] as [string, string, string],
  starDim:    ansi.rgb( 70, 110, 165),
  starMid:    ansi.rgb(120, 195, 255),
  starBright: ansi.rgb(255, 255, 255),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Sprites
// ─────────────────────────────────────────────────────────────────────────────

// EnemyRow is a union so tuple indexing is statically safe.
type EnemyRow = 0 | 1 | 2 | 3;
type EnemyFrame = 0 | 1;

// 4-tuple of 2-tuples — indexed by EnemyRow then EnemyFrame, never undefined.
const ENEMY_SPRITES: [[string, string], [string, string], [string, string], [string, string]] = [
  ["[-^-]", "[^_^]"],   // row 0 — Token Spender   (30 pts)
  ["<o_o>", "<O_O>"],   // row 1 — CPU Hog          (20 pts)
  ["{x_x}", "{X_X}"],   // row 2 — API Caller       (15 pts)
  ["/vvv\\", "\\vvv/"], // row 3 — Budget Drain     (10 pts)
];

// 4-tuple — indexed by EnemyRow, never undefined.
const ENEMY_PTS: [number, number, number, number] = [30, 20, 15, 10];

const SHIELD_ROWS: [string, string, string] = [" ##### ", "#######", "##   ##"];

const PLAYER_SPRITE = "<[∞]>";
const SAUCER_SPRITE = "«$RUN»";

const PLAYER_W = PLAYER_SPRITE.length; // 5
const ENEMY_W  = 5;
const SAUCER_W = SAUCER_SPRITE.length; // 6

const ENEMY_COLS = 10;
const ENEMY_ROWS = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

// row is EnemyRow so tuple indexing into ENEMY_SPRITES/ENEMY_PTS/P.enemy is safe.
interface Enemy    { x: number; y: number; row: EnemyRow; alive: boolean }
interface Bullet   { x: number; y: number; vy: number }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; glyph: string; color: string }
interface Star     { x: number; y: number; speed: number; glyph: string; color: string }
interface Shield   { x: number; y: number; hp: number }
interface Saucer   { x: number; y: number; vx: number }

type Status = "playing" | "paused" | "wave_clear" | "game_over" | "run_complete";

interface State {
  // layout
  cols: number; rows: number;
  left: number; right: number; top: number; bottom: number;
  playerRow: number;
  // player
  px: number; lives: number; cooldown: number; invuln: number;
  // enemies
  enemies: Enemy[];
  eDx: number; eMoveTimer: number; eFireTimer: number; eFrame: EnemyFrame;
  // projectiles + fx
  pBullets: Bullet[]; eBullets: Bullet[];
  particles: Particle[]; stars: Star[];
  shields: Shield[];
  saucer: Saucer | null; nextSaucer: number;
  // meta
  score: number; level: number; ticks: number;
  status: Status; waveClearTimer: number;
  // run integration
  runDone: boolean; runLabel: string;
}

interface Keys {
  left: boolean; right: boolean; fire: boolean;
  pause: boolean; restart: boolean; quit: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// RNG
// ─────────────────────────────────────────────────────────────────────────────

const rng  = (lo: number, hi: number): number => Math.floor(Math.random() * (hi - lo)) + lo;
const rngf = (): number => Math.random();

// ─────────────────────────────────────────────────────────────────────────────
// State factory
// ─────────────────────────────────────────────────────────────────────────────

function makeStar(s: State): Star {
  const depth = rng(1, 4);
  return {
    x:     rng(s.left + 1, s.right),
    y:     rng(s.top  + 1, s.bottom),
    speed: 1.2 + depth * 2.2,
    glyph: depth === 1 ? "." : depth === 2 ? "*" : "+",
    color: depth === 1 ? P.starDim : depth === 2 ? P.starMid : P.starBright,
  };
}

function initStars(s: State): void {
  const n = Math.max(30, Math.floor(s.cols / 2));
  s.stars = Array.from({ length: n }, () => makeStar(s));
}

function initShields(s: State): void {
  s.shields = [];
  const count   = 4;
  const shieldW = SHIELD_ROWS[0].length; // 7
  const totalW  = count * shieldW + (count - 1) * 3;
  const startX  = s.left + Math.floor((s.cols - totalW) / 2);
  const startY  = s.playerRow - 4;

  for (let si = 0; si < count; si++) {
    const bx = startX + si * (shieldW + 3);
    for (let r = 0; r < SHIELD_ROWS.length; r++) {
      const shieldRow = SHIELD_ROWS[r as 0 | 1 | 2];
      for (let c = 0; c < shieldRow.length; c++) {
        if (shieldRow.charAt(c) === "#") {
          s.shields.push({ x: bx + c, y: startY + r, hp: 3 });
        }
      }
    }
  }
}

function initWave(s: State): void {
  s.enemies = [];
  const gap    = 3;
  const totalW = ENEMY_COLS * ENEMY_W + (ENEMY_COLS - 1) * gap;
  const startX = s.left + Math.floor((s.cols - totalW) / 2);
  const startY = s.top + 3;

  for (let row = 0; row < ENEMY_ROWS; row++) {
    for (let col = 0; col < ENEMY_COLS; col++) {
      s.enemies.push({
        x:     startX + col * (ENEMY_W + gap),
        y:     startY + row * 2,
        row:   row as EnemyRow,
        alive: true,
      });
    }
  }

  s.eDx        = 1;
  s.eMoveTimer = Math.max(0.08, 0.38 - (s.level - 1) * 0.04);
  s.eFireTimer = Math.max(0.40, 0.90 - (s.level - 1) * 0.05);
  s.eFrame     = 0;
}

function createState(cols: number, rows: number): State {
  const left = 1, right = cols - 2, top = 2, bottom = rows - 2;
  const s: State = {
    cols, rows, left, right, top, bottom,
    playerRow: rows - 4,
    px: Math.floor((cols - PLAYER_W) / 2),
    lives: 3, cooldown: 0, invuln: 0,
    enemies: [], eDx: 1, eMoveTimer: 0.38, eFireTimer: 0.9, eFrame: 0,
    pBullets: [], eBullets: [], particles: [], stars: [], shields: [],
    saucer: null, nextSaucer: 12 + rngf() * 10,
    score: 0, level: 1, ticks: 0,
    status: "playing", waveClearTimer: 0,
    runDone: false, runLabel: "",
  };
  initStars(s);
  initShields(s);
  initWave(s);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Physics
// ─────────────────────────────────────────────────────────────────────────────

function explode(s: State, x: number, y: number, color: string, n = 10): void {
  const glyphs = [".", "*", "+", "·", "×"] as const;
  for (let i = 0; i < n; i++) {
    s.particles.push({
      x, y,
      vx: (rngf() * 2 - 1) * 16,
      vy: (rngf() * 2 - 1) * 8,
      life: 0.5 + rngf() * 0.5,
      maxLife: 1.0,
      glyph: glyphs[rng(0, glyphs.length) as 0|1|2|3|4],
      color,
    });
  }
}

function tickShieldAt(s: State, x: number, y: number): boolean {
  for (let i = s.shields.length - 1; i >= 0; i--) {
    const sh = s.shields[i];
    if (sh === undefined) continue; // loop bounds guarantee this never fires
    if (sh.x === x && sh.y === y) {
      sh.hp--;
      if (sh.hp <= 0) s.shields.splice(i, 1);
      return true;
    }
  }
  return false;
}

/** Returns the lowest-row enemy for each x column (the ones that can shoot). */
function frontlineEnemies(alive: Enemy[]): Enemy[] {
  const front = new Map<number, Enemy>();
  for (const e of alive) {
    const cur = front.get(e.x);
    if (!cur || e.y > cur.y) front.set(e.x, e);
  }
  return [...front.values()];
}

function updateParticles(s: State, dt: number): void {
  for (const p of s.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
  s.particles = s.particles.filter(p => p.life > 0);
}

function updateStars(s: State, dt: number): void {
  for (const st of s.stars) {
    st.y += st.speed * dt;
    if (st.y >= s.bottom) Object.assign(st, makeStar(s));
  }
}

function updateEnemies(s: State, dt: number): void {
  const alive = s.enemies.filter(e => e.alive);

  if (alive.length === 0) {
    s.status = "wave_clear";
    s.waveClearTimer = 2.5;
    return;
  }

  // movement tick
  s.eMoveTimer -= dt;
  if (s.eMoveTimer <= 0) {
    const base    = Math.max(0.06, 0.38 - (s.level - 1) * 0.04);
    const density = alive.length / (ENEMY_COLS * ENEMY_ROWS);
    s.eMoveTimer  = base / (1 + (1 - density) * 1.2);
    s.eFrame      = s.eFrame === 0 ? 1 : 0;

    const lx = Math.min(...alive.map(e => e.x));
    const rx = Math.max(...alive.map(e => e.x + ENEMY_W));
    let drop = false;

    if (s.eDx > 0 && rx >= s.right - 1) { s.eDx = -1; drop = true; }
    if (s.eDx < 0 && lx <= s.left  + 1) { s.eDx =  1; drop = true; }

    for (const e of s.enemies) {
      if (!e.alive) continue;
      if (drop) e.y += 1; else e.x += s.eDx;
      if (e.y >= s.playerRow) { s.status = "game_over"; return; }
    }
  }

  // fire tick
  s.eFireTimer -= dt;
  if (s.eFireTimer <= 0) {
    s.eFireTimer = Math.max(0.35, 0.9 - (s.level - 1) * 0.05);
    const shooters = frontlineEnemies(alive);
    if (shooters.length > 0) {
      const sh = shooters[rng(0, shooters.length)];
      if (sh !== undefined) {
        s.eBullets.push({ x: sh.x + 2, y: sh.y + 1, vy: 13 + Math.min(s.level, 6) * 0.8 });
      }
    }
  }
}

function updateSaucer(s: State, dt: number): void {
  if (!s.saucer) {
    if (s.ticks < s.nextSaucer) return;
    const dir = rngf() > 0.5 ? 1 : -1;
    s.saucer = {
      x:  dir === 1 ? s.left - SAUCER_W : s.right + 1,
      y:  s.top + 1,
      vx: 11 * dir,
    };
    s.nextSaucer = s.ticks + 14 + rngf() * 12;
    return;
  }

  s.saucer.x += s.saucer.vx * dt;
  if (
    (s.saucer.vx > 0 && s.saucer.x > s.right  + SAUCER_W) ||
    (s.saucer.vx < 0 && s.saucer.x < s.left   - SAUCER_W * 2)
  ) {
    s.saucer = null;
  }
}

function updatePlayerBullets(s: State, dt: number): void {
  for (let i = s.pBullets.length - 1; i >= 0; i--) {
    const b = s.pBullets[i];
    if (b === undefined) continue; // loop bounds guarantee this never fires

    b.y += b.vy * dt;
    const bx = Math.round(b.x), by = Math.round(b.y);

    if (by <= s.top) { s.pBullets.splice(i, 1); continue; }

    // saucer hit
    if (s.saucer) {
      const sx = Math.floor(s.saucer.x);
      if (bx >= sx && bx < sx + SAUCER_W && by === Math.round(s.saucer.y)) {
        s.score += 150;
        explode(s, s.saucer.x + 3, s.saucer.y, P.saucer, 14);
        s.saucer = null;
        s.pBullets.splice(i, 1);
        continue;
      }
    }

    // enemy hit
    let hit = false;
    for (const e of s.enemies) {
      if (!e.alive) continue;
      if (bx >= e.x && bx < e.x + ENEMY_W && by === e.y) {
        e.alive = false;
        s.score += ENEMY_PTS[e.row];
        explode(s, e.x + 2, e.y, P.enemy[e.row], 10);
        s.pBullets.splice(i, 1);
        hit = true;
        break;
      }
    }
    if (hit) continue;

    // shield hit
    if (tickShieldAt(s, bx, by)) { s.pBullets.splice(i, 1); }
  }
}

function updateEnemyBullets(s: State, dt: number): void {
  for (let i = s.eBullets.length - 1; i >= 0; i--) {
    const b = s.eBullets[i];
    if (b === undefined) continue; // loop bounds guarantee this never fires

    b.y += b.vy * dt;
    const bx = Math.round(b.x), by = Math.round(b.y);

    if (by >= s.bottom) { s.eBullets.splice(i, 1); continue; }

    // player hit
    if (
      s.invuln <= 0 &&
      bx >= s.px && bx < s.px + PLAYER_W &&
      by === s.playerRow
    ) {
      s.lives--;
      explode(s, s.px + 2, s.playerRow, P.player, 16);
      if (s.lives <= 0) {
        s.status = "game_over";
      } else {
        s.invuln = 2.5;
        s.px = Math.floor((s.cols - PLAYER_W) / 2);
      }
      s.eBullets.splice(i, 1);
      continue;
    }

    if (tickShieldAt(s, bx, by)) { s.eBullets.splice(i, 1); }
  }
}

function update(s: State, dt: number, keys: Keys): void {
  s.ticks += dt;

  updateParticles(s, dt);
  updateStars(s, dt);

  if (s.status === "wave_clear") {
    s.waveClearTimer -= dt;
    if (s.waveClearTimer <= 0) {
      s.level++;
      initShields(s);
      initWave(s);
      s.pBullets = [];
      s.eBullets = [];
      s.status   = "playing";
    }
    return;
  }

  if (s.status === "game_over") {
    if (keys.restart) {
      const fresh = createState(s.cols, s.rows);
      // preserve run state so a completed run stays completed on restart
      fresh.runDone  = s.runDone;
      fresh.runLabel = s.runLabel;
      if (s.runDone) fresh.status = "run_complete";
      Object.assign(s, fresh);
    }
    return;
  }

  if (s.status === "run_complete") return;

  if (s.status === "paused") {
    if (keys.pause) s.status = "playing";
    return;
  }

  // playing
  if (keys.pause) { s.status = "paused"; return; }

  if (keys.left)  s.px = Math.max(s.left,             s.px - 2);
  if (keys.right) s.px = Math.min(s.right - PLAYER_W, s.px + 2);

  if (keys.fire && s.cooldown <= 0) {
    const cx      = s.px + 2;
    const offsets = s.level >= 4 ? [-1, 1] : [0];
    for (const off of offsets) {
      s.pBullets.push({ x: cx + off, y: s.playerRow - 1, vy: -28 });
    }
    s.cooldown = s.level >= 5 ? 0.18 : 0.26;
  }

  if (s.cooldown > 0) s.cooldown -= dt;
  if (s.invuln   > 0) s.invuln   -= dt;

  updateEnemies(s, dt);
  updateSaucer(s, dt);
  updatePlayerBullets(s, dt);
  updateEnemyBullets(s, dt);
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer — differential frame buffer (only writes changed cells)
// ─────────────────────────────────────────────────────────────────────────────

interface Cell { ch: string; color: string }

class FrameBuffer {
  // Flat arrays (W*H) — eliminate double-indexing and its noUncheckedIndexedAccess issues.
  private curr: Cell[];
  private prev: Cell[];

  constructor(private readonly W: number, private readonly H: number) {
    const blank = (): Cell => ({ ch: " ", color: "" });
    this.curr = Array.from({ length: W * H }, blank);
    this.prev = Array.from({ length: W * H }, blank);
  }

  private idx(col: number, row: number): number { return row * this.W + col; }

  clear(): void {
    for (let i = 0; i < this.curr.length; i++) {
      this.curr[i] = { ch: " ", color: "" };
    }
  }

  put(col: number, row: number, ch: string, color = ""): void {
    if (col < 0 || col >= this.W || row < 0 || row >= this.H) return;
    this.curr[this.idx(col, row)] = { ch, color };
  }

  str(col: number, row: number, text: string, color = ""): void {
    for (let i = 0; i < text.length; i++) {
      this.put(col + i, row, text.charAt(i), color);
    }
  }

  /** Centre a string horizontally. */
  center(row: number, text: string, color = ""): void {
    this.str(Math.floor((this.W - text.length) / 2), row, text, color);
  }

  flush(): void {
    let out = "";
    let lastColor = "";

    for (let r = 0; r < this.H; r++) {
      for (let c = 0; c < this.W; c++) {
        const i    = this.idx(c, r);
        const cell = this.curr[i];
        const prev = this.prev[i];
        if (cell === undefined || prev === undefined) continue;
        if (cell.ch === prev.ch && cell.color === prev.color) continue;
        out += ansi.at(r + 1, c + 1);
        if (cell.color !== lastColor) {
          out += cell.color || ansi.reset;
          lastColor = cell.color;
        }
        out += cell.ch;
        this.prev[i] = { ...cell };
      }
    }

    if (lastColor) out += ansi.reset;
    if (out) {
      try { process.stdout.write(out); } catch { /* pipe closed */ }
    }
  }
}

// Shield hp is 1-3. Returns palette index 0=red(low) / 1=yellow(mid) / 2=green(full).
function shieldColor(hp: number): string {
  const idx = (hp - 1) as 0 | 1 | 2;
  return P.shield[idx];
}

function draw(fb: FrameBuffer, s: State): void {
  fb.clear();

  const { cols, rows, left, right, top, bottom, playerRow } = s;

  // ── border ────────────────────────────────────────────────
  for (let c = left; c <= right; c++) {
    fb.put(c, top,    "─", P.border);
    fb.put(c, bottom, "─", P.border);
  }
  for (let r = top; r <= bottom; r++) {
    fb.put(left,  r, "│", P.border);
    fb.put(right, r, "│", P.border);
  }
  fb.put(left,  top,    "╭", P.border);
  fb.put(right, top,    "╮", P.border);
  fb.put(left,  bottom, "╰", P.border);
  fb.put(right, bottom, "╯", P.border);

  // ── HUD (row 0, above the border) ─────────────────────────
  fb.str(left + 2, 0, `BUDGET PROTECTED: $${s.score}`, P.score);
  fb.center(0, `WAVE ${s.level}`, P.ui);
  const livesStr = `∞ × ${s.lives}`;
  fb.str(right - livesStr.length - 1, 0, livesStr, s.lives === 1 ? P.danger : P.player);

  // ── controls hint (bottom status bar) ─────────────────────
  const hint = " ←→ move  SPC fire  P pause  Q quit ";
  fb.str(left + 1, rows - 1, hint, P.ui);

  // ── stars ──────────────────────────────────────────────────
  for (const st of s.stars) {
    fb.put(Math.floor(st.x), Math.floor(st.y), st.glyph, st.color);
  }

  // ── shields ────────────────────────────────────────────────
  for (const sh of s.shields) {
    fb.put(sh.x, sh.y, "#", shieldColor(sh.hp));
  }

  // ── saucer ─────────────────────────────────────────────────
  if (s.saucer) {
    fb.str(Math.floor(s.saucer.x), Math.floor(s.saucer.y), SAUCER_SPRITE, P.saucer);
  }

  // ── enemies ────────────────────────────────────────────────
  for (const e of s.enemies) {
    if (!e.alive) continue;
    fb.str(e.x, e.y, ENEMY_SPRITES[e.row][s.eFrame], P.enemy[e.row]);
  }

  // ── player ─────────────────────────────────────────────────
  if (s.lives > 0) {
    const blink = s.invuln > 0 && Math.floor(s.ticks * 8) % 2 === 0;
    if (!blink) {
      fb.str(s.px, playerRow, PLAYER_SPRITE, s.lives === 1 ? P.playerWarn : P.player);
    }
  }

  // ── bullets ────────────────────────────────────────────────
  for (const b of s.pBullets) fb.put(Math.round(b.x), Math.round(b.y), "│", P.bullet);
  for (const b of s.eBullets) fb.put(Math.round(b.x), Math.round(b.y), "¦", P.enemyBullet);

  // ── particles ──────────────────────────────────────────────
  for (const p of s.particles) {
    if (p.life / p.maxLife < 0.08) continue;
    fb.put(Math.round(p.x), Math.round(p.y), p.glyph, p.color);
  }

  // ── overlays ───────────────────────────────────────────────
  const cy = Math.floor(rows / 2);

  if (s.status === "wave_clear") {
    fb.center(cy - 1, `  WAVE ${s.level} CLEARED  `,  P.accent);
    fb.center(cy,     "  agents governed.  ",          P.ui);
  }

  if (s.status === "paused") {
    fb.center(cy, "  PAUSED — P to continue  ", P.ui);
  }

  if (s.status === "game_over") {
    fb.center(cy - 1, "  GOVERNANCE FAILED  ",             P.danger);
    fb.center(cy,     `  budget protected: $${s.score}  `, P.ui);
    fb.center(cy + 1, "  R restart  ·  Q quit  ",          P.ui);
  }

  if (s.status === "run_complete") {
    fb.center(cy - 1, "  ∞  RUN COMPLETE  ∞  ",           P.player);
    fb.center(cy,     `  ${s.runLabel}  `,                 P.accent);
    fb.center(cy + 1, `  session: $${s.score} governed  `, P.ui);
    fb.center(cy + 2, "  Q to exit  ",                     P.ui);
  }

  fb.flush();
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal lifecycle helpers
// ─────────────────────────────────────────────────────────────────────────────

function enterArcadeMode(): void {
  process.stdout.write(ansi.altOn + ansi.hide + ansi.clear);
}

function leaveArcadeMode(): void {
  try {
    process.stdout.write(ansi.reset + ansi.show + ansi.altOff);
  } catch { /* stdout may already be closed */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ArcadeOptions {
  /**
   * Short label shown in the run-complete overlay beneath the ∞ header.
   * E.g. "verified · 1 attempt · $0.18 spent"
   */
  runResultLabel?: string;
}

/**
 * Play a Space Invaders game in the terminal while `task` runs in the
 * background. Returns the same value `task` resolves with.
 *
 * Gracefully skips the game (returns `task` directly) when:
 *   - stdout / stdin are not interactive TTYs
 *   - CI environment variable is set
 *   - Terminal is too small (< 50 cols or < 18 rows)
 */
export function playWhileWaiting<T>(task: Promise<T>, opts: ArcadeOptions = {}): Promise<T> {
  const cols = process.stdout.columns ?? 0;
  const rows = process.stdout.rows    ?? 0;

  if (
    !process.stdout.isTTY  ||
    !process.stdin.isTTY   ||
    process.env["CI"]      ||
    cols < 50              ||
    rows < 18
  ) {
    return task;
  }

  return new Promise<T>((resolve, reject) => {
    const gameCols = Math.min(cols, 100);
    const gameRows = Math.min(rows, 32);

    const state = createState(gameCols, gameRows);
    const fb    = new FrameBuffer(gameCols, gameRows);

    // ── key state ──────────────────────────────────────────────
    // Track last-event timestamp per key. A key is considered "held" when
    // the most recent keypress event for it occurred within HOLD_MS.
    // The OS emits repeat keypress events while a key is held, refreshing
    // the timestamp continuously — no polling needed.
    const held: Record<string, number> = {};
    const HOLD_MS = 140;

    // One-shot flags cleared after a single game-loop tick consumes them.
    let wantPause   = false;
    let wantRestart = false;
    let wantQuit    = false;

    readline.emitKeypressEvents(process.stdin);
    const wasRaw = (process.stdin as NodeJS.ReadStream).isRaw ?? false;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    function onKeypress(
      _ch: string | undefined,
      key: { name?: string; ctrl?: boolean } | undefined,
    ): void {
      if (!key) return;
      const { name = "", ctrl = false } = key;

      if (ctrl && name === "c") {
        cleanup();
        process.exit(130);
      }

      if (["left",  "a"].includes(name)) held["left"]  = Date.now();
      if (["right", "d"].includes(name)) held["right"] = Date.now();
      if (["space", "up", "w", "z", "x"].includes(name)) held["fire"] = Date.now();

      if (name === "p") wantPause   = true;
      if (name === "r") wantRestart = true;
      if (name === "q") wantQuit    = true;
    }

    process.stdin.on("keypress", onKeypress);

    // ── task tracking ──────────────────────────────────────────
    let taskResult: T | undefined;
    let taskError:  unknown;
    let taskDone = false;

    task
      .then(v  => { taskResult = v; taskDone = true; })
      .catch(e => { taskError  = e; taskDone = true; });

    // ── cleanup ────────────────────────────────────────────────
    let cleanedUp = false;

    function cleanup(): void {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(loop);
      process.stdin.removeListener("keypress", onKeypress);
      try {
        if (!wasRaw) process.stdin.setRawMode(false);
      } catch { /* already cleaned up */ }
      process.stdin.pause();
      leaveArcadeMode();
    }

    function finish(): void {
      cleanup();
      if (taskDone) {
        taskError !== undefined ? reject(taskError as Error) : resolve(taskResult as T);
      } else {
        // Task still in flight — wait for it without the game UI
        task.then(resolve).catch(reject);
      }
    }

    // ── game loop ──────────────────────────────────────────────
    enterArcadeMode();

    const FRAME_MS = 1000 / 30;
    let lastTick   = Date.now();

    const loop = setInterval(() => {
      const now = Date.now();
      const dt  = Math.min((now - lastTick) / 1000, 0.1); // cap to avoid spiral-of-death
      lastTick  = now;

      const keys: Keys = {
        left:    (held["left"]  ?? 0) > now - HOLD_MS,
        right:   (held["right"] ?? 0) > now - HOLD_MS,
        fire:    (held["fire"]  ?? 0) > now - HOLD_MS,
        pause:   wantPause,
        restart: wantRestart,
        quit:    wantQuit,
      };
      wantPause = wantRestart = wantQuit = false;

      // Notify game when the background task completes
      if (taskDone && !state.runDone) {
        state.runDone  = true;
        state.runLabel = opts.runResultLabel ?? "run complete.";
        state.status   = "run_complete";
        explode(state, Math.floor(gameCols / 2), Math.floor(gameRows / 2), P.player, 20);
        // Auto-exit 2 s after the run completes so the terminal is restored
        // without requiring the user to press Q.
        setTimeout(finish, 2_000);
      }

      if (keys.quit) { finish(); return; }

      update(state, dt, keys);
      draw(fb, state);
    }, FRAME_MS);
  });
}
