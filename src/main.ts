import shipData from './data/ships.json';
import { DebugRenderer } from './render/DebugRenderer';
import { FixedTimestep } from './sim/FixedTimestep';
import { TICK_HZ } from './sim/constants';
import { Contract, ContractState } from './sim/Contract';
import { B_MASS, BODY_STRIDE } from './sim/DebrisField';
import { DemoDirector } from './sim/DemoDirector';
import { HAZARD_NAMES } from './sim/HazardLog';
import { BIN_NAMES, MATERIAL_BIN, MATERIAL_COUNT, MATERIAL_NAMES } from './sim/materials';
import { JOB_KINDS, JOB_NAMES, JobKind, PAWN_STATE_NAMES, PawnState } from './sim/PawnManager';
import { DEMO, buildDemoHull, seedDemoCrew, warmUpCrew, warmUpKernels } from './sim/scenes';
import { type ShipBlueprint, buildShip, seedShipCrew } from './sim/ships';
import { Simulation } from './sim/Simulation';
import { World } from './sim/World';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

warmUpKernels(new World());
// One short crew cycle: enough to get the hot pawn paths optimised without a long boot.
warmUpCrew(new Simulation(), 1, 200);
const sim = new Simulation();
const world = sim.world;
// Salvage contracts, one per generated ship, taken in turn with N.
const fleet = shipData as ShipBlueprint[];
const contract = new Contract();
let shipIndex = -1;
// Attract mode: the game plays a salvage run on its own until the player takes over, then
// docks the next contract ship to show what is on offer.
const demo = new DemoDirector(sim, fleet);
// `?demo=<section id>` opens straight into one section (looping), `?demo=off` skips the demo.
const demoParam = new URLSearchParams(location.search).get('demo');
if (demoParam !== null && demo.sectionIndex(demoParam) >= 0) demo.playSection(demo.sectionIndex(demoParam));
else if (demoParam !== 'off') demo.restart();
const renderer = new DebugRenderer(canvas, sim);
renderer.demo = demo;
// Any click on the canvas hands control to the player. Capture phase, so it runs before
// the renderer's own tools act on the click.
canvas.addEventListener('pointerdown', () => demo.stop(), { capture: true });
// Frame the gantry, the hull and the salvage bins, so the demo plays out in view, with
// headroom above the furnace for the HUD panel.
renderer.focus(DEMO.gantry.x - 1, DEMO.zones[0].y0 - 30, DEMO.zones[2].x1, DEMO.zones[2].y1, 2);
const clock = new FixedTimestep();

function takeContract(i: number): void {
  demo.stop();
  shipIndex = i;
  buildShip(world, fleet[i]);
  sim.resetCrew();
  seedShipCrew(sim, fleet[i]);
  contract.start(fleet[i]);
}

let paused = false;
/** Full control list in the HUD, toggled with `?`. */
let showHelp = false;
// Doubles kept in a typed array: writing a double to a module-level `let` boxes it every frame.
const LAST_FRAME = 0;
const LAST_TICK_MS = 1;
const timing = new Float64Array(2);
timing[LAST_FRAME] = performance.now();

