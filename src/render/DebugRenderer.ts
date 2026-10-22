import { INJECT_PRESSURE_BAR } from '../sim/constants';
import { B_COS, B_SIN, B_X, B_Y, BODY_STRIDE, MAX_BODIES } from '../sim/DebrisField';
import type { DemoDirector } from '../sim/DemoDirector';
import { MATERIAL_COLORS, MATERIAL_COUNT } from '../sim/materials';
import { MAX_HEALTH, MAX_PATH, PAWN_STATE_NAMES, PAWN_WARNING_BITS, PawnState, PawnWarning, SUIT_O2 } from '../sim/PawnManager';
import type { Simulation } from '../sim/Simulation';
import { TileFlags, isLoadBearing, isSolid } from '../sim/TileFlags';
import { OrderKind, PRIORITY_DEFAULT, ToolKind } from '../sim/WorkOrderQueue';
import type { World } from '../sim/World';
import { RAMP_MAX_BAR, RAMP_SIZE, buildGasRamp, buildStressPalette, packRGBA } from './colorRamp';

const STRESS_BUCKETS = 16;
const BUCKET_FLOATING = STRESS_BUCKETS;
const BUCKET_SNAPPED = STRESS_BUCKETS + 1;
const BUCKET_TOTAL = STRESS_BUCKETS + 2;

const MIN_ZOOM = 2;
const MAX_ZOOM = 64;
const KEY_PAN_TILES_PER_SEC = 40;

const COLOR_BACKGROUND = '#070a12';
const COLOR_FLOATING = 'rgba(148, 163, 184, 0.6)';
const COLOR_SNAPPED = 'rgba(239, 68, 68, 0.35)';
const COLOR_ANCHOR = '#38bdf8';
const COLOR_FLOATING_TILE = 'rgba(148, 163, 184, 0.35)';
const COLOR_HOVER = 'rgba(255, 255, 255, 0.85)';

const COLOR_ORDER = 'rgba(251, 146, 60, 0.9)';
/** Sever orders (salvage designations), and the drag rectangle that places them. */
const COLOR_ORDER_SEVER = 'rgba(56, 189, 248, 0.9)';
const COLOR_SALVAGE_DRAG = 'rgba(56, 189, 248, 0.8)';
const COLOR_ORDER_CLAIMED = 'rgba(250, 204, 21, 0.95)';
const COLOR_ORDER_SUSPENDED = 'rgba(239, 68, 68, 0.95)';
const COLOR_ORDER_PROGRESS = 'rgba(250, 204, 21, 0.55)';
const COLOR_PATH = 'rgba(56, 189, 248, 0.9)';
const COLOR_SELECTED = '#ffffff';
const COLOR_PAWN_TEXT = '#e2e8f0';
const COLOR_PAWN_WARNING = '#f87171';
const COLOR_HEADING = '#0f172a';
const COLOR_GRAPPLE = 'rgba(56, 189, 248, 0.95)';
const COLOR_DEBRIS_EDGE = 'rgba(7, 10, 18, 0.55)';
/** Outline and label per `Bin`. */
const ZONE_COLORS: readonly string[] = ['#000000', '#f97316', '#a3e635', '#38bdf8'];
const ZONE_FILLS: readonly string[] = [
  'rgba(0, 0, 0, 0)',
  'rgba(249, 115, 22, 0.07)',
  'rgba(163, 230, 53, 0.07)',
  'rgba(56, 189, 248, 0.07)',
];
const ZONE_LABELS: readonly string[] = ['', 'FURNACE', 'PROCESSOR', 'BARGE'];
const ZONE_FONT = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
const BANNER_FONT = '16px ui-monospace, SFMono-Regular, Menlo, monospace';
const COLOR_BANNER = '#f8fafc';
const COLOR_BANNER_BG = 'rgba(7, 10, 18, 0.78)';
const COLOR_DEMO_CURSOR = '#fb923c';
const PAWN_FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
/** Fill per PawnState. */
const PAWN_COLORS: readonly string[] = [
  '#94a3b8', // idle
  '#38bdf8', // navigating
  '#facc15', // pre-cut
  '#fb923c', // disassembling
  '#f43f5e', // fleeing
  '#a78bfa', // approaching a chunk
  '#34d399', // tugging
  '#22d3ee', // returning
  '#64748b', // down
  '#f0abfc', // rescue: going
  '#e879f9', // rescue: flying out
  '#d946ef', // rescue: carrying
];
const COLOR_HEALTH = '#ef4444';
const COLOR_AIR = '#38bdf8';
const COLOR_BAR_BACK = 'rgba(15, 23, 42, 0.8)';
/** Smallest pawn radius in pixels, so the crew stays visible zoomed out. */
const MIN_PAWN_RADIUS = 6;
/** Zoom (pixels per tile) at which every pawn gets a status label, not just the selected one. */
const LABEL_ZOOM = 10;

