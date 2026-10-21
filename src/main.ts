import { DebugRenderer } from './render/DebugRenderer';
import { FixedTimestep } from './sim/FixedTimestep';
import { TICK_HZ } from './sim/constants';
import { DEMO, buildDemoHull, warmUpKernels } from './sim/scenes';
import { World } from './sim/World';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

warmUpKernels(new World());
const world = new World();
buildDemoHull(world);
const renderer = new DebugRenderer(canvas, world);
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
      world.tick();
      timing[LAST_TICK_MS] = performance.now() - t0;
    }
  }
  renderer.render(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyP') paused = !paused;
  else if (e.code === 'KeyR') buildDemoHull(world);
  else if (e.code === 'Period' && paused) world.tick();
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
      `\ntile (${hx}, ${hy})  p ${g.getPressure(hx, hy).toFixed(2)} bar` +
      `  vent (${v.x.toFixed(2)}, ${v.y.toFixed(2)})` +
      (L.nodeActive[n] ? `\nnode stress ${(L.nodeStress[n] * 100).toFixed(0)}%${L.isAnchor[n] ? '  [anchor]' : ''}` : '');
  }
  hud.textContent =
    `BREAKER-YARD  tick ${world.tickCount} @ ${TICK_HZ} Hz  ${paused ? '[PAUSED]' : ''}\n` +
    `sim ${timing[LAST_TICK_MS].toFixed(2)} ms  gas ${g.totalMass().toFixed(1)}  vented ${g.vacuumAbsorbed.toFixed(1)}\n` +
    `nodes ${L.groundedCount} grounded / ${L.floatingCount} floating  snapped ${L.totalSnapped}` +
    `  solver ${L.converged ? 'converged' : 'relaxing'}` +
    hover +
    `\n\nLMB cut   RMB inject 10 bar   MMB anchor\nShift/Space+drag or WASD pan   wheel zoom   F fit\nG gas   T stress   P pause   . step   R reset`;
}, 250);