function frame(now: number): void {
  const ticks = clock.advance(now - timing[LAST_FRAME]);
  timing[LAST_FRAME] = now;
  if (!paused) {
    for (let i = 0; i < ticks; i++) {
      renderer.applyHeldTools();
      demo.tick();
      const t0 = performance.now();
      sim.tick();
      timing[LAST_TICK_MS] = performance.now() - t0;
      contract.tick(world);
    }
  }
  renderer.render(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') paused = !paused;
  else if (e.code === 'KeyM' && !e.repeat) {
    if (demo.active) demo.stop();
    else {
      contract.reset();
      shipIndex = -1;
      demo.restart();
    }
  } else if (/^Digit[0-9]$/.test(e.code) && !e.repeat) {
    // 0 plays the whole demo, 1-n loop one section on its own.
    const n = Number(e.code.slice(5));
    if (n > demo.sections.length) return;
    contract.reset();
    shipIndex = -1;
    if (n === 0) demo.restart();
    else demo.playSection(n - 1);
  } else if (e.code === 'KeyN' && !e.repeat && fleet.length > 0) {
    // Take the ship the demo is showing, call an open contract done, or move on to the next ship.
    if (demo.showcaseIndex >= 0) takeContract(demo.showcaseIndex);
    else if (contract.state === ContractState.ACTIVE) contract.close(world);
    else takeContract((shipIndex + 1) % fleet.length);
  } else if (e.code === 'KeyR') {
    if (shipIndex >= 0) takeContract(shipIndex);
    else {
      demo.stop();
      buildDemoHull(world);
      sim.resetCrew();
      seedDemoCrew(sim);
    }
  } else if (e.code === 'Period' && paused) {
    demo.tick();
    sim.tick();
    contract.tick(world);
  } else if ((e.code === 'KeyC' || e.code === 'KeyH') && !e.repeat) {
    // Job priorities for the selected pawn: 1, 2, 3, 4, off.
    const p = renderer.selectedPawn;
    if (p >= 0 && sim.pawns.alive[p] === 1) sim.pawns.cycleJobPriority(p, e.code === 'KeyC' ? JobKind.CUT : JobKind.HAUL);
  } else if (e.code === 'Slash' && !e.repeat) {
    showHelp = !showHelp;
  }
});

