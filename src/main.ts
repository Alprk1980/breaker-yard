import { DebugRenderer } from './render/DebugRenderer';
import { FixedTimestep } from './sim/FixedTimestep';
import { TICK_HZ } from './sim/constants';
import { HAZARD_NAMES } from './sim/HazardLog';
import { PAWN_STATE_NAMES } from './sim/PawnManager';
import { DEMO, buildDemoHull, seedDemoCrew, warmUpCrew, warmUpKernels } from './sim/scenes';
import { Simulation } from './sim/Simulation';
import { World } from './sim/World';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

warmUpKernels(new World());
// One short crew cycle: enough to get the hot pawn paths optimised without a long boot.
warmUpCrew(new Simulation(), 1, 200);
const sim = new Simulation();
const world = sim.world;
buildDemoHull(world);
seedDemoCrew(sim);
const renderer = new DebugRenderer(canvas, sim);
renderer.focus(DEMO.gantry.x - 1, DEMO.gantry.y0, DEMO.hull.x1, DEMO.gantry.y1);
const clock = new FixedTimestep();

let paused = false;
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
      const t0 = performance.now();
      sim.tick();
      timing[LAST_TICK_MS] = performance.now() - t0;
    }
  }
  renderer.render(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') paused = !paused;
  else if (e.code === 'KeyR') {
    buildDemoHull(world);
    sim.resetCrew();
    seedDemoCrew(sim);
  } else if (e.code === 'Period' && paused) sim.tick();
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
  const P = sim.pawns;
  let crew = `\ncrew ${P.count}  orders ${sim.orders.count}`;
  const sel = renderer.selectedPawn;
  if (sel >= 0 && P.alive[sel]) {
    crew +=
      `\npawn ${sel}: ${PAWN_STATE_NAMES[P.state[sel]]}  boots ${P.magBoot[sel] ? 'locked' : 'free'}` +
      `  work ${P.progress[sel].toFixed(0)}%  v (${P.vel[sel * 2].toFixed(2)}, ${P.vel[sel * 2 + 1].toFixed(2)})`;
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
    hover +
    crew +
    `\n\nLMB select pawn / cut   Shift+LMB designate wall   RMB inject 10 bar   MMB anchor\n` +
    `P spawn pawn   Esc deselect   Space+drag or WASD pan   wheel zoom   F fit\n` +
    `G gas   T stress   Enter pause   . step   R reset`;
}, 250);