const TILE_VOID = packRGBA(0, 0, 0, 0);
const TILE_FLOOR = packRGBA(36, 42, 56, 255);
const TILE_BULKHEAD = packRGBA(100, 110, 128, 255);
const TILE_GIRDER = packRGBA(150, 128, 92, 255);
const TILE_LEAK = packRGBA(170, 60, 170, 255);

const Tool = {
  NONE: 0,
  CUT: 1,
  INJECT: 2,
  PAN: 3,
  DESIGNATE: 4,
  UNDESIGNATE: 5,
  GRAPPLE: 6,
  SALVAGE: 7,
} as const;

/** Label per warning bitmask, built once so drawing a label never builds a string. */
function buildWarningLabels(): string[] {
  const names = ['PRESSURE', 'VENT', 'TOXIC', 'STRESS', 'ADRIFT'];
  const bits = [PawnWarning.PRESSURE, PawnWarning.VENT, PawnWarning.TOXIC, PawnWarning.STRESS, PawnWarning.ADRIFT];
  const out: string[] = [];
  for (let mask = 0; mask < 1 << PAWN_WARNING_BITS; mask++) {
    const parts: string[] = [];
    for (let b = 0; b < bits.length; b++) if ((mask & bits[b]) !== 0) parts.push(names[b]);
    out.push(parts.length > 0 ? `! ${parts.join(' ')}` : '');
  }
  return out;
}

/**
 * Canvas 2D debug view: tiles, gas pressure ramp, the stress lattice, work orders and
 * pawns, with a pan/zoom camera and mouse tools. All buffers, colour tables, labels and
 * event handlers are created in the constructor; `render()` only writes into them.
 *
 * Controls:
 *   Left click            select the pawn under the cursor; on debris, grapple it (drag to tow);
 *                         elsewhere, cut tile (drag to keep cutting)
 *   Shift + left click    designate a wall for deconstruction (drag for more; again to cancel)
 *   Ctrl + left drag      salvage: the crew severs the ring around the rectangle and hauls it away
 *   Right click / hold    inject 10 bar gas
 *   Middle click          toggle dock anchor on a girder
 *   P                     spawn a pawn at the cursor
 *   Esc                   deselect
 *   Space + drag pan; WASD / arrows pan; wheel zooms at cursor
 *   G / T                 toggle gas / stress layers
 */
export class DebugRenderer {
  showGas = true;
  showStress = true;

  /**
   * Camera centre in tile units, and zoom in whole device pixels per tile. Integer zoom and a
   * pixel-snapped origin keep tiles crisp and keep every per-frame canvas argument a small
   * integer, which V8 passes without boxing.
   */
  camX: number;
  camY: number;
  zoom = 6;

  hoverX = -1;
  hoverY = -1;
  /** Cursor position in fractional tile units, for picking pawns and debris. */
  hoverFx = -1;
  hoverFy = -1;
  /** Pawn whose route is drawn, or -1. */
  selectedPawn = -1;
  /** Attract-mode script, whose cursor and caption are drawn while it runs. */
  demo: DemoDirector | null = null;
  /** Two-line banner across the top (contract status), drawn when the demo is not running. */
  bannerTitle = '';
  bannerSub = '';

  private readonly world: World;
  private readonly warningLabels = buildWarningLabels();

  private readonly ctx: CanvasRenderingContext2D;
  private readonly tileCanvas: HTMLCanvasElement;
  private readonly tileCtx: CanvasRenderingContext2D;
  private readonly tileImage: ImageData;
  private readonly tilePixels: Uint32Array;
  private readonly gasCanvas: HTMLCanvasElement;
  private readonly gasCtx: CanvasRenderingContext2D;
  private readonly gasImage: ImageData;
  private readonly gasPixels: Uint32Array;
  private readonly gasRamp: Uint32Array;
  private readonly stressColors: string[];

  /** Edge ids grouped by colour bucket via a counting sort each frame. */
  private readonly edgeOrder: Int32Array;
  private readonly bucketCount = new Int32Array(BUCKET_TOTAL);
  private readonly bucketStart = new Int32Array(BUCKET_TOTAL);