// HUD text is built off the hot path, four times a second.
setInterval(() => {
  const L = world.lattice;
  const g = world.gas;
  const hx = renderer.hoverX;
  const hy = renderer.hoverY;
  let hover = '';
  if (hx >= 0) {
    const v = g.getVentImpulse(hx, hy);
    const n = L.index(hx, hy);
    hover =
      `\ntile (${hx}, ${hy})  p ${g.getPressure(hx, hy).toFixed(2)} bar  toxin ${g.getToxin(hx, hy).toFixed(2)}  cost ${sim.paths.getCost(hx, hy)}` +
      `  vent (${v.x.toFixed(2)}, ${v.y.toFixed(2)})` +
      (L.nodeActive[n] ? `\nnode stress ${(L.nodeStress[n] * 100).toFixed(0)}%${L.isAnchor[n] ? '  [anchor]' : ''}` : '');
  }
  // What the debris under the cursor is made of, and where each part belongs.
  const D = world.debris;
  const body = D.bodyAt(renderer.hoverFx, renderer.hoverFy);
  if (body >= 0) {
    const counts = new Uint32Array(MATERIAL_COUNT);
    for (let t = D.tileStart[body]; t < D.tileStart[body] + D.tileCount[body]; t++) counts[D.tileMaterial[t]]++;
    const parts: string[] = [];
    for (let m = 1; m < MATERIAL_COUNT; m++) {
      if (counts[m] > 0) parts.push(`${counts[m]} ${MATERIAL_NAMES[m]} -> ${BIN_NAMES[MATERIAL_BIN[m]]}`);
    }
    hover += `\ndebris ${body}: ${D.tileCount[body]} tiles, mass ${D.body[body * BODY_STRIDE + B_MASS].toFixed(0)}\n  ${parts.join('\n  ')}`;
  }
  const S = world.salvage;
  const salvage =
    `\ncredits ${S.credits.toFixed(0)}  delivered ${S.deliveredTiles} tiles (${S.missortedTiles} missorted, -${S.missortLoss.toFixed(0)})` +
    `  torched -${S.destroyedValue.toFixed(0)}\ndebris ${D.count} bodies / ${D.tilesUsed} tiles`;
  // Contract status: the banner while it runs, the brief in the HUD.
  let job = '';
  const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (contract.state === ContractState.ACTIVE) {
    renderer.bannerTitle = `CONTRACT ${shipIndex + 1}/${fleet.length}  ${contract.shipName}  for ${contract.client}`;
    renderer.bannerSub = `${S.credits.toFixed(0)} / ${contract.quota} cr   ${mmss(contract.secondsLeft)} left   N: call it done   R: restart`;
    job = `\ncontract: ${contract.brief}`;
  } else if (contract.state !== ContractState.NONE) {
    const met = contract.state === ContractState.PASSED;
    renderer.bannerTitle =
      `${met ? 'CONTRACT MET' : 'CONTRACT FAILED'}  ${contract.shipName}: ` +
      `${contract.finalCredits.toFixed(0)} / ${contract.quota} cr   grade ${contract.grade}`;
    renderer.bannerSub = 'N: next ship   R: try again   M: demo';
  } else {
    renderer.bannerTitle = fleet.length > 0 ? 'Sandbox' : '';
    renderer.bannerSub = `N: take a salvage contract (${fleet.length} ships)   M: demo`;
  }
  const P = sim.pawns;
  let cutting = 0;
  let hauling = 0;
  let down = 0;
  let rescuing = 0;
  for (let p = 0; p < P.capacity; p++) {
    if (P.alive[p] === 0) continue;
    const st = P.state[p];
    if (st === PawnState.NAVIGATING || st === PawnState.PRE_CUT || st === PawnState.DISASSEMBLING) cutting++;
    if (st === PawnState.APPROACHING || st === PawnState.TUGGING || st === PawnState.RETURNING) hauling++;
    if (st === PawnState.DOWN) down++;
    if (st === PawnState.RESCUE_GO || st === PawnState.RESCUE_FLY || st === PawnState.RESCUE_CARRY) rescuing++;
  }
  let crew =
    `${job}\ncrew ${P.count} (${cutting} cutting, ${hauling} hauling, ${rescuing} rescuing, ${down} down)` +
    `  orders ${sim.orders.count}`;
  const sel = renderer.selectedPawn;
  if (sel >= 0 && P.alive[sel]) {
    const prio: string[] = [];
    for (let k = 0; k < JOB_KINDS; k++) {
      const v = P.jobPriority[sel * JOB_KINDS + k];
      prio.push(`${JOB_NAMES[k]} ${v === 0 ? 'off' : v}`);
    }
    crew +=
      `\npawn ${sel}: ${PAWN_STATE_NAMES[P.state[sel]]}  jobs ${prio.join(', ')} (C / H to change)` +
      `\n  health ${P.health[sel].toFixed(0)}  air ${P.oxygen[sel].toFixed(0)} s  suit ${P.suit[sel].toFixed(0)}%` +
      `\n  boots ${P.magBoot[sel] ? 'locked' : 'free'}  work ${P.progress[sel].toFixed(0)}%` +
      `  v (${P.vel[sel * 2].toFixed(2)}, ${P.vel[sel * 2 + 1].toFixed(2)})`;
  }
  const log = sim.hazards;
  for (let n = Math.max(0, log.count - 4); n < log.count; n++) {
    const i = log.at(n);
    crew += `\n  t${log.tick[i]} pawn ${log.pawn[i]} ${HAZARD_NAMES[log.kind[i]]} @ (${log.x[i]}, ${log.y[i]}) ${log.value[i].toFixed(2)}`;
  }
  hud.textContent =
    `BREAKER-YARD  tick ${world.tickCount} @ ${TICK_HZ} Hz  ${paused ? '[PAUSED]' : ''}\n` +
    `sim ${timing[LAST_TICK_MS].toFixed(2)} ms  gas ${g.totalMass().toFixed(1)}  vented ${g.vacuumAbsorbed.toFixed(1)}  toxin ${g.totalToxin().toFixed(1)}\n` +
    `nodes ${L.groundedCount} grounded / ${L.floatingCount} floating  snapped ${L.totalSnapped}` +
    `  solver ${L.converged ? 'converged' : 'relaxing'}` +
    salvage +
    hover +
    crew +
    (showHelp
      ? `\n\nLMB select pawn / grapple debris (drag to tow) / cut   Shift+LMB designate wall\n` +
        `Ctrl+drag salvage a block (crew cut it free and haul it)   RMB inject 10 bar   MMB anchor\n` +
        `P spawn pawn   C / H pawn's cut / haul priority   Esc deselect\n` +
        `Space+drag or WASD pan   wheel zoom   F fit   G gas   T stress\n` +
        `Enter pause   . step   R reset   N contract   M demo ${demo.active ? 'on' : 'off'}   0-${demo.sections.length} demo sections   ? hide help`
      : `\n\n? help   N contract   M demo   Ctrl+drag salvage`);
}, 250);
