# Project: Breaker-Yard (Orbital Salvage Simulator)

A systemic 2D orbital salvage simulation built in TypeScript, Vite, and HTML5 Canvas.
Core inspiration: *Hardspace: Shipbreaker* meets *RimWorld* priority automation.

## Core Architectural Invariants

1. **Separation of Physics and Topology:**
   - **Gas/Hazard Layer:** Eulerian flat array (`Uint8Array`, `Float32Array`). Double-buffered. Never allocate objects per-cell inside tick loops.
   - **Structural Stress Layer:** Node-edge graph representing load-bearing members. Solved via iterative Gauss-Seidel / Jacobi relaxation.
   - **Pawn Layer:** State machines querying the grid/stress layers via spatial indexes; pawns do NOT own grid cells.

2. **Zero-Garbage Collection in Inner Loops:**
   - No `new Object()`, `Array.map`, or dynamic closures inside `tick()` or `render()`.
   - Pre-allocate scratch vectors, typed arrays, and reusable buffers during init.

3. **Coordinate Systems & Resolution:**
   - Grid: Uniform $128 \times 128$ Cartesian grid. Index formula: `idx = y * WIDTH + x`.
   - Tick rate: Fixed timestep at 20 Hz (50ms). Render loop decoupled via `requestAnimationFrame`.

4. **Tech Stack Constraints:**
   - TypeScript (strict mode, `noImplicitAny: true`).
   - Vanilla Canvas 2D or lightweight WebGL context (avoid heavy engine overhead during core loop prototyping).
   - Bundler: Vite.
   - Zero runtime dependencies for math and physics kernels.

## System Interfaces & Data Schemas

- `TileFlags`: Bitmask (0x01: Vacuum/Void, 0x02: Interior Floor, 0x04: Solid Bulkhead, 0x08: Load-Bearing Girder, 0x10: Hazard Leak).
- `GasBuffer`: Interleaved `Float32Array` or twin buffers (`pressureBufferA`, `pressureBufferB`).
- `StressGraph`: Fixed-size arrays: `nodeMass: Float32Array`, `nodeStress: Float32Array`, `edgeAdjacency: Int32Array`.

## Coding Style & Execution Rules
- Lead with implementation code; do not stub empty methods.
- Write unit tests for the stress relaxation solver and diffusion conservation of mass.
- When modifying code, keep changes minimal and surgical.
- Keep the demo current: every feature that lands gets a demo section in `src/sim/DemoDirector.ts` (or a beat in an
  existing one) and a test in `DemoDirector.test.ts` that the section reaches its outcome when played on its own.
  Sections must stay standalone (`?demo=<id>`, keys 1-n), so each one's `setup` builds the state it needs.
