(function () {
    let scene;

    // --- Configuration ---
    const STATE_KEY = "sumopaint_game_state";
    const USER_DATA_KEY_PREFIX = "sumo_user:";
    const TILE_SIZE = 1.2;
    const MAX_RINGS = 12;
    const DROP_INTERVAL_MS = 10000;
    const GAME_ARENA_Y = 15;
    const LOBBY_POS = { x: 0, y: 0.1, z: -40 };

    const RING_COLORS = [
        new BS.Vector4(1, 0.1, 0.1, 1), // Red
        new BS.Vector4(0.1, 1, 0.1, 1), // Green
        new BS.Vector4(0.1, 0.5, 1, 1), // Blue
        new BS.Vector4(1, 1, 0.1, 1),   // Yellow
        new BS.Vector4(1, 0.1, 1, 1),   // Magenta
        new BS.Vector4(0.1, 1, 1, 1)    // Cyan
    ];

    // --- State Variables ---
    let gameState = {
        status: "LOBBY", // LOBBY, ACTIVE, GAME_OVER
        activeRingCount: MAX_RINGS,
        nextDropTime: 0,
        lastWinner: null
    };

    let ringTiles = []; // Array of arrays: ringTiles[ringIndex] = [tileObjects]
    let uiDisplays = [];
    let isMuted = false;
    let audio = { drop: null };

    const isHost = () => {
        if (!scene || !scene.localUser || !scene.users) return false;
        const uids = Object.keys(scene.users).sort();
        return uids.length > 0 && uids[0] === scene.localUser.uid;
    };

    // --- Initialization ---
    async function init() {
        if (scene) return;
        scene = BS.BanterScene.GetInstance();

        setupSettings();

        if (!scene.unityLoaded) {
            await new Promise(resolve => scene.On("unity-loaded", resolve));
        }

        await buildEnvironment();
        await buildArena();
        await setupUI();
        await setupAudio();

        setupNetworking();

        setInterval(update, 100);
        console.log("Sumopaint: Init Complete");
    }

    function setupSettings() {
        const settings = new BS.SceneSettings();
        settings.EnableTeleport = true;
        settings.EnableJump = true;
        settings.SpawnPoint = new BS.Vector4(LOBBY_POS.x, LOBBY_POS.y, LOBBY_POS.z, 0);
        scene.SetSettings(settings);
    }

    async function buildEnvironment() {
        const root = await new BS.GameObject({ name: "SumoEnvironment" }).Async();

        // Lobby
        const floor = await new BS.GameObject({ name: "LobbyFloor", parent: root, localPosition: new BS.Vector3(LOBBY_POS.x, LOBBY_POS.y - 0.05, LOBBY_POS.z) }).Async();
        await floor.AddComponent(new BS.BanterBox({ width: 30, height: 0.5, depth: 30 }));
        await floor.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(30, 0.5, 30) }));
        await floor.AddComponent(new BS.BanterMaterial({ color: new BS.Vector4(0.1, 0.1, 0.1, 1) }));

        // Buttons
        const buttonGroup = await new BS.GameObject({ name: "Controls", parent: floor, localPosition: new BS.Vector3(0, 1.2, 5) }).Async();

        const createBtn = async (name, x, color, text, handler) => {
            const btn = await new BS.GameObject({ name: name, parent: buttonGroup, localPosition: new BS.Vector3(x, 0, 0) }).Async();
            await btn.AddComponent(new BS.BanterBox({ width: 2.5, height: 0.8, depth: 0.5 }));
            await btn.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(2.5, 0.8, 0.5) }));
            await btn.AddComponent(new BS.BanterMaterial({ color: color }));
            btn.SetLayer(5);
            const t = await new BS.GameObject({ name: name + "Text", parent: btn, localPosition: new BS.Vector3(0, 0, -0.3) }).Async();
            await t.AddComponent(new BS.BanterText({ text: text, fontSize: 1, color: new BS.Vector4(1, 1, 1, 1), horizontalAlignment: BS.HorizontalAlignment.Center }));
            btn.On("click", handler);
            return btn;
        };

        await createBtn("JoinSumo", -3, new BS.Vector4(0, 0.5, 1, 1), "JOIN SUMO", () => {
            scene.TeleportTo(new BS.Vector3(0, GAME_ARENA_Y + 2, 0), 0, true);
            if (isHost() && gameState.status === "LOBBY") {
                updateState({ status: "ACTIVE", activeRingCount: MAX_RINGS, nextDropTime: Date.now() + DROP_INTERVAL_MS });
            }
        });

        await createBtn("ResetSumo", 3, new BS.Vector4(0.5, 0.5, 0.5, 1), "RESET", () => {
            if (!isHost()) return;
            updateState({ status: "LOBBY", activeRingCount: MAX_RINGS, nextDropTime: 0 });
        });

        // Death Zone
        const deadZone = await new BS.GameObject({ name: "SumoDeadZone", localPosition: new BS.Vector3(0, 5, 0) }).Async();
        await deadZone.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(200, 2, 200) }));
        await deadZone.AddComponent(new BS.BanterColliderEvents());
        deadZone.On("trigger-enter", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                scene.TeleportTo(new BS.Vector3(LOBBY_POS.x, LOBBY_POS.y, LOBBY_POS.z), 0, true);
            }
        });
    }

    async function buildArena() {
        const arenaRoot = await new BS.GameObject({ name: "ArenaRoot", localPosition: new BS.Vector3(0, GAME_ARENA_Y, 0) }).Async();
        ringTiles = [];

        for (let r = 0; r <= MAX_RINGS; r++) {
            ringTiles[r] = [];
            const radius = r * TILE_SIZE;
            const color = RING_COLORS[r % RING_COLORS.length];

            // Calculate number of tiles to fill the circumference
            const count = r === 0 ? 1 : Math.ceil((2 * Math.PI * radius) / TILE_SIZE);
            const angleStep = (2 * Math.PI) / count;

            for (let i = 0; i < count; i++) {
                const angle = i * angleStep;
                const x = Math.cos(angle) * radius;
                const z = Math.sin(angle) * radius;

                const tile = await new BS.GameObject({
                    name: `SumoTile_R${r}_${i}`,
                    parent: arenaRoot,
                    localPosition: new BS.Vector3(x, 0, z)
                }).Async();

                await tile.AddComponent(new BS.BanterBox({ width: TILE_SIZE - 0.05, height: 0.5, depth: TILE_SIZE - 0.05 }));
                await tile.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(TILE_SIZE - 0.05, 0.5, TILE_SIZE - 0.05) }));
                await tile.AddComponent(new BS.BanterMaterial({ color: color }));

                ringTiles[r].push(tile);
            }
        }
    }

    async function setupUI() {
        const uiRoot = await new BS.GameObject({ name: "SumoUI", localPosition: new BS.Vector3(0, GAME_ARENA_Y + 15, 0) }).Async();
        const dirs = [
            { pos: [0, 0, 20], rot: [0, 0, 0] },
            { pos: [0, 0, -20], rot: [0, 180, 0] },
            { pos: [20, 0, 0], rot: [0, 90, 0] },
            { pos: [-20, 0, 0], rot: [0, -90, 0] }
        ];

        for (let d of dirs) {
            const obj = await new BS.GameObject({ parent: uiRoot, localPosition: new BS.Vector3(...d.pos), localEulerAngles: new BS.Vector3(...d.rot) }).Async();
            const txt = await obj.AddComponent(new BS.BanterText({ text: "SUMO PAINT", fontSize: 10, color: new BS.Vector4(1, 1, 1, 1), horizontalAlignment: BS.HorizontalAlignment.Center }));
            uiDisplays.push(txt);
        }
    }

    async function setupAudio() {
        const audioRoot = await new BS.GameObject({ name: "SumoAudio" }).Async();
        audio.drop = await audioRoot.AddComponent(new BS.BanterAudioSource({ volume: 0.5, loop: false, playOnAwake: false }));
    }

    function setupNetworking() {
        scene.On("space-state-changed", (e) => {
            if (e.detail.changes.some(c => c.property === STATE_KEY)) sync();
        });
        sync();
    }

    function sync() {
        const raw = scene.spaceState.public[STATE_KEY];
        if (!raw) return;
        const oldRingCount = gameState.activeRingCount;
        gameState = JSON.parse(raw);

        // Visual update for rings
        for (let r = 0; r <= MAX_RINGS; r++) {
            const active = r <= gameState.activeRingCount;
            ringTiles[r].forEach(t => t.SetActive(active));
        }

        if (gameState.activeRingCount < oldRingCount && !isMuted) {
            audio.drop.PlayOneShotFromUrl("https://audiofiles.firer.at/mp3/Tick.mp3");
        }
    }

    function update() {
        const now = Date.now();
        const timeRemaining = Math.max(0, Math.ceil((gameState.nextDropTime - now) / 1000));

        let displayStr = "";
        if (gameState.status === "LOBBY") displayStr = "SUMO PAINT\nWAITING FOR HOST";
        else if (gameState.status === "ACTIVE") displayStr = `RING DROPS IN: ${timeRemaining}s\nRINGS LEFT: ${gameState.activeRingCount}`;
        else displayStr = "GAME OVER";

        uiDisplays.forEach(ui => ui.text = displayStr);

        if (isHost()) driveHostLogic(now);
    }

    function driveHostLogic(now) {
        if (gameState.status === "ACTIVE" && now >= gameState.nextDropTime) {
            if (gameState.activeRingCount > 0) {
                updateState({
                    activeRingCount: gameState.activeRingCount - 1,
                    nextDropTime: now + DROP_INTERVAL_MS
                });
            } else {
                updateState({ status: "GAME_OVER", nextDropTime: now + 5000 });
                setTimeout(() => updateState({ status: "LOBBY", activeRingCount: MAX_RINGS }), 5000);
            }
        }
    }

    function updateState(patch) {
        const next = { ...gameState, ...patch };
        scene.SetPublicSpaceProps({ [STATE_KEY]: JSON.stringify(next) });
    }

    if (window.BS) init();
    else window.addEventListener("bs-loaded", init);
})();