  private dpr = 1;
  /** Salvage drag corners in tiles: x0, y0, x1, y1. */
  private readonly salvage = new Int32Array(4);
  private tool: number = Tool.NONE;
  private panKeyHeld = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private lastFrameTime = 0;
  private readonly keys = new Uint8Array(8);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sim: Simulation,
  ) {
    const world = sim.world;
    this.world = world;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    const { width, height } = world;
    this.camX = width / 2;
    this.camY = height / 2;

    this.tileCanvas = document.createElement('canvas');
    this.tileCanvas.width = width;
    this.tileCanvas.height = height;
    this.tileCtx = this.get2d(this.tileCanvas);
    this.tileImage = this.tileCtx.createImageData(width, height);
    this.tilePixels = new Uint32Array(this.tileImage.data.buffer);

    this.gasCanvas = document.createElement('canvas');
    this.gasCanvas.width = width;
    this.gasCanvas.height = height;
    this.gasCtx = this.get2d(this.gasCanvas);
    this.gasImage = this.gasCtx.createImageData(width, height);
    this.gasPixels = new Uint32Array(this.gasImage.data.buffer);

    this.gasRamp = buildGasRamp();
    this.stressColors = buildStressPalette(STRESS_BUCKETS);
    this.edgeOrder = new Int32Array(world.lattice.edgeCount);

    this.bindEvents();
    this.resize();
    this.resetCamera();
  }

  /** Fits the whole grid in the viewport. */
  resetCamera(): void {
    this.camX = this.world.width / 2;
    this.camY = this.world.height / 2;
    const fit = Math.min(this.canvas.width / this.world.width, this.canvas.height / this.world.height);
    this.zoom = clamp(Math.floor(fit), MIN_ZOOM, MAX_ZOOM);
  }

  /** Centres and zooms the camera on a tile rectangle (inclusive), with a margin. */
  focus(x0: number, y0: number, x1: number, y1: number, margin = 6): void {
    this.camX = (x0 + x1 + 1) / 2;
    this.camY = (y0 + y1 + 1) / 2;
    const w = x1 - x0 + 1 + margin * 2;
    const h = y1 - y0 + 1 + margin * 2;
    this.zoom = clamp(Math.floor(Math.min(this.canvas.width / w, this.canvas.height / h)), MIN_ZOOM, MAX_ZOOM);
  }

  /** Applies tools that act every tick while held (cut drag, gas injection). */
  applyHeldTools(): void {
    if (this.hoverX < 0) return;
    if (this.tool === Tool.INJECT) this.world.injectGas(this.hoverX, this.hoverY, INJECT_PRESSURE_BAR, 1);
  }

  render(now: number): void {
    const dt = this.lastFrameTime === 0 ? 0 : Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;
    this.applyKeyPan(dt);

    const ctx = this.ctx;
    const { width, height } = this.world;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLOR_BACKGROUND;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const z = this.zoom;
    ctx.setTransform(z, 0, 0, z, this.originX(), this.originY());
    ctx.imageSmoothingEnabled = false;

    this.paintTiles();
    ctx.drawImage(this.tileCanvas, 0, 0, width, height);

    if (this.showGas) {
      this.paintGas();
      ctx.drawImage(this.gasCanvas, 0, 0, width, height);
    }

    if (this.showStress) this.drawStress();
    this.drawZones();
    if (this.tool === Tool.SALVAGE) this.drawSalvageDrag();

    if (this.hoverX >= 0) {
      ctx.strokeStyle = COLOR_HOVER;
      ctx.lineWidth = 0.15;
      ctx.strokeRect(this.hoverX, this.hoverY, 1, 1);
    }

    // Orders, routes and pawns are drawn in device pixels, rounded to integers so canvas
    // arguments stay small integers rather than boxed doubles.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawDebris();
    this.drawZoneLabels();
    this.drawOrders();
    if (this.selectedPawn >= 0) this.drawRoute(this.selectedPawn);
    this.drawPawns();
    if (this.demo !== null && this.demo.active) this.drawDemo(this.demo);
    else if (this.bannerTitle !== '') this.drawBanner(this.bannerTitle, this.bannerSub);
  }

  /** The demo's torch or grapple cursor, and its caption across the top. */
  private drawDemo(demo: DemoDirector): void {
    const ctx = this.ctx;
    const z = this.zoom;
    if (demo.cursorX >= 0) {
      const sx = (this.originX() + demo.cursorX * z) | 0;
      const sy = (this.originY() + demo.cursorY * z) | 0;
      const r = z > 6 ? z : 6;
      ctx.strokeStyle = COLOR_DEMO_CURSOR;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx - r - 4, sy);
      ctx.lineTo(sx - 3, sy);
      ctx.moveTo(sx + 3, sy);
      ctx.lineTo(sx + r + 4, sy);
      ctx.moveTo(sx, sy - r - 4);
      ctx.lineTo(sx, sy - 3);
      ctx.moveTo(sx, sy + 3);
      ctx.lineTo(sx, sy + r + 4);
      ctx.stroke();
      ctx.strokeRect(sx - r, sy - r, r * 2, r * 2);
    }
    this.drawBanner(demo.label, demo.hint);
  }

  private drawBanner(title: string, sub: string): void {
    const ctx = this.ctx;
    ctx.font = BANNER_FONT;
    ctx.textBaseline = 'top';
    ctx.fillStyle = COLOR_BANNER_BG;
    ctx.fillRect(12, 12, 760, 52);
    ctx.fillStyle = COLOR_BANNER;
    ctx.fillText(title, 22, 20);
    ctx.fillStyle = COLOR_DEMO_CURSOR;
    ctx.fillText(sub, 22, 42);
  }

  /** Salvage bins: tinted rectangles in tile space. Zone corners are whole tiles. */
  /** The salvage drag: the block to cut free, and the ring the crew will sever around it. */
  private drawSalvageDrag(): void {
    const ctx = this.ctx;
    const sv = this.salvage;
    const x0 = sv[0] < sv[2] ? sv[0] : sv[2];
    const y0 = sv[1] < sv[3] ? sv[1] : sv[3];
    const w = (sv[0] < sv[2] ? sv[2] - sv[0] : sv[0] - sv[2]) + 1;
    const h = (sv[1] < sv[3] ? sv[3] - sv[1] : sv[1] - sv[3]) + 1;
    ctx.strokeStyle = COLOR_SALVAGE_DRAG;
    ctx.lineWidth = 0.2;
    ctx.strokeRect(x0, y0, w, h);
    ctx.strokeRect(x0 - 1, y0 - 1, w + 2, h + 2);
  }

  private drawZones(): void {
    const ctx = this.ctx;
    const S = this.world.salvage;
    ctx.lineWidth = 0.25;
    for (let z = 0; z < S.zoneCount; z++) {
      const bin = S.zoneBin[z];
      const x0 = S.zoneRect[z * 4] | 0;
      const y0 = S.zoneRect[z * 4 + 1] | 0;
      const w = (S.zoneRect[z * 4 + 2] | 0) - x0;
      const h = (S.zoneRect[z * 4 + 3] | 0) - y0;
      ctx.fillStyle = ZONE_FILLS[bin];
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = ZONE_COLORS[bin];
      ctx.strokeRect(x0, y0, w, h);
    }
  }

  private drawZoneLabels(): void {
    const ctx = this.ctx;
    const S = this.world.salvage;
    const z = this.zoom;
    const ox = this.originX();
    const oy = this.originY();
    ctx.font = ZONE_FONT;
    ctx.textBaseline = 'top';
    for (let k = 0; k < S.zoneCount; k++) {
      const bin = S.zoneBin[k];
      ctx.fillStyle = ZONE_COLORS[bin];
      ctx.fillText(ZONE_LABELS[bin], ox + (S.zoneRect[k * 4] | 0) * z + 4, oy + (S.zoneRect[k * 4 + 1] | 0) * z + 4);
    }
  }

  /**
   * Debris bodies as rotated tile quads in device pixels, one path per material per body.
   * Corners are rounded to whole pixels so every canvas argument is a small integer.
   */
  private drawDebris(): void {
    const D = this.world.debris;
    if (D.count === 0 && D.grabBody < 0) return;
    const ctx = this.ctx;
    const z = this.zoom;
    const ox = this.originX();
    const oy = this.originY();
    const s = D.body;
    const local = D.tileLocal;
    ctx.strokeStyle = COLOR_DEBRIS_EDGE;
    ctx.lineWidth = 1;
    for (let b = 0; b < MAX_BODIES; b++) {
      if (D.alive[b] === 0) continue;
      const o = b * BODY_STRIDE;
      const c = s[o + B_COS];
      const sn = s[o + B_SIN];
      const cx = ox + s[o + B_X] * z;
      const cy = oy + s[o + B_Y] * z;
      // Half-tile axis vectors in pixels: u along the body's x, v along its y.
      const ux = c * 0.5 * z;
      const uy = sn * 0.5 * z;
      const vx = -sn * 0.5 * z;
      const vy = c * 0.5 * z;
      const start = D.tileStart[b];
      const end = start + D.tileCount[b];
      for (let m = 1; m < MATERIAL_COUNT; m++) {
        let any = false;
        ctx.beginPath();
        for (let t = start; t < end; t++) {
          if (D.tileMaterial[t] !== m) continue;
          any = true;
          const lx = local[t * 2];
          const ly = local[t * 2 + 1];
          const px = cx + (c * lx - sn * ly) * z;
          const py = cy + (sn * lx + c * ly) * z;
          ctx.moveTo((px - ux - vx) | 0, (py - uy - vy) | 0);
          ctx.lineTo((px + ux - vx) | 0, (py + uy - vy) | 0);
          ctx.lineTo((px + ux + vx) | 0, (py + uy + vy) | 0);
          ctx.lineTo((px - ux + vx) | 0, (py - uy + vy) | 0);
          ctx.closePath();
        }
        if (!any) continue;
        ctx.fillStyle = MATERIAL_COLORS[m];
        ctx.fill();
        if (z >= LABEL_ZOOM) ctx.stroke();
      }
    }

    const g = D.grabBody;
    if (g >= 0) {
      const o = g * BODY_STRIDE;
      const c = s[o + B_COS];
      const sn = s[o + B_SIN];
      const gx = s[o + B_X] + c * D.grab[0] - sn * D.grab[1];
      const gy = s[o + B_Y] + sn * D.grab[0] + c * D.grab[1];
      ctx.strokeStyle = COLOR_GRAPPLE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo((ox + gx * z) | 0, (oy + gy * z) | 0);
      ctx.lineTo((ox + D.grab[2] * z) | 0, (oy + D.grab[3] * z) | 0);
      ctx.stroke();
      ctx.strokeRect(((ox + gx * z) | 0) - 3, ((oy + gy * z) | 0) - 3, 6, 6);
    }
  }

  private drawOrders(): void {
    const ctx = this.ctx;
    const q = this.sim.orders;
    const w = this.world.width;
    const z = this.zoom;
    const ox = this.originX();
    const oy = this.originY();
    const inset = z > 6 ? 1 : 0;
    ctx.lineWidth = z > 8 ? 2 : 1;
    for (let s = 0; s < q.capacity; s++) {
      const idx = q.cell[s];
      if (idx < 0) continue;
      const sx = ox + (idx % w) * z;
      const sy = oy + ((idx / w) | 0) * z;
      ctx.strokeStyle =
        q.suspended[s] > 0
          ? COLOR_ORDER_SUSPENDED
          : q.claimedBy[s] >= 0
            ? COLOR_ORDER_CLAIMED
            : q.kind[s] === OrderKind.SEVER
              ? COLOR_ORDER_SEVER
              : COLOR_ORDER;
      ctx.strokeRect(sx + inset, sy + inset, z - inset * 2, z - inset * 2);
      const filled = ((q.progress[s] * z) / 100) | 0;
      if (filled > 0) {
        ctx.fillStyle = COLOR_ORDER_PROGRESS;
        ctx.fillRect(sx, sy + z - filled, z, filled);
      }
    }
  }

  /** Route from the pawn through its remaining waypoints to the target tile. */
  private drawRoute(p: number): void {
    const P = this.sim.pawns;
    if (P.alive[p] === 0) {
      this.selectedPawn = -1;
      return;
    }
    const ctx = this.ctx;
    const w = this.world.width;
    const z = this.zoom;
    const ox = this.originX();
    const oy = this.originY();
    const half = z >> 1;
    ctx.strokeStyle = COLOR_PATH;
    ctx.lineWidth = z > 8 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo((ox + P.pos[p * 2] * z) | 0, (oy + P.pos[p * 2 + 1] * z) | 0);
    const base = p * MAX_PATH;
    for (let k = P.pathStep[p]; k < P.pathLen[p]; k++) {
      const n = P.path[base + k];
      ctx.lineTo(ox + (n % w) * z + half, oy + ((n / w) | 0) * z + half);
    }
    ctx.stroke();
    const tx = P.target[p * 2];
    if (tx >= 0 && P.state[p] !== PawnState.IDLE) {
      ctx.strokeRect(ox + tx * z, oy + P.target[p * 2 + 1] * z, z, z);
    }
  }

  private drawPawns(): void {
    const ctx = this.ctx;
    const P = this.sim.pawns;
    const z = this.zoom;
    const ox = this.originX();
    const oy = this.originY();
    const rz = (z * 0.45) | 0;
    const r = rz > MIN_PAWN_RADIUS ? rz : MIN_PAWN_RADIUS;
    const nose = r * 2;
    ctx.font = PAWN_FONT;
    ctx.textBaseline = 'middle';
    for (let p = 0; p < P.capacity; p++) {
      if (P.alive[p] === 0) continue;
      const sx = (ox + P.pos[p * 2] * z) | 0;
      const sy = (oy + P.pos[p * 2 + 1] * z) | 0;
      const state = P.state[p];

      // Body: a diamond, filled when the magboots are locked to the floor, hollow when adrift.
      ctx.beginPath();
      ctx.moveTo(sx, sy - r);
      ctx.lineTo(sx + r, sy);
      ctx.lineTo(sx, sy + r);
      ctx.lineTo(sx - r, sy);
      ctx.closePath();
      if (P.magBoot[p] === 1) {
        ctx.fillStyle = PAWN_COLORS[state];
        ctx.fill();
      } else {
        ctx.strokeStyle = PAWN_COLORS[state];
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Heading indicator.
      ctx.strokeStyle = P.magBoot[p] === 1 ? COLOR_HEADING : PAWN_COLORS[state];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo((sx + P.heading[p * 2] * nose) | 0, (sy + P.heading[p * 2 + 1] * nose) | 0);
      ctx.stroke();

      // Vitals: health and suit air under the pawn, shown once either is below full.
      const hp = P.health[p];
      const air = P.oxygen[p];
      if (hp < MAX_HEALTH || air < SUIT_O2) {
        const bw = r * 2;
        const bx = sx - r;
        const by = sy + r + 2;
        ctx.fillStyle = COLOR_BAR_BACK;
        ctx.fillRect(bx - 1, by - 1, bw + 2, 6);
        ctx.fillStyle = COLOR_HEALTH;
        ctx.fillRect(bx, by, hp > 0 ? ((hp * bw) / MAX_HEALTH) | 0 : 0, 2);
        ctx.fillStyle = COLOR_AIR;
        ctx.fillRect(bx, by + 2, ((air * bw) / SUIT_O2) | 0, 2);
      }

      const selected = p === this.selectedPawn;
      if (selected) {
        ctx.strokeStyle = COLOR_SELECTED;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx - r - 3, sy - r - 3, r * 2 + 6, r * 2 + 6);
      }

      // Status: state, cut progress, and any safety warnings.
      if (selected || z >= LABEL_ZOOM) {
        const lx = sx + r + 4;
        ctx.fillStyle = COLOR_PAWN_TEXT;
        ctx.fillText(PAWN_STATE_NAMES[state], lx, sy - 6);
        if (state === PawnState.DISASSEMBLING || state === PawnState.PRE_CUT) {
          const bar = ((P.progress[p] * 40) / 100) | 0;
          ctx.fillRect(lx, sy + 1, bar, 3);
        }
        const warn = P.warnings[p];
        if (warn !== 0) {
          ctx.fillStyle = COLOR_PAWN_WARNING;
          ctx.fillText(this.warningLabels[warn], lx, sy + 10);
        }
      }
    }
  }

  /** Shift-click: designates a wall, or cancels an existing order. Returns the mode for dragging. */
  private designateAtHover(mode: number): number {
    const x = this.hoverX;
    const y = this.hoverY;
    if (x < 0) return mode;
    const q = this.sim.orders;
    if (mode === Tool.NONE) mode = q.hasOrder(x, y) ? Tool.UNDESIGNATE : Tool.DESIGNATE;
    if (mode === Tool.UNDESIGNATE) {
      q.cancelOrder(x, y);
    } else {
      const flags = this.world.getTile(x, y);
      if (isSolid(flags)) {
        q.addOrder(x, y, PRIORITY_DEFAULT, isLoadBearing(flags) ? ToolKind.HEAVY_CUTTER : ToolKind.CUTTER);
      }
    }
    return mode;
  }

  private paintTiles(): void {
    const tiles = this.world.tiles;
    const px = this.tilePixels;
    for (let i = 0; i < tiles.length; i++) {
      const f = tiles[i];
      let c = TILE_VOID;
      if ((f & TileFlags.GIRDER) !== 0) c = TILE_GIRDER;
      else if ((f & TileFlags.BULKHEAD) !== 0) c = TILE_BULKHEAD;
      else if ((f & TileFlags.HAZARD_LEAK) !== 0) c = TILE_LEAK;
      else if ((f & TileFlags.FLOOR) !== 0) c = TILE_FLOOR;
      px[i] = c;
    }
    this.tileCtx.putImageData(this.tileImage, 0, 0);
  }

  private paintGas(): void {
    const p = this.world.gas.current;
    const px = this.gasPixels;
    const ramp = this.gasRamp;
    const scale = (RAMP_SIZE - 1) / RAMP_MAX_BAR;
    for (let i = 0; i < p.length; i++) {
      let idx = (p[i] * scale) | 0;
      if (idx < 0) idx = 0;
      else if (idx >= RAMP_SIZE) idx = RAMP_SIZE - 1;
      px[i] = ramp[idx];
    }
    this.gasCtx.putImageData(this.gasImage, 0, 0);
  }

  /** Draws edges batched by colour bucket (one stroke per bucket) and anchor markers. */
  private drawStress(): void {
    const ctx = this.ctx;
    const L = this.world.lattice;
    const w = L.width;
    const count = this.bucketCount;
    const start = this.bucketStart;
    const order = this.edgeOrder;
    const active = L.nodeActive;
    const grounded = L.nodeGrounded;

    count.fill(0);
    for (let e = 0; e < L.edgeCount; e++) {
      const b = this.edgeBucket(e);
      if (b >= 0) count[b]++;
    }
    let acc = 0;
    for (let b = 0; b < BUCKET_TOTAL; b++) {
      start[b] = acc;
      acc += count[b];
      count[b] = start[b];
    }
    for (let e = 0; e < L.edgeCount; e++) {
      const b = this.edgeBucket(e);
      if (b >= 0) order[count[b]++] = e;
    }

    // Anchors and free-floating debris are whole-tile fills so their rects stay integer.
    ctx.fillStyle = COLOR_ANCHOR;
    ctx.beginPath();
    for (let n = 0; n < L.nodeCount; n++) {
      if (active[n] === 1 && L.isAnchor[n] === 1) ctx.rect(n % w, (n / w) | 0, 1, 1);
    }
    ctx.fill();
    ctx.fillStyle = COLOR_FLOATING_TILE;
    ctx.beginPath();
    for (let n = 0; n < L.nodeCount; n++) {
      if (active[n] === 1 && grounded[n] === 0) ctx.rect(n % w, (n / w) | 0, 1, 1);
    }
    ctx.fill();

    // Shift to tile centres once so edge endpoints stay integers (no boxed doubles per call).
    ctx.translate(0.5, 0.5);
    ctx.lineCap = 'round';
    for (let b = 0; b < BUCKET_TOTAL; b++) {
      const from = start[b];
      const to = count[b];
      if (to === from) continue;
      ctx.beginPath();
      for (let k = from; k < to; k++) {
        const e = order[k];
        const a = L.edgeA[e];
        const c = L.edgeB[e];
        ctx.moveTo(a % w, (a / w) | 0);
        ctx.lineTo(c % w, (c / w) | 0);
      }
      ctx.strokeStyle =
        b === BUCKET_FLOATING ? COLOR_FLOATING : b === BUCKET_SNAPPED ? COLOR_SNAPPED : this.stressColors[b];
      ctx.lineWidth = b === BUCKET_SNAPPED ? 0.15 : 0.3;
      ctx.stroke();
    }

    ctx.translate(-0.5, -0.5);
  }

  /** Colour bucket for an edge, or -1 when it should not be drawn. */
  private edgeBucket(e: number): number {
    const L = this.world.lattice;
    const a = L.edgeA[e];
    const b = L.edgeB[e];
    if (L.nodeActive[a] === 0 || L.nodeActive[b] === 0) return -1;
    if (L.edgeSnapped[e] === 1) return BUCKET_SNAPPED;
    if (L.nodeGrounded[a] === 0 || L.nodeGrounded[b] === 0) return BUCKET_FLOATING;
    const u = L.edgeUtilisation(e);
    const bucket = (u * (STRESS_BUCKETS - 1)) | 0;
    return bucket >= STRESS_BUCKETS ? STRESS_BUCKETS - 1 : bucket;
  }

  /** Screen-space position of tile (0, 0), snapped to whole pixels. */
  private originX(): number {
    return Math.round(this.canvas.width * 0.5 - this.camX * this.zoom);
  }

  private originY(): number {
    return Math.round(this.canvas.height * 0.5 - this.camY * this.zoom);
  }

  private applyKeyPan(dt: number): void {
    const k = this.keys;
    const dx = k[1] - k[0];
    const dy = k[3] - k[2];
    if (dx === 0 && dy === 0) return;
    const speed = (KEY_PAN_TILES_PER_SEC * dt * 6) / this.zoom;
    this.camX += dx * speed;
    this.camY += dy * speed;
  }

  private screenToTile(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (clientX - rect.left) * this.dpr;
    const sy = (clientY - rect.top) * this.dpr;
    const fx = (sx - this.originX()) / this.zoom;
    const fy = (sy - this.originY()) / this.zoom;
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    this.hoverFx = fx;
    this.hoverFy = fy;
    if (this.world.inBounds(tx, ty)) {
      this.hoverX = tx;
      this.hoverY = ty;
    } else {
      this.hoverX = -1;
      this.hoverY = -1;
    }
  }

  private resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * this.dpr));
    this.canvas.width = w;
    this.canvas.height = h;
  }

  private bindEvents(): void {
    const canvas = this.canvas;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      this.screenToTile(e.clientX, e.clientY);
      if (e.button === 0 && this.panKeyHeld) {
        this.tool = Tool.PAN;
      } else if (e.button === 0 && (e.ctrlKey || e.metaKey) && this.hoverX >= 0) {
        this.tool = Tool.SALVAGE;
        this.salvage[0] = this.salvage[2] = this.hoverX;
        this.salvage[1] = this.salvage[3] = this.hoverY;
      } else if (e.button === 0 && e.shiftKey) {
        this.tool = this.designateAtHover(Tool.NONE);
      } else if (e.button === 0) {
        const picked = this.sim.pawns.pawnNear(this.hoverFx, this.hoverFy, 0.75);
        this.selectedPawn = picked;
        const debris = this.world.debris;
        const body = picked < 0 ? debris.bodyAt(this.hoverFx, this.hoverFy) : -1;
        if (body >= 0) {
          this.tool = Tool.GRAPPLE;
          debris.grabAt(body, this.hoverFx, this.hoverFy);
        } else if (picked < 0) {
          this.tool = Tool.CUT;
          if (this.hoverX >= 0) this.world.cutTile(this.hoverX, this.hoverY);
        }
      } else if (e.button === 2) {
        this.tool = Tool.INJECT;
        this.applyHeldTools();
      } else if (e.button === 1) {
        e.preventDefault();
        if (this.hoverX >= 0) this.world.toggleAnchor(this.hoverX, this.hoverY);
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this.tool === Tool.PAN) {
        this.camX -= ((e.clientX - this.lastPointerX) * this.dpr) / this.zoom;
        this.camY -= ((e.clientY - this.lastPointerY) * this.dpr) / this.zoom;
      }
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      const prevX = this.hoverX;
      const prevY = this.hoverY;
      this.screenToTile(e.clientX, e.clientY);
      const moved = this.hoverX >= 0 && (this.hoverX !== prevX || this.hoverY !== prevY);
      if (this.tool === Tool.SALVAGE && this.hoverX >= 0) {
        this.salvage[2] = this.hoverX;
        this.salvage[3] = this.hoverY;
      } else if (this.tool === Tool.GRAPPLE) {
        this.world.debris.setGrappleTarget(this.hoverFx, this.hoverFy);
      } else if (this.tool === Tool.CUT && moved) {
        this.world.cutTile(this.hoverX, this.hoverY);
      } else if ((this.tool === Tool.DESIGNATE || this.tool === Tool.UNDESIGNATE) && moved) {
        this.designateAtHover(this.tool);
      }
    });

    const release = (e: PointerEvent): void => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (this.tool === Tool.GRAPPLE) this.world.debris.releaseGrapple();
      if (this.tool === Tool.SALVAGE) {
        const sv = this.salvage;
        this.sim.designateSalvage(sv[0], sv[1], sv[2], sv[3]);
      }
      this.tool = Tool.NONE;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('pointerleave', () => {
      if (this.tool === Tool.NONE) this.hoverX = this.hoverY = -1;
    });
    // Stop middle-click autoscroll.
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = (e.clientX - rect.left) * this.dpr - canvas.width * 0.5;
        const sy = (e.clientY - rect.top) * this.dpr - canvas.height * 0.5;
        const beforeX = sx / this.zoom + this.camX;
        const beforeY = sy / this.zoom + this.camY;
        const step = Math.max(1, Math.round(this.zoom * 0.15));
        this.zoom = clamp(this.zoom + (e.deltaY < 0 ? step : -step), MIN_ZOOM, MAX_ZOOM);
        this.camX = beforeX - sx / this.zoom;
        this.camY = beforeY - sy / this.zoom;
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => this.onKey(e, 1));
    window.addEventListener('keyup', (e) => this.onKey(e, 0));
    window.addEventListener('blur', () => {
      this.keys.fill(0);
      this.panKeyHeld = false;
    });
    window.addEventListener('resize', () => this.resize());
  }

  private onKey(e: KeyboardEvent, down: number): void {
    switch (e.code) {
      case 'KeyA':
      case 'ArrowLeft':
        this.keys[0] = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.keys[1] = down;
        break;
      case 'KeyW':
      case 'ArrowUp':
        this.keys[2] = down;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.keys[3] = down;
        break;
      case 'Space':
        this.panKeyHeld = down === 1;
        e.preventDefault();
        break;
      case 'KeyG':
        if (down) this.showGas = !this.showGas;
        break;
      case 'KeyT':
        if (down) this.showStress = !this.showStress;
        break;
      case 'KeyF':
        if (down) this.resetCamera();
        break;
      case 'KeyP':
        if (down && !e.repeat && this.hoverX >= 0) {
          const p = this.sim.pawns.spawn(this.hoverX, this.hoverY);
          if (p >= 0) this.selectedPawn = p;
        }
        break;
      case 'Escape':
        if (down) this.selectedPawn = -1;
        break;
    }
  }

  private get2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    return ctx;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
