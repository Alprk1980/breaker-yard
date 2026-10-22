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
| `src/sim/GasGrid.ts` | 128x128 double-buffered pressure field, pressure-driven face flux plus explicit Laplacian diffusion, wall/vacuum boundaries, `getVentImpulse` |
| `src/sim/StressLattice.ts` | Typed-array load graph over girder tiles, SOR relaxation of load to anchors, snapping over `breakThreshold` |
| `src/sim/World.ts` | Tile map (`TileFlags`) that keeps the gas and stress layers in sync; 20 Hz `tick()` |
| `src/sim/scenes.ts` | Demo hull: pressurised room hung off a docking gantry; JIT warm-up |
| `src/render/DebugRenderer.ts` | Gas ramp, stress overlay, pan/zoom camera, mouse tools; pawns, routes and work orders |

## Phase 2 layout

| File | What it does |
| --- | --- |
| `src/sim/PathGrid.ts` | `updateCostGrid(gas, lattice)` writes a 128x128 `Uint16Array` of traversal costs; allocation-free 8-way A* over a typed-array node pool |
| `src/sim/PawnManager.ts` | Struct-of-arrays pool of 32 pawns; IDLE / NAVIGATING / PRE_CUT / DISASSEMBLING / FLEEING state machine; drag, magboots, thrusters |
| `src/sim/WorkOrderQueue.ts` | Fixed pool of salvage orders (tile, priority, tool); `addOrder`, `cancelOrder`, `claimNextOrder` |
| `src/sim/HazardLog.ts` | Ring buffer of hazard events (refused cuts, decompression, adrift) written from the tick loop |
| `src/sim/Simulation.ts` | One 20 Hz tick: world, cost grid, orders, pawns |

## Controls

| Input | Action |
| --- | --- |
| Left click on a pawn | Select it and show its route |
| Left click / drag elsewhere | Cut tile (wall or girder becomes floor, floor becomes vacuum) |
| Shift + left click / drag | Designate walls for deconstruction; again on an order cancels it |
| P | Spawn a pawn at the cursor |
| Esc | Deselect |
| Right click / hold | Inject 10 bar of gas |
| Middle click | Toggle dock anchor on a girder |
| Space + drag, WASD / arrows | Pan |
| Wheel | Zoom at cursor |
| F | Fit whole grid |
| G / T | Toggle gas / stress layers |
| Enter, `.` | Pause, single-step while paused |
| R | Reset the demo hull |

## Models in brief

**Gas.** Each tick first runs 8 flow substeps: every open face carries a signed flux (`flowX`, `flowY`) that keeps 90% of its momentum and gains 0.25 per bar of pressure difference across the face, and a limiter stops any cell giving away more gas than it holds. Then it runs 8 diffusion substeps of `p' = p + k * sum(p_n - p)` with `k = 0.24` (stable below 0.25). Walls are zero-flux, vacuum is pinned at 0 bar and only receives, and gas drained into vacuum is tallied in `vacuumAbsorbed`, so `totalMass() + vacuumAbsorbed` is conserved. A one-tile breach empties about 40% of the 1 bar demo room in 5 s and nearly all of it in 35 s. The flow gain and damping are clamped where the flow + diffusion tick stays stable; past them (for example 95% momentum) a sealed room slowly rings up from float rounding.

**Vent impulse.** `getVentImpulse` is the negative pressure gradient plus the gas stream through the cell (0.5 per bar of flux per tick). At a 1 bar breach it reads about 2.2 bar/tile in the hole, 1.5 one tile in and 0.6 two tiles in, so magboots slip near the hole; the jet just outside reads about 1.9, which overpowers an adrift pawn's thrusters and carries it away from the hull. Pawn speed is capped at 15 tiles/s per axis so a hard blowout cannot tunnel a pawn through a wall.

**Stress.** Each girder's mass has to reach an anchor. The solver finds a load potential with anchors at 0 (`deg * phi - sum(phi_n) = mass`), and an edge carries `phi_a - phi_b`. A cantilever segment therefore carries exactly the mass beyond it, and parallel members share load. Nodes cut off from every anchor are marked floating. Thresholds are only checked once the solve has converged, so a half-relaxed solution never snaps members.

**Toxic gas.** `GasGrid.toxin` is a toxic partial pressure that rides inside the bulk gas: diffusion runs it through the same kernel, and flow carries it upwind as the donor cell's toxic share of each face flux, so it vents with the gas and is conserved the same way (`totalToxin() + toxinVented`). `HAZARD_LEAK` tiles now emit toxic gas.

**Path costs.** Walls and vacuum are 0xFFFF. Floor costs 10, plus 40 per bar of local pressure differential (max minus min over the cell and its open or vacuum neighbours), plus 400 per bar of toxin, plus 100 to 600 on the 3x3 block around any member above 80% utilisation.

**Pawns.** A pawn claims the highest-priority, nearest order its tools cover, walks to a tile next to the wall, and scans it for 0.5 s (PRE_CUT). If the wall is holding back more than 2.0 bar (`GasGrid.getPressureDelta`) the cut is refused, logged, and the order is suspended for 10 s. While cutting, the torch softens a girder's members (up to half their capacity) and the pawn keeps re-checking the differential; at 100% the tile becomes floor and its stress node is removed. Vent impulse drags pawns; locked magboots absorb up to 6 tiles/s² of it. A pawn that spends 3 ticks in a stream above 0.15 bar/tile, or is knocked off the floor, drops its work and flees to a floor tile braced against a wall, away from the stream, where it clamps until things are calm. Adrift pawns thrust back to the nearest floor.

**Zero allocation.** All float maths in the pawn tick lives in `tickPawn`, which runs for every pawn every tick and so stays optimised; the per-state functions are integer-only, because they are cold enough to run in V8's interpreter, where double arithmetic allocates. Doubles cross calls through a `Float64Array` rather than as arguments. `alloc.test.ts` checks the world tick sealed, venting, snapping and venting toxin, and the full simulation tick with pawns working, refusing and fleeing.

