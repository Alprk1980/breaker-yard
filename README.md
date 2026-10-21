# Breaker-Yard

Systemic 2D orbital salvage simulator (TypeScript + Vite + Canvas 2D). Project rules live in `CLAUDE.md`.

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests, including the zero-allocation tick check
npm run build      # strict typecheck + production bundle
```

## Phase 1 layout

| File | What it does |
| --- | --- |
| `src/sim/GasGrid.ts` | 128x128 double-buffered pressure field, explicit Laplacian diffusion, wall/vacuum boundaries, `getVentImpulse` |
| `src/sim/StressLattice.ts` | Typed-array load graph over girder tiles, SOR relaxation of load to anchors, snapping over `breakThreshold` |
| `src/sim/World.ts` | Tile map (`TileFlags`) that keeps the gas and stress layers in sync; 20 Hz `tick()` |
| `src/sim/scenes.ts` | Demo hull: pressurised room hung off a docking gantry; JIT warm-up |
| `src/render/DebugRenderer.ts` | Gas ramp, stress overlay, pan/zoom camera, mouse tools |

## Controls

| Input | Action |
| --- | --- |
| Left click / drag | Cut tile (wall or girder becomes floor, floor becomes vacuum) |
| Right click / hold | Inject 10 bar of gas |
| Middle click | Toggle dock anchor on a girder |
| Shift or Space + drag, WASD / arrows | Pan |
| Wheel | Zoom at cursor |
| F | Fit whole grid |
| G / T | Toggle gas / stress layers |
| P, `.` | Pause, single-step while paused |
| R | Reset the demo hull |

## Models in brief

**Gas.** Each tick runs 8 substeps of `p' = p + k * sum(p_n - p)` with `k = 0.24` (stable below 0.25). Walls are zero-flux, vacuum is pinned at 0 bar, and gas drained into vacuum is tallied in `vacuumAbsorbed`, so `totalMass() + vacuumAbsorbed` is conserved.

**Stress.** Each girder's mass has to reach an anchor. The solver finds a load potential with anchors at 0 (`deg * phi - sum(phi_n) = mass`), and an edge carries `phi_a - phi_b`. A cantilever segment therefore carries exactly the mass beyond it, and parallel members share load. Nodes cut off from every anchor are marked floating. Thresholds are only checked once the solve has converged, so a half-relaxed solution never snaps members.
