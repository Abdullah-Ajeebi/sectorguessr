# SectorGuessr

**GeoGuessr for Mindustry!** Drops you onto a random campaign sector in crisp GPU-baked HD terrain view, then challenges you to pinpoint its exact hex on the 3D planet globe.

Pure JavaScript client-side mod (`hidden: true`) — works alongside your campaign without touching your saves or blocking multiplayer servers.

## Features
- **4 Sector Pools:**
  - **Serpulo Presets** — Named & curated Serpulo campaign sectors
  - **Erekir Presets** — All Erekir campaign sectors (with 3×3 steam vents, cliffs, and wall ores)
  - **Serpulo + Erekir** — Mixed named sectors across both planets (with planet switcher on the globe)
  - **All Serpulo (270+)** — Every Serpulo hex, including procedural numbered sectors
- **3 Movement Modes:**
  - **Move & Zoom** — Pan within ±22 tiles of your drop point and zoom
  - **No Move** — Pan locked to drop point, zoom allowed
  - **NMPZ** — No Move, No Pan, No Zoom (pure hardcore snapshot)
- **Extra Options:** `3 / 5 / 10` rounds, **Hide Buildings (Pure Terrain)** toggle, and saved Personal Bests per pool/mode.
- **Spoiler-Free 3D Globe & Reveal:** No sector names, icons, or campaign capture overlays while guessing. Lock in your pin to watch the camera orbit to a glowing 3D geodesic arc with hex distance, spherical angle, `0–5,000` GeoGuessr scoring, and a post-reveal **Inspect Terrain** toggle.
- **100% Save-Safe:** Reads stock campaign `.msav` maps or generates procedural sectors inside an isolated sandbox — your own bases never spoil a sector and your saves are never modified.

## Controls
- **Terrain View:** Drag or `WASD` / Arrow keys to pan, Mouse Wheel to zoom, `R` to recenter, `M` or `Tab` to open the 3D Planet Map.
- **3D Planet Map:** Drag to orbit, Mouse Wheel to zoom, Click a hex to pin, Double-click or `Space` / `Enter` to lock in your guess.
- **Reveal:** `Space` / `Enter` for next round, `M` / `Tab` to inspect terrain.

## Installation
Install directly from the in-game **Mindustry Mod Browser**, or download this repository as a `.zip` and import it via **Mods → Import Mod**.
