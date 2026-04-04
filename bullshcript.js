(function () {
    let scene;

    // --- Configuration ---
    const STATE_KEY = "sumorings_game_state";
    const USER_DATA_KEY_PREFIX = "sumo_user:";
    const RING_STEP = 1.2;
    const MAX_RINGS = 12;
    const DROP_INTERVAL_MS = 10000;
    const GAME_ARENA_Y = 10;
    const LOBBY_POS = { x: 0, y: 10.1, z: -40 };

    // Use raw arrays here to avoid ReferenceError: BS is not defined
    const RING_COLOR_DATA = [
        [1, 0.1, 0.1, 1], // Red
        [0.1, 1, 0.1, 1], // Green
        [0.1, 0.5, 1, 1], // Blue
        [1, 1, 0.1, 1],   // Yellow
        [1, 0.1, 1, 1],   // Magenta
        [0.1, 1, 1, 1]    // Cyan
    ];
    let ringColors = [];

    // --- State Variables ---
    let gameState = {
        status: "LOBBY", // LOBBY, ACTIVE, GAME_OVER
        activeRingCount: MAX_RINGS,
        nextDropTime: 0,
        lastWinner: null
    };

    let rings = []; // Array of GameObject
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

        // Convert raw color data to BS.Vector4 now that BS is defined
        ringColors = RING_COLOR_DATA.map(c => new BS.Vector4(c[0], c[1], c[2], c[3]));

        console.log("SumoRings: Calling setupSettings.");
        setupSettings();

        if (!scene.unityLoaded) {
            console.log("SumoRings: Waiting for Unity...");
            await new Promise(resolve => {
                scene.On("unity-loaded", resolve);
                window.addEventListener("unity-loaded", resolve, { once: true });
            });
        }
        console.log("SumoRings: Unity Loaded!");

        await buildEnvironment();
        await buildArena();
        await setupUI();
        await setupAudio();

        setupNetworking();

        setInterval(update, 100);
        console.log("SumoRings: Init Complete");
    }

    function setupSettings() {
        const settings = new BS.SceneSettings();
        settings.EnableTeleport = true;
        settings.EnableJump = true;
        settings.SpawnPoint = new BS.Vector4(LOBBY_POS.x, LOBBY_POS.y + 0.05, LOBBY_POS.z, 0);
        scene.SetSettings(settings);
    }

    async function buildEnvironment() {
        const root = await new BS.GameObject({ name: "SumoEnvironment" }).Async();

        // Lobby
        const floor = await new BS.GameObject({ name: "LobbyFloor", parent: root, localPosition: new BS.Vector3(LOBBY_POS.x, LOBBY_POS.y - 0.05, LOBBY_POS.z) }).Async();
        await floor.AddComponent(new BS.BanterBox({ width: 30, height: 0.5, depth: 30 }));
        await floor.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(30, 0.5, 30) }));
        await floor.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.1, 0.1, 0.1, 1) }));

        // Buttons
        const buttonGroup = await new BS.GameObject({ name: "Controls", parent: floor, localPosition: new BS.Vector3(0, 1.2, 10) }).Async();

        const createBtn = async (name, x, color, text, handler) => {
            const btn = await new BS.GameObject({ name: name, parent: buttonGroup, localPosition: new BS.Vector3(x, 0, 0) }).Async();
            await btn.AddComponent(new BS.BanterBox({ width: 2.5, height: 0.8, depth: 0.5 }));
            await btn.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(2.5, 0.8, 0.5) }));
            await btn.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: color }));
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
        rings = [];

        for (let r = 0; r <= MAX_RINGS; r++) {
            const inner = r * RING_STEP;
            const outer = (r + 1) * RING_STEP;
            const color = ringColors[r % ringColors.length];

            // Alternate Y slightly to fix Z-fighting
            const yOffset = (r % 2) * 0.002;

            const ringObj = await new BS.GameObject({
                name: `SumoRing_${r}`,
                parent: arenaRoot,
                localPosition: new BS.Vector3(0, yOffset, 0),
                localEulerAngles: new BS.Vector3(90, 0, 0) // Face up
            }).Async();

            // Corrected BanterGeometry for RingGeometry with Math.PI * 2 to prevent gaps
            await ringObj.AddComponent(new BS.BanterGeometry(
                BS.GeometryType.RingGeometry,
                0, // subdivision
                1, 1, 1, // width, height, depth (unused)
                64, 1, 1, // thetaSegments (high for smoothness), heightSeg, depthSeg
                1, // radius (unused)
                64, // segments (unused)
                0, Math.PI * 2, // thetaStart, thetaLength (Full circle)
                0, Math.PI * 2, // phiStart, phiLength (unused)
                8, // radial segments
                false, // open ended
                1, 1, // radius top/bottom (unused)
                inner, outer // innerRadius, outerRadius
            ));

            await ringObj.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: color, side: BS.MaterialSide.Double }));
            await ringObj.AddComponent(new BS.MeshCollider());

            rings.push(ringObj);
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
            const txt = await obj.AddComponent(new BS.BanterText({ text: "SUMO RINGS", fontSize: 10, color: new BS.Vector4(1, 1, 1, 1), horizontalAlignment: BS.HorizontalAlignment.Center }));
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

        for (let r = 0; r <= MAX_RINGS; r++) {
            const active = r <= gameState.activeRingCount;
            if (rings[r]) rings[r].SetActive(active);
        }

        if (gameState.activeRingCount < oldRingCount && !isMuted) {
            audio.drop.PlayOneShotFromUrl("https://audiofiles.firer.at/mp3/Tick.mp3");
        }
    }

    function update() {
        const now = Date.now();
        const timeRemaining = Math.max(0, Math.ceil((gameState.nextDropTime - now) / 1000));

        let displayStr = "";
        if (gameState.status === "LOBBY") displayStr = "SUMO RINGS\nWAITING FOR HOST";
        else if (gameState.status === "ACTIVE") displayStr = `RING DROPS IN: ${timeRemaining}s\nRINGS LEFT: ${gameState.activeRingCount + 1}`;
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
