// SectorGuessr - GeoGuessr for Mindustry (v1.0)
// Pure Rhino JS mod: offline HD sector terrain renderer + 3D planet hex guessing & geodesic reveal arc.

(function () {
    "use strict";

    var InflaterInputStream = Packages.java.util.zip.InflaterInputStream;
    var DataInputStream = Packages.java.io.DataInputStream;
    var JClass = Packages.java.lang.Class;
    var JArray = Packages.java.lang.reflect.Array;

    var WorldParams = Packages.mindustry.world.WorldParams;
    var HAS_WORLD_PARAMS = (typeof WorldParams === "function");
    var SaveReadStateCls = Packages.mindustry.io.SaveReadState;
    var HAS_SAVE_READ_STATE = (typeof SaveReadStateCls === "function");
    var WorldContext = Packages.mindustry.world.WorldContext;
    var GameStateEnum = Packages.mindustry.core.GameState.State;
    var IORunner = Packages.mindustry.io.SaveFileReader.IORunner;
    var PlanetInterfaceRenderer = Packages.mindustry.graphics.g3d.PlanetRenderer.PlanetInterfaceRenderer;
    var SteamVent = Packages.mindustry.world.blocks.environment.SteamVent;
    var StaticWall = Packages.mindustry.world.blocks.environment.StaticWall;
    var TreeBlock = Packages.mindustry.world.blocks.environment.TreeBlock;
    var TallBlock = Packages.mindustry.world.blocks.environment.TallBlock;

    var PAN_RADIUS = 22.0;
    var MIN_ZOOM_MOVE = 0.55;
    var MAX_ZOOM_MOVE = 2.4;
    var MIN_ZOOM_NM = 0.65;
    var MAX_ZOOM_NM = 2.2;
    var BASE_TILE_PX = 32.0;

    // Reusable colors (zero per-frame allocations)
    var COL_ACTUAL = Color.valueOf("44ff77");
    var COL_GUESS = Color.valueOf("ff6038");
    var COL_GOLD = Color.valueOf("ffd37f");
    var COL_PIN = Color.valueOf("66d9ff");
    var COL_DARK_BG = Color.valueOf("0b0d12");
    var COL_TMP1 = new Color();
    var COL_TMP2 = new Color();
    var COL_TMP3 = new Color();
    var VEC_TMP1 = new Vec3();
    var VEC_TMP2 = new Vec3();
    var VEC_TMP3 = new Vec3();
    var SAVED_PROJ = new Mat();
    var SAVED_TRANS = new Mat();

    var terrainFbo = null;
    var fboState = {
        dirty: true,
        minX: 0,
        maxX: -1,
        minY: 0,
        maxY: -1,
        bakePx: 24,
        hideBuildings: false
    };
    var blockMetaCache = {};
    var planetDimSectors = [];
    var planetCandidateSectors = [];

    var POOLS = [
        { id: "serpulo-presets", name: "Serpulo Presets", desc: "All named Serpulo campaign sectors." },
        { id: "erekir-presets", name: "Erekir Presets", desc: "All named Erekir campaign sectors." },
        { id: "both-presets", name: "Serpulo + Erekir", desc: "Mixed named sectors across both planets." },
        { id: "serpulo-all", name: "All Serpulo (270+)", desc: "Every Serpulo hex, including procedural numbered sectors." }
    ];

    var MODES = [
        { id: "move", name: "Move & Zoom", desc: "Pan within \u00B122 tiles of your drop point + zoom." },
        { id: "nm", name: "No Move", desc: "Locked to drop point, zoom allowed." },
        { id: "nmpz", name: "NMPZ", desc: "No Move, No Pan, No Zoom. Pure hardcore snapshot." }
    ];

    var ROUND_COUNTS = [3, 5, 10];

    var cfg = {
        pool: "serpulo-presets",
        mode: "move",
        rounds: 5,
        hideBuildings: false
    };

    var game = {
        active: false,
        pool: "serpulo-presets",
        mode: "move",
        totalRounds: 5,
        hideBuildings: false,
        poolSectors: [],
        poolSectorSet: {},
        roundSectors: [],
        roundIdx: 0,
        results: [],
        totalScore: 0,
        phase: "terrain", // "terrain" | "planet" | "reveal" | "reveal-terrain"
        snap: null,
        dropX: 0,
        dropY: 0,
        camX: 0,
        camY: 0,
        terrainZoom: 1.0,
        hoveredSector: null,
        pinnedSector: null,
        revealTarget: null,
        revealLerp: 0,
        returnToPlanet: false,
        loadError: null
    };

    var planetParams = null;
    var planetZoom = 1.0;
    var setupDialog = null;
    var gameDialog = null;
    var summaryDialog = null;
    var bottomBarHolder = null;
    var terrainElement = null;
    var planetElement = null;
    var planetButtonInjected = false;

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function tileHash(x, y) {
        var h = (((x | 0) * 73856093) ^ ((y | 0) * 19349663)) | 0;
        h = (h ^ (h >>> 13)) | 0;
        h = ((h * 1597334677) ^ (h >>> 16)) | 0;
        return h & 0x7fffffff;
    }

    function formatNumber(n) {
        var s = String(Math.round(n));
        var out = "";
        var count = 0;
        for (var i = s.length - 1; i >= 0; i--) {
            if (count > 0 && count % 3 === 0 && s.charAt(i) !== "-") {
                out = "," + out;
            }
            out = s.charAt(i) + out;
            count++;
        }
        return out;
    }

    function clamp(v, lo, hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    function colAlpha(dst, src, alpha) {
        dst.set(src);
        dst.a = alpha;
        return dst;
    }

    function sectorKey(sec) {
        return sec.planet.name + ":" + sec.id;
    }

    function formatPresetLabel(sec) {
        if (sec.preset == null || !sec.preset.localizedName) return null;
        var raw = String(sec.preset.localizedName);
        // Clean up unnamed v8 curated preset IDs like "sector-serpulo-180"
        if (/^sector-[a-z0-9_-]+-\d+$/i.test(raw)) {
            return sec.planet.localizedName + " Sector #" + sec.id;
        }
        return raw;
    }

    function sectorDisplayName(sec) {
        if (!sec) return "None";
        var pname = formatPresetLabel(sec);
        if (pname != null && pname.indexOf("Sector #") === -1) {
            return pname + " [lightgray](#" + sec.id + ")[]";
        }
        return sec.planet.localizedName + " Sector #" + sec.id;
    }

    function sectorShortName(sec) {
        if (!sec) return "None";
        var pname = formatPresetLabel(sec);
        if (pname != null && pname.indexOf("Sector #") === -1) {
            return pname;
        }
        return sec.planet.localizedName + " #" + sec.id;
    }

    function poolInfo(id) {
        for (var i = 0; i < POOLS.length; i++) {
            if (POOLS[i].id === id) return POOLS[i];
        }
        return POOLS[0];
    }

    function modeInfo(id) {
        for (var i = 0; i < MODES.length; i++) {
            if (MODES[i].id === id) return MODES[i];
        }
        return MODES[0];
    }

    function pbKey(poolId, modeId, rounds) {
        return "sectorguessr-pb-" + poolId + "-" + modeId + "-" + rounds;
    }

    function getBestScore(poolId, modeId, rounds) {
        var raw = Core.settings.getString(pbKey(poolId, modeId, rounds), "-1");
        var parsed = parseInt(raw, 10);
        return isNaN(parsed) ? -1 : parsed;
    }

    function saveBestScore(poolId, modeId, rounds, score) {
        var prev = getBestScore(poolId, modeId, rounds);
        var rounded = Math.round(score);
        if (rounded > prev) {
            Core.settings.put(pbKey(poolId, modeId, rounds), String(rounded));
            return true;
        }
        return false;
    }

    function collectPoolSectors(poolId) {
        var list = [];
        var addPresets = function (planet) {
            if (!planet || !planet.sectors) return;
            for (var i = 0; i < planet.sectors.size; i++) {
                var sec = planet.sectors.get(i);
                if (sec.preset != null && sec.preset.generator != null && sec.preset.generator.map != null && sec.preset.generator.map.file != null) {
                    list.push(sec);
                }
            }
        };

        if (poolId === "serpulo-presets") {
            addPresets(Planets.serpulo);
        } else if (poolId === "erekir-presets") {
            addPresets(Planets.erekir);
        } else if (poolId === "both-presets") {
            addPresets(Planets.serpulo);
            addPresets(Planets.erekir);
        } else if (poolId === "serpulo-all") {
            var p = Planets.serpulo;
            if (p && p.sectors) {
                for (var i = 0; i < p.sectors.size; i++) {
                    list.push(p.sectors.get(i));
                }
            }
        }
        return list;
    }

    function shuffleCopy(arr) {
        var copy = arr.slice();
        for (var i = copy.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = copy[i];
            copy[i] = copy[j];
            copy[j] = tmp;
        }
        return copy;
    }

    function isPresetOnlyPool(poolId) {
        return poolId !== "serpulo-all";
    }

    function isValidGuessSector(sec) {
        if (!sec) return false;
        if (!isPresetOnlyPool(game.pool)) return sec.planet == Planets.serpulo;
        return !!game.poolSectorSet[sectorKey(sec)];
    }

    // -------------------------------------------------------------------------
    // Offline Save-Safe Sector Snapshot Loader
    // -------------------------------------------------------------------------

    function readPreviewContentHeader(inp) {
        var mapped = inp.readUnsignedByte();
        var mcClass = JClass.forName("mindustry.ctype.MappableContent");
        var mcArrClass = JArray.newInstance(mcClass, 0).getClass();
        var allTypes = ContentType.all;
        var map = JArray.newInstance(mcArrClass, allTypes.length);
        for (var t = 0; t < allTypes.length; t++) {
            map[t] = JArray.newInstance(mcClass, 0);
        }
        for (var i = 0; i < mapped; i++) {
            var type = allTypes[inp.readByte()];
            var total = inp.readShort();
            var arr = JArray.newInstance(mcClass, total);
            var isBlock = (type == ContentType.block);
            for (var j = 0; j < total; j++) {
                var name = inp.readUTF();
                var resolved = isBlock ? SaveFileReader.fallback.get(name, name) : name;
                arr[j] = Vars.content.getByName(type, resolved);
            }
            map[type.ordinal()] = arr;
        }
        Vars.content.setTemporaryMapper(map);
    }

    function computeDarkness(w, h, solidMask) {
        // Computes 0..4 rock depth for solid non-synthetic walls (authentic Mindustry cave darkness)
        var len = w * h;
        var cur = new Array(len);
        var next = new Array(len);
        for (var i = 0; i < len; i++) {
            cur[i] = solidMask[i] ? 5 : 0;
            next[i] = 0;
        }
        for (var step = 0; step < 4; step++) {
            for (var y = 0; y < h; y++) {
                var row = y * w;
                for (var x = 0; x < w; x++) {
                    var idx = row + x;
                    if (!solidMask[idx]) {
                        next[idx] = 0;
                        continue;
                    }
                    var m = 5;
                    if (x > 0 && cur[idx - 1] < m) m = cur[idx - 1];
                    if (x < w - 1 && cur[idx + 1] < m) m = cur[idx + 1];
                    if (y > 0 && cur[idx - w] < m) m = cur[idx - w];
                    if (y < h - 1 && cur[idx + w] < m) m = cur[idx + w];
                    var val = m + 1;
                    if (val > 5) val = 5;
                    next[idx] = val;
                }
            }
            var tmp = cur;
            cur = next;
            next = tmp;
        }
        // Convert distance (1 = wall edge, 2..5 = deeper rock) to darkness level 0..4
        for (var k = 0; k < len; k++) {
            cur[k] = cur[k] > 1 ? (cur[k] - 1) : 0;
        }
        return cur;
    }

    function extractSnapshot(tiles, skipShardedCore) {
        var w = tiles.width;
        var h = tiles.height;
        var len = w * h;

        var floors = new Array(len);
        var overlays = new Array(len);
        var blocks = new Array(len);
        var data = new Array(len);
        var solidMask = new Array(len);
        var buildings = [];

        for (var y = 0; y < h; y++) {
            var row = y * w;
            for (var x = 0; x < w; x++) {
                var idx = row + x;
                var t = tiles.getn(x, y);
                var fl = t.floor();
                var ov = t.overlay();
                var bl = t.block();

                floors[idx] = fl != null ? fl : Blocks.stone;
                overlays[idx] = (ov != null && ov != Blocks.air) ? ov : null;
                data[idx] = t.data & 0xff;
                solidMask[idx] = 0;

                if (bl != null && bl != Blocks.air) {
                    if (t.build != null || bl.hasBuilding()) {
                        blocks[idx] = null;
                        if (t.isCenter()) {
                            var team = t.build != null ? t.build.team : Team.derelict;
                            if (skipShardedCore && team == Team.sharded) {
                                // Hide synthetic starter launch loadout placed on procedural sectors
                            } else {
                                buildings.push({
                                    x: x,
                                    y: y,
                                    block: bl,
                                    team: team,
                                    rot: t.build != null ? (t.build.rotation & 3) : 0
                                });
                            }
                        }
                    } else {
                        blocks[idx] = bl;
                        if (bl.solid && bl.fillsTile && !bl.synthetic()) {
                            solidMask[idx] = 1;
                        }
                    }
                } else {
                    blocks[idx] = null;
                }
            }
        }

        // Precompute 3x3 SteamVent top-right anchor flags for fast draw pass
        var ventAnchors = [];
        for (var vy = 2; vy < h; vy++) {
            for (var vx = 2; vx < w; vx++) {
                var vf = floors[vy * w + vx];
                if (vf instanceof SteamVent) {
                    var ok = true;
                    for (var dy = -2; dy <= 0 && ok; dy++) {
                        for (var dx = -2; dx <= 0; dx++) {
                            if (floors[(vy + dy) * w + (vx + dx)] != vf) {
                                ok = false;
                                break;
                            }
                        }
                    }
                    if (ok) {
                        ventAnchors.push({ x: vx, y: vy, floor: vf });
                    }
                }
            }
        }

        return {
            w: w,
            h: h,
            floors: floors,
            overlays: overlays,
            blocks: blocks,
            data: data,
            darkness: computeDarkness(w, h, solidMask),
            buildings: buildings,
            ventAnchors: ventAnchors
        };
    }

    function runInWorldSandbox(fn) {
        var origTiles = Vars.world.tiles;
        var origRules = Vars.state.rules;
        var origTeams = Vars.state.teams;
        var origGen = Vars.world.isGenerating();
        try {
            var fakeRules = new Rules();
            fakeRules.editor = true;
            Vars.state.rules = fakeRules;
            Vars.state.teams = new Teams();
            Vars.world.setGenerating(true);
            return fn(fakeRules);
        } finally {
            Vars.content.setTemporaryMapper(null);
            Vars.world.tiles = origTiles;
            Vars.state.rules = origRules;
            Vars.state.teams = origTeams;
            Vars.world.setGenerating(origGen);
        }
    }

    function loadPresetSnapshot(sector) {
        var mapFile = sector.preset.generator.map.file;
        return runInWorldSandbox(function () {
            var is = new InflaterInputStream(mapFile.read(8192));
            var counter = new CounterInputStream(is);
            var stream = new DataInputStream(counter);
            try {
                SaveIO.readHeader(stream);
                var version = stream.readInt();
                var ver = SaveIO.getSaveWriter(version);
                if (ver == null) {
                    throw new Error("Unsupported map save version: " + version);
                }

                ver.readRegion("meta", stream, counter, new IORunner({
                    accept: function (inp) {
                        ver.readStringMap(inp);
                    }
                }));

                if (ver.version >= 12) {
                    ver.skipChunk(stream);
                }

                ver.readRegion("content", stream, counter, new IORunner({
                    accept: function (inp) {
                        readPreviewContentHeader(inp);
                    }
                }));

                if (ver.version == 11) {
                    ver.skipChunk(stream);
                }

                var tempTiles = null;
                var ctx = new WorldContext({
                    resize: function (w, h) {
                        tempTiles = new Tiles(w, h);
                        Vars.world.tiles = tempTiles;
                    },
                    tile: function (index) {
                        return tempTiles.geti(index);
                    },
                    create: function (x, y, floorID, overlayID, wallID) {
                        var t = new Tile(x, y);
                        var fl = Vars.content.block(floorID);
                        var ov = Vars.content.block(overlayID);
                        if (fl != null && fl != Blocks.air) {
                            t.setFloor(fl.asFloor());
                        } else {
                            t.setFloor(Blocks.stone.asFloor());
                        }
                        if (ov != null && ov != Blocks.air) {
                            t.setOverlayQuiet(ov);
                        }
                        tempTiles.set(x, y, t);
                        return t;
                    },
                    isGenerating: function () { return true; },
                    begin: function () {},
                    end: function () {},
                    onReadBuilding: function () {},
                    onReadTileData: function () {},
                    getSector: function () { return null; },
                    isMap: function () { return true; }
                });

                ver.readRegion("preview_map", stream, counter, new IORunner({
                    accept: function (inp) {
                        if (HAS_SAVE_READ_STATE) {
                            var readState = new SaveReadStateCls(ctx);
                            readState.preview = true;
                            ver.readMap(inp, readState);
                        } else {
                            ver.readMap(inp, ctx);
                        }
                    }
                }));

                if (tempTiles == null) {
                    throw new Error("Failed to read preview_map region");
                }
                return extractSnapshot(tempTiles, false);
            } finally {
                try { stream.close(); } catch (e) {}
            }
        });
    }

    function loadProceduralSnapshot(sector) {
        var planet = sector.planet;
        var gen = planet.generator;
        if (gen == null) {
            throw new Error("Planet has no procedural generator: " + planet.name);
        }
        return runInWorldSandbox(function (fakeRules) {
            var fakeSector = new Sector(planet, sector.tile);
            fakeSector.generateEnemyBase = sector.generateEnemyBase;
            fakeSector.threat = sector.threat;
            fakeSector.info = new SectorInfo();
            fakeRules.sector = fakeSector;

            var size = gen.getSectorSize(fakeSector);
            if (size < 64) size = 64;
            if (size > 320) size = 320;
            var tempTiles = new Tiles(size, size);
            Vars.world.tiles = tempTiles;

            if (HAS_WORLD_PARAMS) {
                var params = new WorldParams();
                params.saveInfo = false;
                gen.generate(tempTiles, fakeSector, params);
            } else {
                gen.generate(tempTiles, fakeSector, 0);
            }
            return extractSnapshot(tempTiles, true);
        });
    }

    function loadSectorSnapshot(sector) {
        if (sector.preset != null && sector.preset.generator != null && sector.preset.generator.map != null && sector.preset.generator.map.file != null) {
            return loadPresetSnapshot(sector);
        }
        return loadProceduralSnapshot(sector);
    }

    function pickDropPoint(snap) {
        var w = snap.w;
        var h = snap.h;
        var margin = Math.min(26, Math.max(10, Math.floor(Math.min(w, h) * 0.14)));
        if (w <= margin * 2 + 4) margin = Math.floor(w * 0.25);
        if (h <= margin * 2 + 4) margin = Math.floor(h * 0.25);

        // Quick spatial lookup of buildings
        var bldMap = {};
        for (var bi = 0; bi < snap.buildings.length; bi++) {
            var b = snap.buildings[bi];
            bldMap[(b.y >> 2) + "," + (b.x >> 2)] = true;
        }

        var candidates = [];
        var samples = 55;
        for (var s = 0; s < samples; s++) {
            var cx = margin + Math.floor(Math.random() * Math.max(1, w - margin * 2));
            var cy = margin + Math.floor(Math.random() * Math.max(1, h - margin * 2));

            var openCount = 0;
            var wallCount = 0;
            var darkCount = 0;
            var oreCount = 0;
            var liqCount = 0;
            var cliffCount = 0;
            var bldHits = 0;
            var uniqueFloors = {};
            var uniqueFloorCount = 0;
            var total = 0;

            for (var dy = -9; dy <= 9; dy += 2) {
                var ty = cy + dy;
                if (ty < 0 || ty >= h) continue;
                var row = ty * w;
                for (var dx = -9; dx <= 9; dx += 2) {
                    var tx = cx + dx;
                    if (tx < 0 || tx >= w) continue;
                    var idx = row + tx;
                    total++;

                    var fl = snap.floors[idx];
                    var ov = snap.overlays[idx];
                    var bl = snap.blocks[idx];

                    if (fl != null) {
                        if (!uniqueFloors[fl.id]) {
                            uniqueFloors[fl.id] = true;
                            uniqueFloorCount++;
                        }
                        if (fl.isLiquid) liqCount++;
                    }
                    if (ov != null) oreCount++;
                    if (bl != null) {
                        wallCount++;
                        if (bl == Blocks.cliff) cliffCount++;
                    } else {
                        openCount++;
                    }
                    if (snap.darkness[idx] >= 2) darkCount++;
                }
            }

            if (total === 0) continue;
            var openRatio = openCount / total;
            var darkRatio = darkCount / total;

            for (var by = -2; by <= 2; by++) {
                for (var bx = -2; bx <= 2; bx++) {
                    if (bldMap[((cy >> 2) + by) + "," + ((cx >> 2) + bx)]) bldHits++;
                }
            }

            var score = 0;
            // Reject buried-in-rock spots
            if (openRatio < 0.18 || darkRatio > 0.65) {
                score -= 100;
            } else {
                // Sweet spot: 35% - 88% open floor so you see both ground and walls/landmarks
                var idealDiff = Math.abs(openRatio - 0.62);
                score += (1.0 - idealDiff) * 35.0;
            }
            score += Math.min(uniqueFloorCount, 5) * 6.5;
            score += Math.min(oreCount, 12) * 1.4;
            score += Math.min(liqCount, 14) * 1.1;
            score += Math.min(cliffCount, 10) * 1.6;
            if (!game.hideBuildings && bldHits > 0) {
                score += Math.min(bldHits, 4) * 4.5;
            }
            // Slight bonus for having some wall geometry nearby rather than 100% flat void
            if (wallCount >= 4 && wallCount <= total * 0.65) {
                score += 8.0;
            }
            // Never drop directly inside a deep solid wall center
            var centerIdx = cy * w + cx;
            if (snap.blocks[centerIdx] != null && snap.darkness[centerIdx] >= 1) {
                score -= 25.0;
            }

            candidates.push({ x: cx + 0.5, y: cy + 0.5, score: score });
        }

        if (candidates.length === 0) {
            return { x: w * 0.5, y: h * 0.5 };
        }
        candidates.sort(function (a, b) { return b.score - a.score; });
        var pickPool = Math.min(4, candidates.length);
        var chosen = candidates[Math.floor(Math.random() * pickPool)];
        return { x: chosen.x, y: chosen.y };
    }

    // -------------------------------------------------------------------------
    // HD Terrain Renderer (GPU FrameBuffer Baked — 1 Draw Call Per Frame!)
    // -------------------------------------------------------------------------

    function getBlockMeta(block) {
        if (block == null) return null;
        var id = block.id;
        var m = blockMetaCache[id];
        if (m !== undefined) return m;

        var isVent = (block instanceof SteamVent);
        var isStaticWall = (block instanceof StaticWall);
        var isTree = (block instanceof TreeBlock);
        var isTall = (block instanceof TallBlock);
        var isCliff = (block == Blocks.cliff);

        var validVars = null;
        var rawVars = block.variantRegions;
        if (rawVars != null && rawVars.length > 0) {
            var tmp = [];
            for (var i = 0; i < rawVars.length; i++) {
                if (rawVars[i] != null && Core.atlas.isFound(rawVars[i])) {
                    tmp.push(rawVars[i]);
                }
            }
            if (tmp.length > 0) validVars = tmp;
        }

        var fallbackReg = null;
        if (block.region != null && Core.atlas.isFound(block.region)) {
            fallbackReg = block.region;
        } else if (block.fullIcon != null && Core.atlas.isFound(block.fullIcon)) {
            fallbackReg = block.fullIcon;
        }

        var bldIcon = null;
        if (block.fullIcon != null && Core.atlas.isFound(block.fullIcon)) {
            bldIcon = block.fullIcon;
        } else if (block.uiIcon != null && Core.atlas.isFound(block.uiIcon)) {
            bldIcon = block.uiIcon;
        }

        var split = null;
        if (isStaticWall && block.split != null && block.large != null && Core.atlas.isFound(block.large) &&
            block.split.length >= 2 && block.split[0].length >= 2) {
            split = block.split;
        }

        var shadVars = null;
        var rawShad = block.variantShadowRegions;
        if (rawShad != null && rawShad.length > 0) {
            var stmp = [];
            for (var j = 0; j < rawShad.length; j++) {
                if (rawShad[j] != null && Core.atlas.isFound(rawShad[j])) {
                    stmp.push(rawShad[j]);
                }
            }
            if (stmp.length > 0) shadVars = stmp;
        }
        var customShad = (block.customShadowRegion != null && Core.atlas.isFound(block.customShadowRegion))
            ? block.customShadowRegion : null;

        var teamReg = (block.teamRegion != null && Core.atlas.isFound(block.teamRegion)) ? block.teamRegion : null;

        m = {
            isVent: isVent,
            parent: isVent ? block.parent : null,
            isStaticWall: isStaticWall,
            isTree: isTree,
            isTall: isTall,
            isCliff: isCliff,
            variants: validVars,
            fallbackReg: fallbackReg,
            bldIcon: bldIcon,
            split: split,
            shadVars: shadVars,
            customShad: customShad,
            shadowOffset: (isTree || isTall) ? (block.shadowOffset || -3.0) : -3.0,
            hasShadow: !!block.hasShadow,
            mapColor: block.mapColor,
            wallOre: !!block.wallOre,
            rotate: !!block.rotate,
            size: block.size,
            teamRegions: block.teamRegions,
            teamRegion: teamReg
        };
        blockMetaCache[id] = m;
        return m;
    }

    function pickMetaRegion(meta, x, y) {
        if (meta == null) return null;
        if (meta.variants != null) {
            return meta.variants[tileHash(x, y) % meta.variants.length];
        }
        return meta.fallbackReg;
    }

    function drawScaledRegion(reg, sx, sy, tilePx, rot) {
        var scl = reg.scl() * (tilePx / 8.0);
        var rw = reg.width * scl;
        var rh = reg.height * scl;
        if (rot === 0) {
            Draw.rect(reg, sx, sy, rw, rh);
        } else {
            Draw.rect(reg, sx, sy, rw, rh, rot);
        }
    }

    function bakeTerrainFBO(snap, minX, maxX, minY, maxY, bakePx) {
        var spanX = maxX - minX + 1;
        var spanY = maxY - minY + 1;
        var fboW = spanX * bakePx;
        var fboH = spanY * bakePx;

        if (terrainFbo == null) {
            terrainFbo = new FrameBuffer(2, 2);
        }

        Draw.flush();
        SAVED_PROJ.set(Draw.proj());
        SAVED_TRANS.set(Draw.trans());

        terrainFbo.resize(fboW, fboH);
        terrainFbo.getTexture().setFilter(TextureFilter.linear, TextureFilter.linear);
        terrainFbo.begin(COL_DARK_BG);

        Draw.trans().idt();
        Draw.proj().setOrtho(0, 0, fboW, fboH);
        Draw.reset();

        var w = snap.w;
        var h = snap.h;
        var floors = snap.floors;
        var overlays = snap.overlays;
        var blocks = snap.blocks;
        var data = snap.data;
        var darkness = snap.darkness;
        var cliffRegs = Blocks.cliff.cliffs;

        var x, y, idx, sx, sy, fl, ov, bl, fm, om, bm, reg;
        var padTile = bakePx + 0.35;

        // Pass 1: Floors
        Draw.color();
        for (y = minY; y <= maxY; y++) {
            sy = (y - minY + 0.5) * bakePx;
            var row = y * w;
            for (x = minX; x <= maxX; x++) {
                idx = row + x;
                fl = floors[idx];
                if (fl == null) continue;
                fm = getBlockMeta(fl);
                sx = (x - minX + 0.5) * bakePx;

                if (fm.isVent) {
                    var pm = (fm.parent != null && fm.parent != Blocks.air) ? getBlockMeta(fm.parent) : null;
                    reg = pickMetaRegion(pm, x, y);
                } else {
                    reg = pickMetaRegion(fm, x, y);
                }
                if (reg != null) {
                    Draw.rect(reg, sx, sy, padTile, padTile);
                } else {
                    Draw.color(fm.mapColor);
                    Fill.rect(sx, sy, padTile, padTile);
                    Draw.color();
                }
            }
        }

        // Pass 1b: 3x3 SteamVent overlays
        var vents = snap.ventAnchors;
        for (var vi = 0; vi < vents.length; vi++) {
            var va = vents[vi];
            if (va.x < minX || va.x > maxX + 2 || va.y < minY || va.y > maxY + 2) continue;
            reg = pickMetaRegion(getBlockMeta(va.floor), va.x, va.y);
            if (reg != null) {
                sx = (va.x - 0.5 - minX) * bakePx;
                sy = (va.y - 0.5 - minY) * bakePx;
                Draw.rect(reg, sx, sy, bakePx * 3.0, bakePx * 3.0);
            }
        }

        // Pass 2: Ground Overlays (non-wallOre)
        Draw.color();
        for (y = minY; y <= maxY; y++) {
            sy = (y - minY + 0.5) * bakePx;
            var row2 = y * w;
            for (x = minX; x <= maxX; x++) {
                idx = row2 + x;
                ov = overlays[idx];
                if (ov == null) continue;
                om = getBlockMeta(ov);
                if (om.wallOre) continue;
                reg = pickMetaRegion(om, x, y);
                if (reg != null) {
                    sx = (x - minX + 0.5) * bakePx;
                    Draw.rect(reg, sx, sy, bakePx, bakePx);
                }
            }
        }

        // Pass 3a: Wall drop shadows
        var shadowShift = bakePx * 0.16;
        Draw.color(0, 0, 0, 0.34);
        for (y = minY; y <= maxY; y++) {
            sy = (y - minY + 0.5) * bakePx - shadowShift;
            var row3s = y * w;
            for (x = minX; x <= maxX; x++) {
                idx = row3s + x;
                bl = blocks[idx];
                if (bl == null || darkness[idx] >= 2) continue;
                bm = getBlockMeta(bl);
                if (!bm.hasShadow || bm.isCliff || bm.isTree || bm.isTall) continue;
                sx = (x - minX + 0.5) * bakePx - shadowShift;
                Fill.rect(sx, sy, bakePx * 1.06, bakePx * 1.06);
            }
        }
        Draw.color();

        // Pass 3b: Static Blocks (walls, rocks, cliffs, boulders) + wall ores + wall darkness
        var tallQueue = [];
        for (y = minY; y <= maxY; y++) {
            sy = (y - minY + 0.5) * bakePx;
            var row3 = y * w;
            for (x = minX; x <= maxX; x++) {
                idx = row3 + x;
                bl = blocks[idx];
                if (bl == null) continue;
                bm = getBlockMeta(bl);

                if (bm.isTree || bm.isTall) {
                    tallQueue.push({ x: x, y: y, meta: bm });
                    continue;
                }

                sx = (x - minX + 0.5) * bakePx;

                if (bm.isCliff) {
                    var cliffMask = data[idx];
                    if (cliffRegs != null && cliffMask < cliffRegs.length && cliffRegs[cliffMask] != null) {
                        fl = floors[idx];
                        COL_TMP1.set(fl != null ? fl.mapColor : Color.gray).mul(1.6);
                        Draw.color(COL_TMP1);
                        Draw.rect(cliffRegs[cliffMask], sx, sy, padTile, padTile);
                        Draw.color();
                    }
                    continue;
                }

                var drewLarge = false;
                if (bm.split != null) {
                    var rx = (x >> 1) << 1;
                    var ry = (y >> 1) << 1;
                    if (rx + 1 < w && ry + 1 < h &&
                        blocks[ry * w + rx] == bl &&
                        blocks[ry * w + rx + 1] == bl &&
                        blocks[(ry + 1) * w + rx] == bl &&
                        blocks[(ry + 1) * w + rx + 1] == bl &&
                        (tileHash(rx, ry) & 1) === 0) {
                        var splitReg = bm.split[x & 1][1 - (y & 1)];
                        if (splitReg != null) {
                            Draw.rect(splitReg, sx, sy, padTile, padTile);
                            drewLarge = true;
                        }
                    }
                }

                if (!drewLarge) {
                    reg = pickMetaRegion(bm, x, y);
                    if (reg != null) {
                        drawScaledRegion(reg, sx, sy, bakePx, 0);
                    } else {
                        Draw.color(bm.mapColor);
                        Fill.rect(sx, sy, bakePx, bakePx);
                        Draw.color();
                    }
                }

                // Wall ore on top of solid wall (crucial Erekir clue!)
                ov = overlays[idx];
                if (ov != null) {
                    om = getBlockMeta(ov);
                    if (om.wallOre) {
                        var ovReg = pickMetaRegion(om, x, y);
                        if (ovReg != null) {
                            Draw.rect(ovReg, sx, sy, bakePx, bakePx);
                        }
                    }
                }

                // Static rock depth darkness
                var dk = darkness[idx];
                if (dk > 0) {
                    Draw.color(0, 0, 0, Math.min(0.88, dk * 0.22));
                    Fill.rect(sx, sy, padTile, padTile);
                    Draw.color();
                }
            }
        }

        // Pass 4: Buildings (ruins, enemy cores, turrets, drills, conveyors, etc.)
        if (!game.hideBuildings && snap.buildings.length > 0) {
            var blds = snap.buildings;
            for (var bi = 0; bi < blds.length; bi++) {
                var b = blds[bi];
                bm = getBlockMeta(b.block);
                var bSize = bm.size;
                var pad = bSize + 1;
                if (b.x + pad < minX || b.x - pad > maxX || b.y + pad < minY || b.y - pad > maxY) continue;

                var evenShift = ((bSize + 1) & 1) * 0.5;
                sx = (b.x + 0.5 + evenShift - minX) * bakePx;
                sy = (b.y + 0.5 + evenShift - minY) * bakePx;
                var drawSize = bSize * bakePx;

                Draw.color(0, 0, 0, 0.35);
                Fill.rect(sx - bakePx * 0.1, sy - bakePx * 0.1, drawSize * 1.04, drawSize * 1.04);
                Draw.color();

                if (bm.bldIcon != null) {
                    var bRot = bm.rotate ? (b.rot * 90) : 0;
                    if (bRot === 0) {
                        Draw.rect(bm.bldIcon, sx, sy, drawSize, drawSize);
                    } else {
                        Draw.rect(bm.bldIcon, sx, sy, drawSize, drawSize, bRot);
                    }
                }

                if (b.team != null) {
                    var drewTeam = false;
                    if (bm.teamRegions != null && b.team.id < bm.teamRegions.length) {
                        var cand = bm.teamRegions[b.team.id];
                        if (cand != null && Core.atlas.isFound(cand)) {
                            Draw.color();
                            Draw.rect(cand, sx, sy, drawSize, drawSize);
                            drewTeam = true;
                        }
                    }
                    if (!drewTeam && bm.teamRegion != null) {
                        Draw.color(b.team.color);
                        Draw.rect(bm.teamRegion, sx, sy, drawSize, drawSize);
                        Draw.color();
                    }
                }
            }
        }

        // Pass 5: Tall Props & Trees on top
        for (var ti = 0; ti < tallQueue.length; ti++) {
            var item = tallQueue[ti];
            bm = item.meta;
            sx = (item.x + 0.5 - minX) * bakePx;
            sy = (item.y + 0.5 - minY) * bakePx;
            var hVal = tileHash(item.x, item.y);
            var tRot = bm.isTree ? ((hVal & 3) * 90) : ((hVal % 40) - 20);

            var shadReg = (bm.shadVars != null) ? bm.shadVars[hVal % bm.shadVars.length] : bm.customShad;
            if (shadReg != null) {
                var off = bm.shadowOffset * (bakePx / 8.0);
                Draw.color(0, 0, 0, 0.55);
                drawScaledRegion(shadReg, sx + off, sy + off, bakePx, tRot);
                Draw.color();
            }

            reg = pickMetaRegion(bm, item.x, item.y);
            if (reg != null) {
                drawScaledRegion(reg, sx, sy, bakePx, tRot);
            }
        }

        Draw.flush();
        terrainFbo.end();

        Draw.proj(SAVED_PROJ);
        Draw.trans(SAVED_TRANS);
        Draw.reset();

        fboState.dirty = false;
        fboState.minX = minX;
        fboState.maxX = maxX;
        fboState.minY = minY;
        fboState.maxY = maxY;
        fboState.bakePx = bakePx;
        fboState.hideBuildings = game.hideBuildings;
    }

    function ensureTerrainBaked(snap, camX, camY, halfW, halfH, tilePx) {
        var w = snap.w;
        var h = snap.h;
        var visMinX = Math.max(0, Math.floor(camX - halfW / tilePx) - 1);
        var visMaxX = Math.min(w - 1, Math.ceil(camX + halfW / tilePx) + 1);
        var visMinY = Math.max(0, Math.floor(camY - halfH / tilePx) - 1);
        var visMaxY = Math.min(h - 1, Math.ceil(camY + halfH / tilePx) + 1);

        var needsBake = fboState.dirty ||
            fboState.hideBuildings !== game.hideBuildings ||
            terrainFbo == null ||
            visMinX < fboState.minX || visMaxX > fboState.maxX ||
            visMinY < fboState.minY || visMaxY > fboState.maxY;

        if (!needsBake) return;

        var bakePx;
        var halfSpan;
        if (w <= 128 && h <= 128) {
            bakePx = 32;
            halfSpan = 128;
        } else if (game.mode !== "move" && game.phase === "terrain") {
            bakePx = 32;
            halfSpan = 56;
        } else {
            bakePx = 24;
            halfSpan = 80;
        }

        var cx = Math.floor(camX);
        var cy = Math.floor(camY);
        var bMinX = Math.max(0, cx - halfSpan);
        var bMaxX = Math.min(w - 1, cx + halfSpan);
        var bMinY = Math.max(0, cy - halfSpan);
        var bMaxY = Math.min(h - 1, cy + halfSpan);

        // Expand window if clamped against map border so we use the full budget
        var maxSpan = halfSpan * 2;
        if (bMaxX - bMinX < maxSpan) {
            if (bMinX === 0) bMaxX = Math.min(w - 1, bMinX + maxSpan);
            else if (bMaxX === w - 1) bMinX = Math.max(0, bMaxX - maxSpan);
        }
        if (bMaxY - bMinY < maxSpan) {
            if (bMinY === 0) bMaxY = Math.min(h - 1, bMinY + maxSpan);
            else if (bMaxY === h - 1) bMinY = Math.max(0, bMaxY - maxSpan);
        }

        // Guarantee visible region fits even on huge screens
        if (visMinX < bMinX) bMinX = visMinX;
        if (visMaxX > bMaxX) bMaxX = visMaxX;
        if (visMinY < bMinY) bMinY = visMinY;
        if (visMaxY > bMaxY) bMaxY = visMaxY;

        // Hard cap FBO dimensions to 4096px
        var spanX = bMaxX - bMinX + 1;
        var spanY = bMaxY - bMinY + 1;
        while (spanX * bakePx > 4096 || spanY * bakePx > 4096) {
            bakePx = Math.max(8, bakePx - 4);
        }

        bakeTerrainFBO(snap, bMinX, bMaxX, bMinY, bMaxY, bakePx);
    }

    function drawTerrain(el) {
        var ex = el.x;
        var ey = el.y;
        var ew = el.getWidth();
        var eh = el.getHeight();
        var snap = game.snap;

        var tilePx = BASE_TILE_PX * Scl.scl(1.0) * game.terrainZoom;
        var halfW = ew * 0.5;
        var halfH = eh * 0.5;

        // Bake BEFORE clipBegin so FBO rendering never interacts with Scene2D scissor stack
        if (snap != null) {
            ensureTerrainBaked(snap, game.camX, game.camY, halfW, halfH, tilePx);
        }

        Draw.reset();
        Draw.color(COL_DARK_BG);
        Fill.rect(ex + halfW, ey + halfH, ew, eh);
        Draw.color();

        if (!snap || terrainFbo == null) {
            Draw.reset();
            return;
        }

        if (!el.clipBegin(ex, ey, ew, eh)) {
            Draw.reset();
            return;
        }

        var centerX = ex + halfW;
        var centerY = ey + halfH;
        var camX = game.camX;
        var camY = game.camY;

        // Single GPU draw call for the entire HD terrain!
        var spanX = fboState.maxX - fboState.minX + 1;
        var spanY = fboState.maxY - fboState.minY + 1;
        var worldMidX = (fboState.minX + fboState.maxX + 1) * 0.5;
        var worldMidY = (fboState.minY + fboState.maxY + 1) * 0.5;
        var screenCX = centerX + (worldMidX - camX) * tilePx;
        var screenCY = centerY + (worldMidY - camY) * tilePx;
        var drawW = spanX * tilePx;
        var drawH = spanY * tilePx;

        Draw.color();
        Draw.rect(Draw.wrap(terrainFbo.getTexture()), screenCX, screenCY, drawW, -drawH);

        // Move-mode explore boundary frame
        if (game.mode === "move" && game.phase === "terrain") {
            var bx1 = centerX + (game.dropX - PAN_RADIUS - camX) * tilePx;
            var by1 = centerY + (game.dropY - PAN_RADIUS - camY) * tilePx;
            var bSpan = PAN_RADIUS * 2.0 * tilePx;
            Lines.stroke(Scl.scl(2.0));
            Draw.color(Pal.accent, 0.35);
            Lines.rect(bx1, by1, bSpan, bSpan);
            Draw.color();
        }

        // Subtle drop-point crosshair marker when panned away in Move mode
        if (game.mode === "move") {
            var dpx = centerX + (game.dropX - camX) * tilePx;
            var dpy = centerY + (game.dropY - camY) * tilePx;
            if (dpx >= ex - 20 && dpx <= ex + ew + 20 && dpy >= ey - 20 && dpy <= ey + eh + 20) {
                Lines.stroke(Scl.scl(1.5));
                Draw.color(Pal.accent, 0.55);
                var r = Scl.scl(8.0);
                Lines.line(dpx - r, dpy, dpx + r, dpy);
                Lines.line(dpx, dpy - r, dpx, dpy + r);
                Draw.color();
            }
        }

        el.clipEnd();
        Draw.reset();
    }

    // -------------------------------------------------------------------------
    // 3D Planet Renderer & Interface (Zero Campaign Spoilers!)
    // -------------------------------------------------------------------------

    function rebuildPlanetHighlightLists(planet) {
        planetDimSectors = [];
        planetCandidateSectors = [];
        if (!planet || !planet.sectors || !isPresetOnlyPool(game.pool)) return;
        for (var i = 0; i < planet.sectors.size; i++) {
            var s = planet.sectors.get(i);
            if (isValidGuessSector(s)) {
                planetCandidateSectors.push(s);
            } else {
                planetDimSectors.push(s);
            }
        }
    }

    function ensurePlanetParams() {
        if (planetParams != null) return;
        planetParams = new PlanetParams();
        planetParams.drawUi = true;
        planetParams.drawSkybox = true;
        planetParams.zoom = 1.0;
        planetParams.uiAlpha = 1.0;
        planetParams.planet = Planets.serpulo;
        var drewArcOver = false;
        var drawRevealArc = function (planet) {
            if (game.phase !== "reveal") return;
            var res = game.results[game.results.length - 1];
            if (!res || !res.actual || !res.guess) return;
            if (res.actual == res.guess) return;
            if (res.actual.planet != planet || res.guess.planet != planet) return;

            var planets = Vars.renderer.planets;
            colAlpha(COL_TMP1, COL_GUESS, planetParams.uiAlpha);
            colAlpha(COL_TMP2, COL_ACTUAL, planetParams.uiAlpha);
            if (typeof planets.drawArcLine === "function") {
                planets.drawArcLine(planet, res.guess.tile.v, res.actual.tile.v, COL_TMP1, COL_TMP2, 1.0, 110.0, 32, 0.0085);
            } else {
                planets.drawArc(planet, res.guess.tile.v, res.actual.tile.v, COL_TMP1, COL_TMP2, 1.0, 110.0, 32);
            }
        };

        planetParams.renderer = new PlanetInterfaceRenderer({
            renderSectors: function (planet) {
                drewArcOver = false;
                var planets = Vars.renderer.planets;
                var uiAlpha = planetParams.uiAlpha;
                if (uiAlpha <= 0.01) return;

                if (game.phase === "planet") {
                    // Dim non-candidate hexes gently when playing Presets-only pools (no names/icons/colors!)
                    if (isPresetOnlyPool(game.pool)) {
                        var dimCol = colAlpha(COL_TMP1, PlanetRenderer.shadowColor, PlanetRenderer.shadowColor.a * 0.55 * uiAlpha);
                        for (var i = 0; i < planetDimSectors.length; i++) {
                            var ds = planetDimSectors[i];
                            if (ds == game.hoveredSector) continue;
                            planets.fill(ds, dimCol, -0.001);
                        }
                        var candCol = colAlpha(COL_TMP2, Color.white, 0.32 * uiAlpha);
                        for (var j = 0; j < planetCandidateSectors.length; j++) {
                            var cs = planetCandidateSectors[j];
                            if (cs == game.pinnedSector || cs == game.hoveredSector) continue;
                            planets.drawSelection(cs, candCol, 0.024, -0.001);
                        }
                    }

                    if (game.hoveredSector != null && game.hoveredSector.planet == planet) {
                        var canHover = isValidGuessSector(game.hoveredSector);
                        COL_TMP1.set(canHover ? PlanetRenderer.hoverColor : Color.gray);
                        COL_TMP1.a *= (canHover ? uiAlpha : 0.4 * uiAlpha);
                        planets.fill(game.hoveredSector, COL_TMP1, -0.003);
                        planets.drawBorders(game.hoveredSector, canHover ? PlanetRenderer.borderColor : Color.gray, uiAlpha);
                    }

                    if (game.pinnedSector != null && game.pinnedSector.planet == planet) {
                        planets.fill(game.pinnedSector, colAlpha(COL_TMP1, COL_PIN, 0.45 * uiAlpha), -0.004);
                        planets.drawSelection(game.pinnedSector, colAlpha(COL_TMP2, COL_PIN, uiAlpha), 0.032, -0.002);
                        planets.drawBorders(game.pinnedSector, COL_PIN, uiAlpha);
                    }
                } else if (game.phase === "reveal") {
                    var res = game.results[game.results.length - 1];
                    if (res) {
                        var actual = res.actual;
                        var guess = res.guess;
                        var exact = (actual != null && guess != null && actual == guess);

                        if (exact && actual.planet == planet) {
                            planets.fill(actual, colAlpha(COL_TMP1, COL_GOLD, 0.65 * uiAlpha), -0.004);
                            planets.drawSelection(actual, colAlpha(COL_TMP2, COL_GOLD, uiAlpha), 0.036, -0.002);
                            planets.drawBorders(actual, COL_GOLD, uiAlpha);
                        } else {
                            if (actual != null && actual.planet == planet) {
                                planets.fill(actual, colAlpha(COL_TMP1, COL_ACTUAL, 0.6 * uiAlpha), -0.004);
                                planets.drawSelection(actual, colAlpha(COL_TMP2, COL_ACTUAL, uiAlpha), 0.034, -0.002);
                                planets.drawBorders(actual, COL_ACTUAL, uiAlpha);
                            }
                            if (guess != null && guess.planet == planet) {
                                planets.fill(guess, colAlpha(COL_TMP1, COL_GUESS, 0.55 * uiAlpha), -0.004);
                                planets.drawSelection(guess, colAlpha(COL_TMP2, COL_GUESS, uiAlpha), 0.034, -0.002);
                                planets.drawBorders(guess, COL_GUESS, uiAlpha);
                            }
                        }
                    }
                }

                planets.batch.flush(Gl.triangles);
            },
            renderOverProjections: function (planet) {
                drewArcOver = true;
                drawRevealArc(planet);
            },
            renderProjections: function (planet) {
                // Intentionally clean during guess; tiny crisp marker tags during reveal!
                if (game.phase !== "reveal" || planetParams.uiAlpha <= 0.05) return;
                if (!drewArcOver) {
                    var pl = Vars.renderer.planets;
                    pl.batch.proj().mul(planet.getTransform(pl.mat));
                    drawRevealArc(planet);
                }
                var res = game.results[game.results.length - 1];
                if (!res) return;
                var planets = Vars.renderer.planets;
                var drawTag = function (sec, label, col) {
                    if (sec == null || sec.planet != planet) return;
                    planets.drawPlane(sec, run(function () {
                        Fonts.outline.getData().setScale(0.45);
                        Fonts.outline.setColor(col);
                        Fonts.outline.draw(label, 0, 0, Align.center);
                        Fonts.outline.setColor(Color.white);
                        Fonts.outline.getData().setScale(1.0);
                    }));
                };
                if (res.actual == res.guess) {
                    drawTag(res.actual, "BULLSEYE!", COL_GOLD);
                } else {
                    drawTag(res.actual, "ACTUAL", COL_ACTUAL);
                    drawTag(res.guess, "GUESS", COL_GUESS);
                }
                Draw.reset();
            }
        });
    }

    function setGuessPlanet(planet, randomizeCam) {
        ensurePlanetParams();
        planetParams.planet = planet;
        rebuildPlanetHighlightLists(planet);
        planetZoom = clamp(1.0, planet.minZoom, planet.maxZoom);
        planetParams.zoom = planetZoom;
        planetParams.uiAlpha = 1.0;
        planetParams.otherCamPos = null;
        if (randomizeCam) {
            // Random camera angle on the globe so starting view never hints at actual sector
            var theta = Math.random() * Math.PI * 2.0;
            var phi = (Math.random() - 0.5) * 1.1;
            var len = (planet.radius + planet.camRadius) * PlanetRenderer.camLength;
            planetParams.camPos.set(
                Math.cos(theta) * Math.cos(phi) * len,
                Math.sin(phi) * len,
                Math.sin(theta) * Math.cos(phi) * len
            );
        }
    }

    function computeRevealCameraTarget(actual, guess) {
        if (!actual) return null;
        var v1 = actual.planet.lookAt(actual, VEC_TMP1).nor();
        if (guess != null && guess.planet == actual.planet && guess != actual) {
            var v2 = actual.planet.lookAt(guess, VEC_TMP2).nor();
            var mid = new Vec3(v1).add(v2);
            if (mid.len() < 0.05) {
                // Antipodal guess: look straight at actual
                mid.set(v1);
            }
            return mid.nor();
        }
        return new Vec3(v1);
    }

    // -------------------------------------------------------------------------
    // Scoring & Hex Distance
    // -------------------------------------------------------------------------

    function hexDistance(a, b) {
        if (!a || !b || a.planet != b.planet) return -1;
        if (a == b) return 0;

        var visited = {};
        visited[a.id] = true;
        var queue = [a];
        var dists = [0];
        var head = 0;

        while (head < queue.length) {
            var cur = queue[head];
            var d = dists[head];
            head++;
            var near = cur.near();
            for (var i = 0; i < near.size; i++) {
                var nb = near.get(i);
                if (nb == b) return d + 1;
                if (!visited[nb.id]) {
                    visited[nb.id] = true;
                    queue.push(nb);
                    dists.push(d + 1);
                }
            }
        }
        return -1;
    }

    function scoreGuess(actual, guess) {
        if (!actual || !guess) {
            return { actual: actual, guess: guess, score: 0, hexDist: -1, degDist: 180, wrongPlanet: true };
        }
        if (actual.planet != guess.planet) {
            return { actual: actual, guess: guess, score: 0, hexDist: -1, degDist: 180, wrongPlanet: true };
        }
        if (actual == guess) {
            return { actual: actual, guess: guess, score: 5000, hexDist: 0, degDist: 0, wrongPlanet: false };
        }

        var deg = actual.tile.v.angle(guess.tile.v);
        var hops = hexDistance(actual, guess);
        var stepDeg = (actual.planet == Planets.erekir) ? 20.0 : 12.0;
        var raw = 5000.0 * Math.exp(-Math.pow(deg / (stepDeg * 4.0), 1.35));
        var pts = clamp(Math.round(raw), 0, 4999);
        return {
            actual: actual,
            guess: guess,
            score: pts,
            hexDist: hops,
            degDist: deg,
            wrongPlanet: false
        };
    }

    function scoreColorTag(pts) {
        if (pts >= 5000) return "[#ffd37f]";
        if (pts >= 4000) return "[#55ff77]";
        if (pts >= 2500) return "[#aaff55]";
        if (pts >= 1200) return "[#ffbb44]";
        return "[#ff6038]";
    }

    function rankForTotal(total, maxScore) {
        var frac = maxScore > 0 ? (total / maxScore) : 0;
        if (frac >= 0.96) return "[#ffd37f]Grand Planetary Cartographer[]";
        if (frac >= 0.85) return "[#55ff77]Crux Orbital Surveyor[]";
        if (frac >= 0.70) return "[accent]Sharded Navigator[]";
        if (frac >= 0.50) return "[#88ccff]Sector Scout[]";
        if (frac >= 0.30) return "[lightgray]Lost Flare Pilot[]";
        return "[#ff6038]Spore-Blind Drifter[]";
    }

    // -------------------------------------------------------------------------
    // Match Lifecycle
    // -------------------------------------------------------------------------

    function clampTerrainCamera() {
        var snap = game.snap;
        if (!snap) return;
        if (game.mode === "move") {
            game.camX = clamp(game.camX, Math.max(0, game.dropX - PAN_RADIUS), Math.min(snap.w, game.dropX + PAN_RADIUS));
            game.camY = clamp(game.camY, Math.max(0, game.dropY - PAN_RADIUS), Math.min(snap.h, game.dropY + PAN_RADIUS));
        } else {
            game.camX = game.dropX;
            game.camY = game.dropY;
        }
    }

    function recenterTerrain() {
        game.camX = game.dropX;
        game.camY = game.dropY;
        if (game.mode === "nmpz") {
            game.terrainZoom = 1.0;
        }
    }

    function loadCurrentRound() {
        game.snap = null;
        fboState.dirty = true;
        game.loadError = null;
        game.hoveredSector = null;
        game.pinnedSector = null;
        game.revealTarget = null;
        game.revealLerp = 0;

        var sec = game.roundSectors[game.roundIdx];
        try {
            game.snap = loadSectorSnapshot(sec);
            var dp = pickDropPoint(game.snap);
            game.dropX = dp.x;
            game.dropY = dp.y;
            game.camX = dp.x;
            game.camY = dp.y;
            game.terrainZoom = 1.0;
        } catch (err) {
            Log.err("SectorGuessr failed to load sector " + sectorShortName(sec), err);
            game.loadError = String(err);
        }

        // Prepare 3D planet camera at a fresh random angle
        var initialPlanet = (game.pool === "erekir-presets") ? Planets.erekir : Planets.serpulo;
        if (game.pool === "both-presets") {
            initialPlanet = (Math.random() < 0.5) ? Planets.serpulo : Planets.erekir;
        }
        setGuessPlanet(initialPlanet, true);

        setPhase("terrain");
    }

    function setPhase(phase) {
        game.phase = phase;
        rebuildBottomBar();
    }

    function submitGuess() {
        if (game.phase !== "planet" || game.pinnedSector == null) return;
        var actual = game.roundSectors[game.roundIdx];
        var res = scoreGuess(actual, game.pinnedSector);
        game.results.push(res);
        game.totalScore += res.score;

        // Point camera to actual planet (important if player guessed on wrong planet in Both mode)
        if (planetParams.planet != actual.planet) {
            setGuessPlanet(actual.planet, false);
        }
        game.revealTarget = computeRevealCameraTarget(res.actual, res.guess);
        game.revealLerp = 1.0;
        planetZoom = clamp(1.15, actual.planet.minZoom, actual.planet.maxZoom);

        setPhase("reveal");
    }

    function nextRoundOrFinish() {
        if (game.roundIdx + 1 < game.totalRounds) {
            game.roundIdx++;
            loadCurrentRound();
        } else {
            finishMatch();
        }
    }

    function finishMatch() {
        game.active = false;
        var isNewPB = saveBestScore(game.pool, game.mode, game.totalRounds, game.totalScore);
        if (gameDialog != null) {
            gameDialog.hide();
        }
        showSummaryDialog(isNewPB);
    }

    function exitMatch() {
        game.active = false;
        game.snap = null;
        if (gameDialog != null) {
            gameDialog.hide();
        }
        if (game.returnToPlanet) {
            game.returnToPlanet = false;
            Core.app.post(run(function () {
                Vars.ui.planet.show();
            }));
        }
    }

    function startMatch() {
        var candidates = collectPoolSectors(cfg.pool);
        if (candidates.length === 0) {
            Vars.ui.showInfo("[scarlet]No sectors found for pool: " + cfg.pool);
            return;
        }

        game.pool = cfg.pool;
        game.mode = cfg.mode;
        game.hideBuildings = cfg.hideBuildings;
        game.poolSectors = candidates;
        game.poolSectorSet = {};
        for (var i = 0; i < candidates.length; i++) {
            game.poolSectorSet[sectorKey(candidates[i])] = true;
        }

        var shuffled = shuffleCopy(candidates);
        var rounds = Math.min(cfg.rounds, shuffled.length);
        game.totalRounds = rounds;
        game.roundSectors = shuffled.slice(0, rounds);
        game.roundIdx = 0;
        game.results = [];
        game.totalScore = 0;
        game.active = true;

        if (setupDialog != null) setupDialog.hide();
        if (summaryDialog != null) summaryDialog.hide();

        // Hide PlanetDialog while SectorGuessr is open so PlanetRenderer isn't invoked twice per frame
        if (Vars.ui.planet != null && Vars.ui.planet.isShown()) {
            game.returnToPlanet = true;
            Vars.ui.planet.hide();
        } else {
            game.returnToPlanet = false;
        }

        ensureGameDialog();
        loadCurrentRound();
        gameDialog.show();
    }

    // -------------------------------------------------------------------------
    // UI: Full-Screen Game Dialog
    // -------------------------------------------------------------------------

    function rebuildBottomBar() {
        if (bottomBarHolder == null) return;
        bottomBarHolder.clearChildren();

        if (game.phase === "terrain") {
            bottomBarHolder.table(Styles.black6, cons(function (bar) {
                bar.margin(10);
                bar.left();

                // Left info: offset + zoom + recenter
                bar.table(cons(function (info) {
                    info.left();
                    info.label(prov(function () {
                        if (game.loadError) return "[scarlet]Error loading sector[]";
                        if (game.mode === "nmpz") return "[lightgray]NMPZ Locked[]";
                        var dx = Math.round(game.camX - game.dropX);
                        var dy = Math.round(game.camY - game.dropY);
                        var zTxt = game.terrainZoom.toFixed(2) + "x";
                        if (game.mode === "nm") {
                            return "[lightgray]Pan Locked  |  Zoom: [white]" + zTxt + "[]";
                        }
                        var sx = (dx >= 0 ? "+" : "") + dx;
                        var sy = (dy >= 0 ? "+" : "") + dy;
                        return "[lightgray]Offset: [white]" + sx + ", " + sy + "[]  [lightgray]|  Zoom: [white]" + zTxt + "[]";
                    })).left().padRight(10);

                    if (game.mode !== "nmpz") {
                        info.button("Recenter [R]", Icon.refreshSmall, Styles.flatt, run(function () {
                            recenterTerrain();
                        })).height(40).width(155).padLeft(4);
                    }
                })).left().growX();

                // Right CTA: Open Planet Map
                bar.button("[accent]Open Planet Map [M][]", Icon.planet, run(function () {
                    setPhase("planet");
                })).height(52).width(260).right();
            })).growX();

        } else if (game.phase === "planet") {
            bottomBarHolder.table(Styles.black6, cons(function (bar) {
                bar.margin(10);

                // Left: Back to Terrain (+ optional planet switch for Both Planets pool)
                bar.table(cons(function (left) {
                    left.left();
                    left.button("Back to Terrain [M]", Icon.terrainSmall, run(function () {
                        setPhase("terrain");
                    })).height(50).width(220);

                    if (game.pool === "both-presets") {
                        left.button("Serpulo", Styles.flatTogglet, run(function () {
                            setGuessPlanet(Planets.serpulo, false);
                        })).height(46).width(105).padLeft(10).checked(boolf(function () {
                            return planetParams != null && planetParams.planet == Planets.serpulo;
                        }));
                        left.button("Erekir", Styles.flatTogglet, run(function () {
                            setGuessPlanet(Planets.erekir, false);
                        })).height(46).width(105).padLeft(4).checked(boolf(function () {
                            return planetParams != null && planetParams.planet == Planets.erekir;
                        }));
                    }
                })).left();

                // Center: Spoiler-free pin status
                bar.label(prov(function () {
                    if (game.pinnedSector != null) {
                        return "[#66d9ff]Pin placed on " + game.pinnedSector.planet.localizedName + "[]  [lightgray](drag to inspect, or lock in)[]";
                    }
                    if (game.hoveredSector != null && isValidGuessSector(game.hoveredSector)) {
                        return "[white]Click to pin this hex[]";
                    }
                    return "[lightgray]Drag to orbit  |  Scroll to zoom  |  Click a hex to pin your guess[]";
                })).growX().labelAlign(Align.center).padLeft(10).padRight(10);

                // Right: Lock In Guess
                bar.button("[#55ff77]Lock In Guess [Space][]", Icon.ok, run(function () {
                    submitGuess();
                })).height(52).width(250).disabled(boolf(function () {
                    return game.pinnedSector == null;
                })).right();
            })).growX();

        } else if (game.phase === "reveal" || game.phase === "reveal-terrain") {
            var res = game.results[game.results.length - 1];
            bottomBarHolder.table(Styles.black8, cons(function (bar) {
                bar.margin(12);

                bar.table(cons(function (info) {
                    info.left();
                    if (res) {
                        var headline = "[#55ff77]ACTUAL: []" + sectorDisplayName(res.actual)
                            + "    [lightgray]|[]    [#ff8855]YOUR GUESS: []" + sectorDisplayName(res.guess);
                        info.add(headline).left().row();

                        var distTxt;
                        if (res.wrongPlanet) {
                            distTxt = "[scarlet]Wrong planet![]";
                        } else if (res.hexDist === 0) {
                            distTxt = "[#ffd37f]EXACT HEX BULLSEYE![]";
                        } else {
                            var hopTxt = res.hexDist > 0 ? (res.hexDist + (res.hexDist === 1 ? " hex away" : " hexes away")) : "far away";
                            distTxt = "[lightgray]" + hopTxt + "  (" + res.degDist.toFixed(1) + "\u00B0)[]";
                        }

                        var ptsLine = scoreColorTag(res.score) + "+" + formatNumber(res.score) + " / 5,000 pts[]    " + distTxt;
                        info.add(ptsLine).left().padTop(4).row();

                        // Visual score bar
                        var frac = clamp(res.score / 5000.0, 0, 1);
                        info.table(cons(function (track) {
                            track.background(Styles.black6);
                            track.left();
                            track.image(Tex.whiteui).color(res.score >= 5000 ? COL_GOLD : (res.score >= 3000 ? COL_ACTUAL : (res.score >= 1500 ? Pal.accent : COL_GUESS)))
                                .height(8).width(Math.max(2, Math.round(340 * frac)));
                        })).width(340).height(8).left().padTop(6);
                    }
                })).left().growX();

                bar.table(cons(function (acts) {
                    acts.right();
                    var isTerrainPeek = (game.phase === "reveal-terrain");
                    acts.button(isTerrainPeek ? "Back to Globe" : "Inspect Terrain", isTerrainPeek ? Icon.planetSmall : Icon.terrainSmall, Styles.flatt, run(function () {
                        setPhase(isTerrainPeek ? "reveal" : "reveal-terrain");
                    })).height(48).width(185).padRight(8);

                    var isLast = (game.roundIdx + 1 >= game.totalRounds);
                    acts.button(isLast ? "[accent]View Summary[]" : "[accent]Next Round [Space][]", Icon.right, run(function () {
                        nextRoundOrFinish();
                    })).height(52).width(220);
                })).right();
            })).growX();
        }
    }

    function ensureGameDialog() {
        if (gameDialog != null) return;
        ensurePlanetParams();

        gameDialog = new BaseDialog("", Styles.fullDialog);
        var wasPaused = false;
        gameDialog.shown(run(function () {
            if (Vars.state.isGame() && !Vars.net.active()) {
                wasPaused = Vars.state.is(GameStateEnum.paused);
                Vars.state.set(GameStateEnum.paused);
            }
        }));
        gameDialog.hidden(run(function () {
            if (Vars.state.isGame() && !Vars.net.active() && !wasPaused) {
                Vars.state.set(GameStateEnum.playing);
            }
        }));
        gameDialog.clearChildren();
        gameDialog.margin(0);

        // --- Full-screen Terrain Canvas ---
        terrainElement = extend(Element, {
            draw: function () {
                drawTerrain(this);
            }
        });
        terrainElement.visibility = boolp(function () {
            return game.phase === "terrain" || game.phase === "reveal-terrain";
        });

        var tDragLastX = 0;
        var tDragLastY = 0;
        var tDragging = false;
        terrainElement.addListener(extend(InputListener, {
            touchDown: function (event, x, y, pointer, button) {
                if (pointer !== 0) return false;
                tDragLastX = x;
                tDragLastY = y;
                tDragging = true;
                return true;
            },
            touchDragged: function (event, x, y, pointer) {
                if (!tDragging || pointer !== 0) return;
                var dx = x - tDragLastX;
                var dy = y - tDragLastY;
                tDragLastX = x;
                tDragLastY = y;
                if (game.mode === "move" || game.phase === "reveal-terrain") {
                    var tilePx = BASE_TILE_PX * Scl.scl(1.0) * game.terrainZoom;
                    game.camX -= dx / tilePx;
                    game.camY -= dy / tilePx;
                    if (game.phase === "terrain") {
                        clampTerrainCamera();
                    } else if (game.snap) {
                        game.camX = clamp(game.camX, 0, game.snap.w);
                        game.camY = clamp(game.camY, 0, game.snap.h);
                    }
                }
            },
            touchUp: function (event, x, y, pointer, button) {
                if (pointer === 0) tDragging = false;
            }
        }));

        // --- Full-screen 3D Planet Canvas ---
        planetElement = extend(Element, {
            draw: function () {
                if (planetParams != null) {
                    Vars.renderer.planets.render(planetParams);
                }
            }
        });
        planetElement.visibility = boolp(function () {
            return game.phase === "planet" || game.phase === "reveal";
        });

        var pDownX = 0;
        var pDownY = 0;
        var pLastX = 0;
        var pLastY = 0;
        var pMoved = 0;
        var pDragging = false;
        var pLastClickTime = 0;
        var pLastClickSec = null;

        planetElement.addListener(extend(InputListener, {
            touchDown: function (event, x, y, pointer, button) {
                if (pointer !== 0) return false;
                pDownX = pLastX = x;
                pDownY = pLastY = y;
                pMoved = 0;
                pDragging = true;
                // Cancel reveal auto-orbit as soon as player manually grabs the globe
                game.revealTarget = null;
                return true;
            },
            touchDragged: function (event, x, y, pointer) {
                if (!pDragging || pointer !== 0 || planetParams == null) return;
                var dx = x - pLastX;
                var dy = y - pLastY;
                pLastX = x;
                pLastY = y;
                pMoved += Math.abs(dx) + Math.abs(dy);

                var pos = planetParams.camPos;
                var upV = pos.angle(Vec3.Y);
                var xscale = 9.0;
                var yscale = 10.0;
                var margin = 1.0;
                var speed = 1.0 - Math.abs(upV - 90.0) / 90.0;
                pos.rotate(planetParams.camUp, dx / xscale * speed);

                var amount = dy / yscale;
                amount = clamp(upV + amount, margin, 180.0 - margin) - upV;
                pos.rotate(VEC_TMP3.set(planetParams.camUp).rotate(planetParams.camDir, 90.0), amount);
            },
            touchUp: function (event, x, y, pointer, button) {
                if (pointer !== 0) return;
                pDragging = false;

                if (pMoved < 10.0 && game.phase === "planet" && button == KeyCode.mouseLeft) {
                    var picked = planetParams.planet.getSector(
                        Vars.renderer.planets.cam.getMouseRay(),
                        PlanetRenderer.outlineRad * planetParams.planet.radius
                    );
                    if (picked != null && isValidGuessSector(picked)) {
                        var now = Time.millis();
                        if (picked == pLastClickSec && picked == game.pinnedSector && (now - pLastClickTime) < 380) {
                            submitGuess();
                        } else {
                            game.pinnedSector = picked;
                            pLastClickSec = picked;
                            pLastClickTime = now;
                        }
                    }
                }
            }
        }));

        // --- HUD Overlay ---
        var hudTable = new Table();
        hudTable.setFillParent(true);
        hudTable.touchable = Touchable.childrenOnly;

        // Top bar
        hudTable.table(Styles.black6, cons(function (top) {
            top.margin(8);
            top.marginLeft(14);
            top.marginRight(14);

            top.label(prov(function () {
                return "[accent]SECTORGUESSR[]   [lightgray]|[]   Round [white]" + (game.roundIdx + 1) + " / " + game.totalRounds
                    + "[]   [lightgray]|[]   Score: [accent]" + formatNumber(game.totalScore) + "[]";
            })).left().growX();

            top.label(prov(function () {
                return "[lightgray]" + poolInfo(game.pool).name + "  \u2022  " + modeInfo(game.mode).name
                    + (game.hideBuildings ? "  \u2022  No Buildings" : "") + "[]";
            })).right().padRight(14);

            top.button("Quit", Icon.exit, Styles.flatt, run(function () {
                Vars.ui.showConfirm("Quit current SectorGuessr match?", run(function () {
                    exitMatch();
                }));
            })).height(38).width(105).right();
        })).top().growX().row();

        // Flexible middle spacer (empty cell receives no touches, so drags/clicks pass straight to terrain/planet!)
        hudTable.add().grow().row();

        // Bottom context bar
        bottomBarHolder = new Table();
        bottomBarHolder.touchable = Touchable.childrenOnly;
        hudTable.add(bottomBarHolder).bottom().growX();

        var rootStack = new Stack();
        rootStack.add(terrainElement);
        rootStack.add(planetElement);
        rootStack.add(hudTable);
        gameDialog.add(rootStack).grow();

        // Scroll zoom + keyboard shortcuts on the dialog
        gameDialog.addListener(extend(InputListener, {
            scrolled: function (event, x, y, amountX, amountY) {
                if (game.phase === "terrain" || game.phase === "reveal-terrain") {
                    if (game.mode === "nmpz" && game.phase === "terrain") return true;
                    var factor = amountY > 0 ? 0.88 : 1.136;
                    var minZ = (game.mode === "nm" && game.phase === "terrain") ? MIN_ZOOM_NM : MIN_ZOOM_MOVE;
                    var maxZ = (game.mode === "nm" && game.phase === "terrain") ? MAX_ZOOM_NM : MAX_ZOOM_MOVE;
                    game.terrainZoom = clamp(game.terrainZoom * factor, minZ, maxZ);
                    return true;
                }
                if ((game.phase === "planet" || game.phase === "reveal") && planetParams != null) {
                    planetZoom = clamp(planetZoom + amountY / 10.0, planetParams.planet.minZoom, planetParams.planet.maxZoom);
                    return true;
                }
                return false;
            },
            keyDown: function (event, keycode) {
                if (keycode == KeyCode.escape) {
                    Vars.ui.showConfirm("Quit current SectorGuessr match?", run(function () {
                        exitMatch();
                    }));
                    return true;
                }
                if (keycode == KeyCode.m || keycode == KeyCode.tab) {
                    if (game.phase === "terrain") {
                        setPhase("planet");
                        return true;
                    } else if (game.phase === "planet") {
                        setPhase("terrain");
                        return true;
                    } else if (game.phase === "reveal") {
                        setPhase("reveal-terrain");
                        return true;
                    } else if (game.phase === "reveal-terrain") {
                        setPhase("reveal");
                        return true;
                    }
                }
                if (keycode == KeyCode.r && (game.phase === "terrain" || game.phase === "reveal-terrain")) {
                    recenterTerrain();
                    return true;
                }
                if (keycode == KeyCode.space || keycode == KeyCode.enter) {
                    if (game.phase === "planet" && game.pinnedSector != null) {
                        submitGuess();
                        return true;
                    } else if (game.phase === "reveal" || game.phase === "reveal-terrain") {
                        nextRoundOrFinish();
                        return true;
                    }
                }
                return false;
            }
        }));

        // Per-frame update: focus, WASD terrain pan, planet hover raycast & smooth reveal slerp
        gameDialog.update(run(function () {
            if (!game.active) return;

            if (Core.scene.getDialog() == gameDialog) {
                var hoverEl = Core.scene.getHoverElement();
                if (hoverEl == null || !hoverEl.isDescendantOf(boolf(function (e) { return e instanceof ScrollPane; }))) {
                    Core.scene.setScrollFocus(gameDialog);
                }
                Core.scene.setKeyboardFocus(gameDialog);
            }

            // Smooth keyboard pan in Terrain view
            if ((game.phase === "terrain" && game.mode === "move") || game.phase === "reveal-terrain") {
                var panSpd = (18.0 / Math.max(0.5, game.terrainZoom)) * (Time.delta / 60.0);
                var mx = 0;
                var my = 0;
                if (Core.input.keyDown(KeyCode.a) || Core.input.keyDown(KeyCode.left)) mx -= 1;
                if (Core.input.keyDown(KeyCode.d) || Core.input.keyDown(KeyCode.right)) mx += 1;
                if (Core.input.keyDown(KeyCode.s) || Core.input.keyDown(KeyCode.down)) my -= 1;
                if (Core.input.keyDown(KeyCode.w) || Core.input.keyDown(KeyCode.up)) my += 1;
                if (mx !== 0 || my !== 0) {
                    game.camX += mx * panSpd;
                    game.camY += my * panSpd;
                    if (game.phase === "terrain") {
                        clampTerrainCamera();
                    } else if (game.snap) {
                        game.camX = clamp(game.camX, 0, game.snap.w);
                        game.camY = clamp(game.camY, 0, game.snap.h);
                    }
                }
            }

            // Planet zoom lerp, hover picking, and reveal auto-orbit
            if ((game.phase === "planet" || game.phase === "reveal") && planetParams != null) {
                planetParams.zoom = Mathf.lerpDelta(planetParams.zoom, planetZoom, 0.35);
                planetParams.uiAlpha = Mathf.lerpDelta(planetParams.uiAlpha, planetParams.zoom < 1.9 ? 1.0 : 0.0, 0.12);

                if (game.phase === "planet" && Core.scene.getDialog() == gameDialog) {
                    game.hoveredSector = planetParams.planet.getSector(
                        Vars.renderer.planets.cam.getMouseRay(),
                        PlanetRenderer.outlineRad * planetParams.planet.radius
                    );
                } else {
                    game.hoveredSector = null;
                }

                if (game.phase === "reveal" && game.revealTarget != null) {
                    var len = planetParams.camPos.len();
                    VEC_TMP1.set(game.revealTarget).setLength(len);
                    planetParams.camPos.slerp(VEC_TMP1, Math.min(1.0, 0.12 * Time.delta));
                    if (planetParams.camPos.angle(VEC_TMP1) < 0.8) {
                        game.revealTarget = null;
                    }
                }
            }
        }));
    }

    // -------------------------------------------------------------------------
    // UI: Setup & Summary Dialogs
    // -------------------------------------------------------------------------

    function openSetupDialog() {
        if (setupDialog == null) {
            setupDialog = new BaseDialog("SectorGuessr");
            setupDialog.addCloseButton();
            setupDialog.buttons.button("[#55ff77]Play[]", Icon.play, run(function () {
                startMatch();
            })).size(220, 64);
        }

        var c = setupDialog.cont;
        c.clear();
        c.defaults().width(Math.min(580, Core.graphics.getWidth() / Scl.scl(1.0) - 60)).padBottom(8);

        c.add("[accent]SECTORGUESSR[]").fontScale(1.35).padBottom(2).row();
        c.add("[lightgray]Explore an unknown sector in HD terrain view, then pinpoint its hex on the 3D globe.[]")
            .wrap().labelAlign(Align.center).padBottom(12).row();

        // Pool picker
        c.add("[accent]Sector Pool[]").left().padBottom(4).row();
        c.table(cons(function (grid) {
            grid.defaults().height(48).growX().pad(3);
            for (var i = 0; i < POOLS.length; i++) {
                (function (p) {
                    var count = collectPoolSectors(p.id).length;
                    grid.button(p.name + " [lightgray](" + count + ")[]", Styles.flatTogglet, run(function () {
                        cfg.pool = p.id;
                    })).checked(boolf(function () {
                        return cfg.pool === p.id;
                    }));
                    if (i % 2 === 1) grid.row();
                })(POOLS[i]);
            }
        })).row();

        c.label(prov(function () {
            return "[lightgray]" + poolInfo(cfg.pool).desc + "[]";
        })).left().padBottom(10).row();

        // Mode picker
        c.add("[accent]Movement Rules[]").left().padBottom(4).row();
        c.table(cons(function (row) {
            row.defaults().height(46).growX().pad(3);
            for (var i = 0; i < MODES.length; i++) {
                (function (m) {
                    row.button(m.name, Styles.flatTogglet, run(function () {
                        cfg.mode = m.id;
                    })).checked(boolf(function () {
                        return cfg.mode === m.id;
                    }));
                })(MODES[i]);
            }
        })).row();

        c.label(prov(function () {
            return "[lightgray]" + modeInfo(cfg.mode).desc + "[]";
        })).left().padBottom(10).row();

        // Rounds & Options row
        c.table(cons(function (opts) {
            opts.left();
            opts.add("[accent]Rounds:[]").padRight(8);
            for (var i = 0; i < ROUND_COUNTS.length; i++) {
                (function (rc) {
                    opts.button(String(rc), Styles.flatTogglet, run(function () {
                        cfg.rounds = rc;
                    })).size(56, 40).padRight(4).checked(boolf(function () {
                        return cfg.rounds === rc;
                    }));
                })(ROUND_COUNTS[i]);
            }

            opts.add().growX();

            opts.check("Hide Buildings (Pure Terrain)", cfg.hideBuildings, new Boolc({
                get: function (checked) {
                    cfg.hideBuildings = checked;
                }
            })).right();
        })).padBottom(10).row();

        // Personal Best badge
        c.table(Styles.black6, cons(function (pb) {
            pb.margin(8);
            pb.label(prov(function () {
                var best = getBestScore(cfg.pool, cfg.mode, cfg.rounds);
                var maxPts = cfg.rounds * 5000;
                if (best < 0) {
                    return "[lightgray]Personal Best (" + poolInfo(cfg.pool).name + " \u2022 " + modeInfo(cfg.mode).name + "): []No score yet";
                }
                return "[lightgray]Personal Best: [][#ffd37f]" + formatNumber(best) + " / " + formatNumber(maxPts) + "[]";
            }));
        })).row();

        setupDialog.show();
    }

    function showSummaryDialog(isNewPB) {
        if (summaryDialog == null) {
            summaryDialog = new BaseDialog("SectorGuessr - Results");
            summaryDialog.addCloseListener();
        }
        summaryDialog.cont.clear();
        summaryDialog.buttons.clear();

        var maxScore = game.totalRounds * 5000;
        var c = summaryDialog.cont;
        var tableW = Math.min(720, Core.graphics.getWidth() / Scl.scl(1.0) - 60);
        c.defaults().width(tableW);

        c.add("[accent]" + formatNumber(game.totalScore) + "[] [lightgray]/ " + formatNumber(maxScore) + "[]").fontScale(1.6).padBottom(4).row();
        c.add(rankForTotal(game.totalScore, maxScore)).fontScale(1.1).padBottom(4).row();
        if (isNewPB) {
            c.add("[#ffd37f]\u2605 NEW PERSONAL BEST! \u2605[]").padBottom(8).row();
        } else {
            c.add("[lightgray]" + poolInfo(game.pool).name + "  \u2022  " + modeInfo(game.mode).name + "[]").padBottom(8).row();
        }

        // Round-by-round breakdown table
        c.pane(cons(function (list) {
            list.defaults().pad(4);
            list.table(Styles.black6, cons(function (hdr) {
                hdr.margin(6);
                hdr.add("[accent]#[]").width(34).left();
                hdr.add("[accent]Actual Sector[]").growX().left().padRight(12);
                hdr.add("[accent]Your Guess[]").growX().left().padRight(12);
                hdr.add("[accent]Distance[]").width(125).right().padRight(8);
                hdr.add("[accent]Score[]").width(85).right();
            })).growX().row();

            for (var i = 0; i < game.results.length; i++) {
                var r = game.results[i];
                (function (idx, res) {
                    list.table(idx % 2 === 0 ? Styles.black8 : Styles.black6, cons(function (row) {
                        row.margin(6);
                        row.add("[lightgray]" + (idx + 1) + "[]").width(34).left();
                        row.add(sectorShortName(res.actual)).growX().left().ellipsis(true).padRight(12);
                        row.add("[lightgray]" + sectorShortName(res.guess) + "[]").growX().left().ellipsis(true).padRight(12);

                        var distStr;
                        if (res.wrongPlanet) {
                            distStr = "[scarlet]Wrong planet[]";
                        } else if (res.hexDist === 0) {
                            distStr = "[#ffd37f]Exact![]";
                        } else {
                            distStr = (res.hexDist > 0 ? res.hexDist + " hex" : "") + " (" + res.degDist.toFixed(0) + "\u00B0)";
                        }
                        row.add(distStr).width(125).right().padRight(8);
                        row.add(scoreColorTag(res.score) + formatNumber(res.score) + "[]").width(85).right();
                    })).growX().row();
                })(i, r);
            }
        })).maxHeight(300).growX().padBottom(12).row();

        summaryDialog.buttons.button("Play Again", Icon.refresh, run(function () {
            startMatch();
        })).size(200, 60);

        summaryDialog.buttons.button("Change Mode", Icon.settings, run(function () {
            summaryDialog.hide();
            openSetupDialog();
        })).size(200, 60);

        summaryDialog.buttons.button("Close", Icon.cancel, run(function () {
            summaryDialog.hide();
            if (game.returnToPlanet) {
                game.returnToPlanet = false;
                Core.app.post(run(function () {
                    Vars.ui.planet.show();
                }));
            }
        })).size(160, 60);

        summaryDialog.show();
    }

    // -------------------------------------------------------------------------
    // Entry Points: Main Menu Button + Planet Map Button
    // -------------------------------------------------------------------------

    function injectPlanetButton() {
        if (planetButtonInjected || Vars.ui == null || Vars.ui.planet == null) return;
        planetButtonInjected = true;

        Vars.ui.planet.shown(run(function () {
            var existing = Vars.ui.planet.find("sectorguessr-planet-btn-wrap");
            if (existing != null) return;

            var wrap = new Table();
            wrap.name = "sectorguessr-planet-btn-wrap";
            wrap.setFillParent(true);
            wrap.touchable = Touchable.childrenOnly;
            wrap.top();
            wrap.visibility = boolp(function () {
                return Vars.ui.planet.mode != null && Vars.ui.planet.mode.name() === "look";
            });

            wrap.button("SectorGuessr", Icon.planetSmall, Styles.flatBordert, run(function () {
                openSetupDialog();
            })).size(185, 42).padTop(10);

            Vars.ui.planet.addChild(wrap);
        }));
    }

    Events.on(ClientLoadEvent, cons(function () {
        if (Vars.ui != null && Vars.ui.menufrag != null) {
            Vars.ui.menufrag.addButton("SectorGuessr", Icon.planet, run(function () {
                openSetupDialog();
            }));
        }
        injectPlanetButton();
        Log.info("[SectorGuessr] Loaded v1.0 (Serpulo Presets: "
            + collectPoolSectors("serpulo-presets").length
            + ", Erekir Presets: " + collectPoolSectors("erekir-presets").length
            + ", Serpulo Total: " + collectPoolSectors("serpulo-all").length + ")");
    }));
})();
