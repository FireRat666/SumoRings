(function () {
    // Sumo Rings: everyone wears a bumper ring. Bump into other players to knock them off the
    // shrinking platform. The last one standing wins.
    //
    // How pushing works: bumpers have no colliders or rigidbodies. A physical bumper on your own
    // avatar collides with your own player, and physics bodies attached to avatars fight the
    // attachment. Instead every client tracks where each player's bumper is (an empty object
    // attached to their avatar, whose position Unity reports back) and, when an opponent's bumper
    // overlaps yours, pushes only its own player with AddPlayerForce. Each client only ever moves
    // itself, so no one can push their own player and nothing needs syncing per frame.
    let scene;

    // --- Configuration ---
    const STATE_KEY = "sumorings_state";
    const READY_PREFIX = "sumo_ready:";       // "1" while that user stands on the ready pad
    const PRACTICE_PREFIX = "sumo_practice:"; // "1" while that user stands on the practice pad
    const OUT_PREFIX = "sumo_out:";           // "<gameId>" once that player has fallen off
    const BOT_ID = "bot";

    const ARENA_Y = 10;                       // top of the platform
    const LOBBY = { x: 0, y: 10.1, z: -40 };
    const START_RADIUS = 7;
    const MIN_RADIUS = 1.6;
    const SPAWN_RADIUS = 4;

    const TIMINGS = {
        LOBBY_COUNTDOWN: 5000,  // players on the ready pad -> game starts
        GET_READY: 4000,        // in the ring, pushing is off
        FULL_SIZE: 8000,        // ring stays full size for this long once the fight starts
        SHRINK: 60000,          // full -> minimum size
        HOLD_MIN: 15000,        // stays at minimum size
        COLLAPSE: 10000,        // minimum -> gone, so a game always ends
        GAME_OVER: 8000
    };

    const PUSH = {
        CONTACT: 1.1,           // bumper centres closer than this are touching (two 0.55 m bumpers)
        BASE: 2.5,              // m/s shove whenever bumpers touch
        PER_SPEED: 1.6,         // extra m/s per m/s the opponent is moving into you
        MAX: 9,
        UP: 1.2,                // a little lift so the shove is not eaten by ground friction
        COOLDOWN_MS: 350,
        FORCE_MODE: 2           // Unity ForceMode.VelocityChange
    };

    const BOT = { SPEED: 1.4, FRICTION: 2.5 }; // lastPushAt: bot pushed you; lastHitAt: you pushed the bot

    const COLORS = [
        [1, 0.25, 0.2], [0.2, 0.9, 0.3], [0.25, 0.55, 1], [1, 0.9, 0.2],
        [1, 0.3, 1], [0.2, 1, 1], [1, 0.6, 0.15], [0.9, 0.9, 0.9]
    ];

    // --- State ---
    let gameState = { status: "LOBBY", gameId: 0, players: [], practice: false, botOwner: null, winner: null, phaseId: 0 };
    let phaseStartLocal = 0;   // when this client saw the current phase begin (avoids clock skew)
    let lastPhaseId = -1;
    let lastGameId = 0;
    let wasOut = false;        // local player already fell this game

    const trackers = new Map(); // uid -> { obj, visual, pos, vel, lastT, lastPushAt, active }
    let localPose = { pos: null, vel: { x: 0, z: 0 }, lastT: 0 };
    let platform = { root: null, scale: -1, active: true };
    let bot = null;            // { obj, pos, vel, alive, falling, lastPushAt }
    let ui = { boards: [], lobbyStatus: null, muteBtn: null };
    let audio = null;
    let isMuted = false;
    let hostSeenOut = {};      // host: uid -> time it saw that player fall (for draws)
    let hostPending = null;    // host: the state write it is waiting to see come back

    const PN = () => BS.PN || BS.PropertyName;
    const now = () => Date.now();
    const v3 = (x, y, z) => new BS.Vector3(x, y, z);
    const pub = () => (scene.spaceState && scene.spaceState.public) || {};
    const localUid = () => scene.localUser && scene.localUser.uid;

    const isHost = () => {
        if (!scene || !scene.localUser || !scene.users) return false;
        const uids = Object.keys(scene.users).sort();
        return uids.length > 0 && uids[0] === scene.localUser.uid;
    };

    const userName = (uid) => {
        if (uid === BOT_ID) return "Sumo Bot";
        const u = scene.users[uid];
        return u ? u.name : "Someone";
    };

    const colorFor = (uid) => {
        const uids = Object.keys(scene.users).sort();
        let i = uids.indexOf(uid);
        if (uid === BOT_ID) i = 6;
        const c = COLORS[(i < 0 ? 0 : i) % COLORS.length];
        return new BS.Vector4(c[0], c[1], c[2], 0.75);
    };

    // --- Ring size over time (from when this client saw the fight start) ---
    function radiusAt(elapsed) {
        if (elapsed < TIMINGS.FULL_SIZE) return START_RADIUS;
        let t = elapsed - TIMINGS.FULL_SIZE;
        if (t < TIMINGS.SHRINK) return START_RADIUS + (MIN_RADIUS - START_RADIUS) * (t / TIMINGS.SHRINK);
        t -= TIMINGS.SHRINK;
        if (t < TIMINGS.HOLD_MIN) return MIN_RADIUS;
        t -= TIMINGS.HOLD_MIN;
        return Math.max(0, MIN_RADIUS * (1 - t / TIMINGS.COLLAPSE));
    }

    function currentRadius() {
        if (gameState.status !== "ACTIVE") return START_RADIUS;
        return radiusAt(now() - phaseStartLocal);
    }

    // --- Initialization ---
    async function init() {
        if (scene) return;
        scene = BS.BanterScene.GetInstance();
        console.log("SumoRings: starting");

        const settings = new BS.SceneSettings();
        settings.EnableTeleport = false;
        settings.EnableJump = true;
        settings.EnableHandHold = false;
        settings.MaxOccupancy = 30;
        settings.SpawnPoint = new BS.Vector4(LOBBY.x, LOBBY.y, LOBBY.z, 0);
        scene.SetSettings(settings);

        if (!scene.unityLoaded) {
            await new Promise(resolve => {
                scene.On("unity-loaded", resolve);
                window.addEventListener("unity-loaded", resolve, { once: true });
            });
        }
        console.log("SumoRings: Unity loaded");

        await buildLobby();
        await buildArena();
        await buildBoards();
        const audioRoot = await new BS.GameObject({ name: "SumoAudio" }).Async();
        audio = await audioRoot.AddComponent(new BS.BanterAudioSource({ volume: 0.5, loop: false, playOnAwake: false }));

        scene.On("pose-update", (e) => {
            const h = e && e.detail && e.detail.head;
            if (h && h.position) updateLocalPose(h.position);
        });

        scene.On("user-joined", (e) => { addTracker(e.detail.uid); });
        scene.On("user-left", (e) => {
            removeTracker(e.detail.uid);
            if (e.detail.isLocal) return;
            if (isHost()) hostTick();
        });
        scene.On("space-state-changed", () => sync());

        while (!localUid()) await new Promise(r => setTimeout(r, 300));
        for (const uid of Object.keys(scene.users)) addTracker(uid);

        scene.TeleportTo(v3(LOBBY.x, LOBBY.y, LOBBY.z), 0, true);
        sync();
        setInterval(tick, 50);
        setInterval(() => { if (isHost()) hostTick(); }, 250);
        setInterval(updateBoards, 250);
        console.log("SumoRings: ready");
    }

    function play(url) {
        if (!isMuted && audio) audio.PlayOneShotFromUrl(url);
    }

    // --- Lobby: floor, ready pad, practice pad, control panel ---
    async function buildLobby() {
        const floor = await new BS.GameObject({ name: "SumoLobby", localPosition: v3(LOBBY.x, LOBBY.y - 0.3, LOBBY.z) }).Async();
        await floor.AddComponent(new BS.BanterBox({ width: 24, height: 0.5, depth: 24 }));
        await floor.AddComponent(new BS.BoxCollider({ size: v3(24, 0.5, 24) }));
        await floor.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.12, 0.12, 0.14, 1) }));

        await buildPad("ReadyPad", v3(LOBBY.x - 4.5, LOBBY.y, LOBBY.z + 4.5), 3, new BS.Vector4(0.1, 0.8, 0.3, 1),
            "STAND HERE TO PLAY", READY_PREFIX);
        await buildPad("PracticePad", v3(LOBBY.x + 5, LOBBY.y, LOBBY.z + 5), 1.2, new BS.Vector4(0.9, 0.5, 0.1, 1),
            "PRACTICE VS BOT", PRACTICE_PREFIX);

        // Control panel in front of the spawn (BanterUI panels face -Z).
        const panelObj = await new BS.GameObject({ name: "SumoLobbyPanel", localPosition: v3(LOBBY.x, LOBBY.y + 2.6, LOBBY.z + 9) }).Async();
        const panel = await panelObj.AddComponent(new BS.BanterUI(new BS.Vector2(700, 420), false));
        const root = panel.CreateVisualElement();
        await root.Async();
        root.SetStyles({
            width: '100%', height: '100%', backgroundColor: '#1a1c29', display: 'flex', flexDirection: 'column',
            alignItems: 'center', paddingTop: '18px', paddingRight: '24px', paddingBottom: '18px', paddingLeft: '24px',
            borderTopLeftRadius: '12px', borderTopRightRadius: '12px', borderBottomRightRadius: '12px', borderBottomLeftRadius: '12px'
        });
        const title = panel.CreateLabel(undefined, root);
        await title.Async();
        title.text = "SUMO RINGS";
        title.SetStyles({ fontSize: '40px', color: '#ffcc00', backgroundColor: 'rgba(0,0,0,0)', marginBottom: '8px' });

        const rules = panel.CreateLabel(undefined, root);
        await rules.Async();
        rules.text = "Everyone wears a bumper ring. Run into other players to shove them.\n" +
            "The faster you hit, the harder they fly. The ring shrinks over time.\n" +
            "Fall off and you're out. Last one standing wins!\n\n" +
            "Green pad: play (starts when 2+ players stand on it).\nOrange pad: practice alone against a bot.";
        rules.SetStyles({ fontSize: '19px', color: '#ffffff', backgroundColor: 'rgba(0,0,0,0)', whiteSpace: 'normal', marginBottom: '10px' });

        ui.lobbyStatus = panel.CreateLabel(undefined, root);
        await ui.lobbyStatus.Async();
        ui.lobbyStatus.text = "";
        ui.lobbyStatus.SetStyles({ fontSize: '24px', color: '#66ddff', backgroundColor: 'rgba(0,0,0,0)', marginBottom: '10px' });

        const row = panel.CreateVisualElement(root);
        await row.Async();
        row.SetStyles({ display: 'flex', flexDirection: 'row', justifyContent: 'center' });
        const button = async (text, color, handler) => {
            const btn = panel.CreateButton(row);
            await btn.Async();
            btn.text = text;
            btn.SetStyles({ height: '54px', fontSize: '18px', backgroundColor: color, color: '#ffffff', marginRight: '10px',
                paddingTop: '0px', paddingRight: '16px', paddingBottom: '0px', paddingLeft: '16px' });
            btn.OnClick(handler);
            return btn;
        };
        ui.muteBtn = await button("SOUND: ON", '#8033cc', () => {
            isMuted = !isMuted;
            ui.muteBtn.text = isMuted ? "SOUND: OFF" : "SOUND: ON";
        });
        await button("RESET GAME", '#666666', () => {
            const me = scene.localUser;
            if (isHost() || (me && me.isSpaceAdmin)) setState({ status: "LOBBY", players: [], practice: false, botOwner: null, winner: null });
        });
    }

    async function buildPad(name, pos, radius, color, label, prefix) {
        const pad = await new BS.GameObject({ name, localPosition: pos }).Async();
        const disc = await new BS.GameObject({ name: name + "Disc", parent: pad, localPosition: v3(0, 0.01, 0) }).Async();
        await disc.AddComponent(new BS.BanterGeometry({ geometryType: BS.GeometryType.CylinderGeometry, radiusTop: radius, radiusBottom: radius, height: 0.05, radialSegments: 48 }));
        await disc.AddComponent(new BS.BanterMaterial({ shaderName: "Unlit/Diffuse", color }));

        const zone = await new BS.GameObject({ name: name + "Zone", parent: pad, localPosition: v3(0, 1, 0) }).Async();
        await zone.AddComponent(new BS.BoxCollider({ isTrigger: true, size: v3(radius * 1.8, 2, radius * 1.8) }));
        await zone.AddComponent(new BS.BanterColliderEvents());
        const set = (on) => scene.SetPublicSpaceProps({ [prefix + localUid()]: on ? "1" : "0" });
        zone.On("trigger-enter", (e) => { if (e.detail.user && e.detail.user.isLocal) set(true); });
        zone.On("trigger-exit", (e) => { if (e.detail.user && e.detail.user.isLocal) set(false); });

        const labelObj = await new BS.GameObject({ name: name + "Label", parent: pad, localPosition: v3(0, 2.6, radius * 0.7), localScale: v3(0.5, 0.5, 0.5) }).Async();
        const panel = await labelObj.AddComponent(new BS.BanterUI(new BS.Vector2(420, 80), false));
        const root = panel.CreateVisualElement();
        await root.Async();
        root.SetStyles({ width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' });
        const l = panel.CreateLabel(undefined, root);
        await l.Async();
        l.text = label;
        l.SetStyles({ fontSize: '32px', color: '#ffffff', backgroundColor: 'rgba(0,0,0,0)' });
    }

    // --- Arena: one platform object that is scaled to shrink (one update, its collider follows) ---
    async function buildArena() {
        const root = await new BS.GameObject({ name: "SumoPlatform", localPosition: v3(0, ARENA_Y, 0) }).Async();
        platform.root = root;
        platform.tf = await root.GetComponent(BS.CT.Transform);

        // Unit-radius platform; the root's x/z scale is the ring radius.
        const base = await new BS.GameObject({ name: "SumoBase", parent: root, localPosition: v3(0, -0.3, 0) }).Async();
        await base.AddComponent(new BS.BanterGeometry({ geometryType: BS.GeometryType.CylinderGeometry, radiusTop: 1, radiusBottom: 1, height: 0.6, radialSegments: 64 }));
        await base.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.85, 0.75, 0.55, 1) }));
        await base.AddComponent(new BS.MeshCollider({ convex: true }));

        // Painted rings on top (visual only).
        const bands = [[0.93, 1.0, [1, 1, 1]], [0.55, 0.6, [0.8, 0.15, 0.1]], [0.0, 0.12, [0.8, 0.15, 0.1]]];
        for (let i = 0; i < bands.length; i++) {
            const [inner, outer, c] = bands[i];
            const band = await new BS.GameObject({ name: "SumoBand" + i, parent: root, localPosition: v3(0, 0.005 + i * 0.002, 0), localEulerAngles: v3(90, 0, 0) }).Async();
            const geo = inner > 0
                ? { geometryType: BS.GeometryType.RingGeometry, innerRadius: inner, outerRadius: outer, thetaSegments: 64 }
                : { geometryType: BS.GeometryType.CircleGeometry, radius: outer, segments: 32 };
            await band.AddComponent(new BS.BanterGeometry(geo));
            await band.AddComponent(new BS.BanterMaterial({ shaderName: "Unlit/Diffuse", color: new BS.Vector4(c[0], c[1], c[2], 1), side: BS.MaterialSide.Double }));
        }
        setPlatformRadius(START_RADIUS);

        // Falling below the arena means you're out.
        const deadZone = await new BS.GameObject({ name: "SumoDeadZone", localPosition: v3(0, ARENA_Y - 4, 0) }).Async();
        await deadZone.AddComponent(new BS.BoxCollider({ isTrigger: true, size: v3(120, 2, 120) }));
        await deadZone.AddComponent(new BS.BanterColliderEvents());
        deadZone.On("trigger-enter", (e) => { if (e.detail.user && e.detail.user.isLocal) localFell(); });

        // Catch floor far below so spectators who fall don't drop forever before the teleport.
        const net = await new BS.GameObject({ name: "SumoNet", localPosition: v3(0, ARENA_Y - 7, 0) }).Async();
        await net.AddComponent(new BS.BoxCollider({ size: v3(120, 0.5, 120) }));
    }

    function setPlatformRadius(r) {
        if (Math.abs(r - platform.scale) < 0.02) return;
        platform.scale = r;
        const visible = r > 0.05;
        if (visible !== platform.active) { platform.active = visible; platform.root.SetActive(visible); }
        if (visible) platform.tf.localScale = v3(r, 1, r);
    }

    // --- Scoreboards above the ring, facing in ---
    async function buildBoards() {
        const spots = [[0, -11, 0], [0, 11, 180], [11, 0, -90], [-11, 0, 90]];
        for (const [x, z, yaw] of spots) {
            const obj = await new BS.GameObject({ name: "SumoBoard", localPosition: v3(x, ARENA_Y + 5, z), localEulerAngles: v3(0, yaw + 180, 0), localScale: v3(3, 3, 3) }).Async();
            const panel = await obj.AddComponent(new BS.BanterUI(new BS.Vector2(600, 260), false));
            const root = panel.CreateVisualElement();
            await root.Async();
            root.SetStyles({ width: '100%', height: '100%', backgroundColor: 'rgba(20,22,40,0.85)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' });
            const big = panel.CreateLabel(undefined, root);
            await big.Async();
            big.SetStyles({ fontSize: '56px', color: '#ffcc00', backgroundColor: 'rgba(0,0,0,0)' });
            const small = panel.CreateLabel(undefined, root);
            await small.Async();
            small.SetStyles({ fontSize: '26px', color: '#ffffff', backgroundColor: 'rgba(0,0,0,0)', whiteSpace: 'normal' });
            ui.boards.push({ big, small, lastBig: null, lastSmall: null });
        }
    }

    function setBoards(big, small) {
        for (const b of ui.boards) {
            if (b.lastBig !== big) { b.big.text = big; b.lastBig = big; }
            if (b.lastSmall !== small) { b.small.text = small; b.lastSmall = small; }
        }
    }

    function aliveList() {
        const p = pub();
        return (gameState.players || []).filter(uid =>
            (uid === BOT_ID || scene.users[uid]) && p[OUT_PREFIX + uid] !== String(gameState.gameId));
    }

    function updateBoards() {
        if (!ui.boards.length) return;
        const p = pub();
        const elapsed = now() - phaseStartLocal;
        let big = "SUMO RINGS", small = "";
        if (gameState.status === "LOBBY") {
            const ready = Object.keys(scene.users).filter(uid => p[READY_PREFIX + uid] === "1");
            big = "SUMO RINGS";
            small = ready.length ? `${ready.length} on the play pad. Need 2 to start.` : "Stand on the green pad in the lobby to play.";
            if (gameState.countdownAt) {
                const s = Math.max(0, Math.ceil((TIMINGS.LOBBY_COUNTDOWN - elapsed) / 1000));
                big = `STARTING IN ${s}`;
            }
        } else if (gameState.status === "GET_READY") {
            big = `${Math.max(1, Math.ceil((TIMINGS.GET_READY - elapsed) / 1000))}`;
            small = "Get ready to push!";
        } else if (gameState.status === "ACTIVE") {
            const alive = aliveList();
            big = `${alive.length} LEFT`;
            const r = currentRadius();
            small = alive.map(userName).join(", ") + (r < START_RADIUS ? `\nRing: ${r.toFixed(1)} m` : "\nPush them out!");
        } else if (gameState.status === "GAME_OVER") {
            big = gameState.winner ? `${userName(gameState.winner).toUpperCase()} WINS!` : "NO WINNER";
            small = gameState.practice ? "Practice round" : "Back to the lobby soon.";
        }
        setBoards(big, small);
        if (ui.lobbyStatus) ui.lobbyStatus.text = big === "SUMO RINGS" ? small : `${big}  ${small.split("\n")[0]}`;
    }

    // --- Trackers: an empty object attached to each player's body; Unity reports its position ---
    async function addTracker(uid) {
        if (!uid || trackers.has(uid)) return;
        const t = { obj: null, visual: null, pos: null, vel: { x: 0, z: 0 }, lastT: 0, lastPushAt: 0, active: true };
        trackers.set(uid, t);
        try {
            const obj = await new BS.GameObject({ name: "SumoTracker_" + uid }).Async();
            t.obj = obj;
            // Bumper visual: a ring at waist height. Purely visual, no collider.
            const vis = await new BS.GameObject({ name: "SumoBumper_" + uid, parent: obj, localPosition: v3(0, 0, 0), localEulerAngles: v3(90, 0, 0) }).Async();
            await vis.AddComponent(new BS.BanterGeometry({ geometryType: BS.GeometryType.TorusGeometry, radius: 0.5, tube: 0.07, radialSegments: 10, tubularSegments: 32 }));
            await vis.AddComponent(new BS.BanterMaterial({ shaderName: "Unlit/DiffuseTransparent", color: colorFor(uid) }));
            t.visual = vis;
            // Other players are solid so you can't walk through them. Only ever added for other
            // players (never your own), and with no rigidbody, so it can't hit or move yourself.
            if (uid !== localUid()) await obj.AddComponent(new BS.BoxCollider({ size: v3(0.6, 1.4, 0.6) }));
            await scene.LegacyAttachObject(obj, uid, BS.LegacyAttachmentPosition.BODY);
            await obj.WatchTransform([PN().position], (tf) => { if (tf && tf.position) onTrackerMoved(uid, tf.position); });
            console.log("SumoRings: tracking " + userName(uid) + (uid === localUid() ? " (you)" : ""));
        } catch (err) {
            console.warn("SumoRings: could not track " + uid, err);
        }
    }

    function removeTracker(uid) {
        const t = trackers.get(uid);
        if (!t) return;
        trackers.delete(uid);
        try { if (t.obj) t.obj.Destroy(); } catch (e) { }
    }

    function onTrackerMoved(uid, p) {
        const t = trackers.get(uid);
        if (!t) return;
        const tNow = performance.now();
        if (t.pos && t.lastT) {
            const dt = (tNow - t.lastT) / 1000;
            if (dt > 0.005 && dt < 0.5) {
                const k = Math.min(1, dt * 8); // smooth the velocity a little
                t.vel.x += ((p.x - t.pos.x) / dt - t.vel.x) * k;
                t.vel.z += ((p.z - t.pos.z) / dt - t.vel.z) * k;
            }
        }
        t.pos = { x: p.x, y: p.y, z: p.z };
        t.lastT = tNow;
        if (uid === localUid() && !localPose.fromHead) updateLocalPose(p, true);
    }

    function updateLocalPose(p, fromTracker) {
        if (!fromTracker && !localPose.fromHead) { localPose.fromHead = true; console.log("SumoRings: using head pose for your position"); }
        const tNow = performance.now();
        if (localPose.pos && localPose.lastT) {
            const dt = (tNow - localPose.lastT) / 1000;
            if (dt > 0.005 && dt < 0.5) {
                const k = Math.min(1, dt * 8);
                localPose.vel.x += ((p.x - localPose.pos.x) / dt - localPose.vel.x) * k;
                localPose.vel.z += ((p.z - localPose.pos.z) / dt - localPose.vel.z) * k;
            }
        }
        localPose.pos = { x: p.x, y: p.y, z: p.z };
        localPose.lastT = tNow;
    }

    // --- Per-tick: ring size, bumper visibility, pushes on the local player, the practice bot ---
    function tick() {
        if (!platform.root) return;
        setPlatformRadius(gameState.status === "ACTIVE" ? currentRadius() : START_RADIUS);

        const me = localUid();
        const fighting = gameState.status === "ACTIVE";
        const alive = new Set(fighting || gameState.status === "GET_READY" ? aliveList() : []);
        for (const [uid, t] of trackers) {
            const show = alive.has(uid) && uid !== me; // your own bumper would just block your view
            if (t.visual && show !== t.active) { t.active = show; t.visual.SetActive(show); }
        }

        if (fighting && alive.has(me) && localPose.pos) {
            for (const [uid, t] of trackers) {
                if (uid === me || !alive.has(uid) || !t.pos) continue;
                tryPushMe(t.pos, t.vel, t);
            }
            if (bot && bot.alive && !bot.falling) tryPushMe(bot.pos, bot.vel, bot);
        }
        if (bot) tickBot(0.05);
    }

    function tryPushMe(oppPos, oppVel, rec) {
        const me = localPose.pos;
        if (Math.abs(oppPos.y - me.y) > 2.5) return; // opponent is falling / far below
        let dx = me.x - oppPos.x, dz = me.z - oppPos.z;
        let dist = Math.hypot(dx, dz);
        if (dist > PUSH.CONTACT) return;
        const t = now();
        if (t - rec.lastPushAt < PUSH.COOLDOWN_MS) return;
        rec.lastPushAt = t;
        if (dist < 0.01) { const a = Math.random() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); dist = 1; }
        const nx = dx / dist, nz = dz / dist;
        const into = Math.max(0, oppVel.x * nx + oppVel.z * nz);
        const s = Math.min(PUSH.MAX, PUSH.BASE + PUSH.PER_SPEED * into);
        scene.AddPlayerForce(v3(nx * s, PUSH.UP, nz * s), PUSH.FORCE_MODE);
        console.log(`SumoRings: pushed ${s.toFixed(1)} m/s (opponent speed into you ${into.toFixed(1)})`);
    }

    // --- Practice bot: simulated only on the client of the player practising ---
    async function startBot() {
        if (bot) return;
        bot = { obj: null, tf: null, pos: { x: 0, y: ARENA_Y + 1, z: SPAWN_RADIUS }, vel: { x: 0, z: 0 }, push: { x: 0, z: 0 }, alive: true, falling: false, lastPushAt: 0, lastHitAt: 0, fallV: 0, ready: false };
        const b = bot;
        const obj = await new BS.GameObject({ name: "SumoBot", localPosition: v3(b.pos.x, b.pos.y, b.pos.z) }).Async();
        b.obj = obj;
        const body = await new BS.GameObject({ name: "SumoBotBody", parent: obj, localPosition: v3(0, -0.1, 0) }).Async();
        await body.AddComponent(new BS.BanterGeometry({ geometryType: BS.GeometryType.CylinderGeometry, radiusTop: 0.3, radiusBottom: 0.4, height: 1.6, radialSegments: 16 }));
        await body.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.9, 0.4, 0.1, 1) }));
        await body.AddComponent(new BS.BoxCollider({ size: v3(0.6, 1.6, 0.6) }));
        const head = await new BS.GameObject({ name: "SumoBotHead", parent: obj, localPosition: v3(0, 0.9, 0) }).Async();
        await head.AddComponent(new BS.BanterGeometry({ geometryType: BS.GeometryType.SphereGeometry, radius: 0.28, widthSegments: 16, heightSegments: 12 }));
        await head.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(1, 0.8, 0.6, 1) }));
        const ring = await new BS.GameObject({ name: "SumoBotBumper", parent: obj, localPosition: v3(0, 0, 0), localEulerAngles: v3(90, 0, 0) }).Async();
        await ring.AddComponent(new BS.BanterGeometry({ geometryType: BS.GeometryType.TorusGeometry, radius: 0.5, tube: 0.07, radialSegments: 10, tubularSegments: 32 }));
        await ring.AddComponent(new BS.BanterMaterial({ shaderName: "Unlit/DiffuseTransparent", color: colorFor(BOT_ID) }));
        b.tf = await obj.GetComponent(BS.CT.Transform);
        b.ready = true;
        if (bot !== b) obj.Destroy();
    }

    function stopBot() {
        if (!bot) return;
        try { if (bot.obj) bot.obj.Destroy(); } catch (e) { }
        bot = null;
    }

    function tickBot(dt) {
        const b = bot;
        if (!b.ready) return;
        const r = currentRadius();
        if (b.falling) {
            b.fallV += 9.8 * dt;
            b.pos.y -= b.fallV * dt;
            if (b.pos.y < ARENA_Y - 6) { b.falling = false; b.obj.SetActive(false); }
        } else if (gameState.status === "ACTIVE" && b.alive) {
            // Walk at the player, but steer back in when near the edge.
            let wx = 0, wz = 0;
            const me = localPose.pos;
            if (me && Math.abs(me.y - b.pos.y) < 2.5) { wx = me.x - b.pos.x; wz = me.z - b.pos.z; }
            const len = Math.hypot(wx, wz) || 1;
            wx /= len; wz /= len;
            const fromC = Math.hypot(b.pos.x, b.pos.z);
            if (fromC > r - 1.0 && fromC > 0.01) {
                const w = Math.min(1, (fromC - (r - 1.0)) / 0.8);
                wx = wx * (1 - w) - (b.pos.x / fromC) * w;
                wz = wz * (1 - w) - (b.pos.z / fromC) * w;
            }
            b.vel.x = wx * BOT.SPEED + b.push.x;
            b.vel.z = wz * BOT.SPEED + b.push.z;
            const decay = Math.exp(-BOT.FRICTION * dt);
            b.push.x *= decay; b.push.z *= decay;

            // The local player shoves the bot the same way players shove each other.
            if (me && now() - b.lastHitAt > PUSH.COOLDOWN_MS) {
                let dx = b.pos.x - me.x, dz = b.pos.z - me.z;
                const dist = Math.hypot(dx, dz);
                if (dist < PUSH.CONTACT && dist > 0.01 && Math.abs(me.y - b.pos.y) < 2.5) {
                    dx /= dist; dz /= dist;
                    const into = Math.max(0, localPose.vel.x * dx + localPose.vel.z * dz);
                    const s = Math.min(PUSH.MAX, PUSH.BASE + PUSH.PER_SPEED * into);
                    b.push.x += dx * s; b.push.z += dz * s;
                    b.lastHitAt = now();
                    console.log(`SumoRings: you pushed the bot ${s.toFixed(1)} m/s`);
                }
            }
            b.pos.x += b.vel.x * dt;
            b.pos.z += b.vel.z * dt;
            if (Math.hypot(b.pos.x, b.pos.z) > r) {
                b.alive = false; b.falling = true; b.fallV = 0;
                scene.SetPublicSpaceProps({ [OUT_PREFIX + BOT_ID]: String(gameState.gameId) });
                console.log("SumoRings: the bot fell off");
            }
        } else {
            b.vel.x = 0; b.vel.z = 0;
        }
        b.tf.position = v3(b.pos.x, b.pos.y, b.pos.z);
    }

    // --- Local player fell into the dead zone ---
    function localFell() {
        const me = localUid();
        const inGame = (gameState.status === "ACTIVE" || gameState.status === "GET_READY") && (gameState.players || []).includes(me);
        if (inGame && !wasOut) {
            wasOut = true;
            scene.SetPublicSpaceProps({ [OUT_PREFIX + me]: String(gameState.gameId) });
            console.log("SumoRings: you fell off");
            play("https://audiofiles.firer.at/mp3/Tick.mp3");
        }
        scene.TeleportTo(v3(LOBBY.x, LOBBY.y, LOBBY.z), 0, true);
    }

    // --- Shared state ---
    function setState(patch) {
        const next = { ...gameState, ...patch, phaseId: (gameState.phaseId || 0) + 1 };
        // Wait for this write to come back before deciding anything else (see hostTick).
        hostPending = { id: next.phaseId, at: now() };
        scene.SetPublicSpaceProps({ [STATE_KEY]: JSON.stringify(next) });
    }

    function sync() {
        const raw = pub()[STATE_KEY];
        if (!raw) return;
        let s;
        try { s = JSON.parse(raw); } catch (e) { return; }
        const prev = gameState;
        gameState = s;
        if (s.phaseId !== lastPhaseId) {
            lastPhaseId = s.phaseId;
            phaseStartLocal = now();
            onPhase(prev, s);
        }
    }

    function onPhase(prev, s) {
        const me = localUid();
        const playing = (s.players || []).includes(me);
        if (s.status === "GET_READY" && s.gameId !== lastGameId) {
            lastGameId = s.gameId;
            wasOut = false;
            hostSeenOut = {};
            if (s.practice && s.botOwner === me) { stopBot(); startBot(); } else stopBot();
            if (playing) {
                const i = s.players.indexOf(me);
                const a = (i / s.players.length) * Math.PI * 2;
                const x = Math.sin(a) * SPAWN_RADIUS, z = -Math.cos(a) * SPAWN_RADIUS;
                const yaw = ((Math.atan2(-x, -z) * 180 / Math.PI) + 360) % 360; // face the centre
                scene.TeleportTo(v3(x, ARENA_Y + 0.2, z), yaw, true);
                scene.SetPublicSpaceProps({ [READY_PREFIX + me]: "0", [PRACTICE_PREFIX + me]: "0" });
            }
            play("https://audiofiles.firer.at/mp3/Tick.mp3");
        }
        if (s.status === "ACTIVE" && prev.status !== "ACTIVE") play("https://audiofiles.firer.at/mp3/Tick.mp3");
        if (s.status === "GAME_OVER" && prev.status !== "GAME_OVER") {
            console.log("SumoRings: game over, winner " + (s.winner ? userName(s.winner) : "none"));
        }
        if (s.status === "LOBBY" && prev.status !== "LOBBY") {
            stopBot();
            // The winner (or anyone still in the ring) goes back to the lobby.
            if ((prev.players || []).includes(me) && !wasOut) scene.TeleportTo(v3(LOBBY.x, LOBBY.y, LOBBY.z), 0, true);
        }
    }

    // --- Host decides phases and the winner ---
    function hostTick() {
        if (hostPending && lastPhaseId < hostPending.id && now() - hostPending.at < 3000) return;
        hostPending = null;
        const p = pub();
        const t = now();
        const elapsed = t - phaseStartLocal;
        const present = Object.keys(scene.users);

        if (gameState.status === "LOBBY") {
            const ready = present.filter(uid => p[READY_PREFIX + uid] === "1");
            const practice = present.filter(uid => p[PRACTICE_PREFIX + uid] === "1");
            if (ready.length >= 2) {
                if (!gameState.countdownAt) setState({ countdownAt: 1, practice: false });
                else if (elapsed >= TIMINGS.LOBBY_COUNTDOWN) startGame(ready, false);
            } else if (practice.length >= 1 && ready.length === 0) {
                if (!gameState.countdownAt) setState({ countdownAt: 1, practice: true });
                else if (elapsed >= 2000) startGame([practice[0]], true);
            } else if (gameState.countdownAt) {
                setState({ countdownAt: 0 });
            }
            return;
        }

        if (gameState.status === "GET_READY") {
            if (elapsed >= TIMINGS.GET_READY) setState({ status: "ACTIVE" });
            return;
        }

        if (gameState.status === "ACTIVE") {
            const players = gameState.players || [];
            for (const uid of players) {
                const out = p[OUT_PREFIX + uid] === String(gameState.gameId) || (uid !== BOT_ID && !scene.users[uid]);
                if (out && !hostSeenOut[uid]) hostSeenOut[uid] = t;
            }
            const alive = players.filter(uid => !hostSeenOut[uid]);
            if (alive.length === 1 && players.length >= 2) {
                setState({ status: "GAME_OVER", winner: alive[0] });
            } else if (alive.length === 0) {
                // Everyone fell (the ring collapsed): the last to fall wins, if there was a contest.
                let last = null;
                for (const uid of players) if (!last || hostSeenOut[uid] > hostSeenOut[last]) last = uid;
                const tie = players.filter(uid => hostSeenOut[uid] === hostSeenOut[last]).length > 1;
                setState({ status: "GAME_OVER", winner: players.length >= 2 && !tie ? last : null });
            } else if (elapsed > TIMINGS.FULL_SIZE + TIMINGS.SHRINK + TIMINGS.HOLD_MIN + TIMINGS.COLLAPSE + 8000) {
                setState({ status: "GAME_OVER", winner: null }); // safety net
            }
            return;
        }

        if (gameState.status === "GAME_OVER" && elapsed >= TIMINGS.GAME_OVER) {
            setState({ status: "LOBBY", players: [], practice: false, botOwner: null, countdownAt: 0 });
        }
    }

    function startGame(uids, practice) {
        const players = uids.slice().sort();
        if (practice) players.push(BOT_ID);
        hostSeenOut = {};
        setState({
            status: "GET_READY", gameId: now(), players, practice,
            botOwner: practice ? uids[0] : null, winner: null, countdownAt: 0
        });
        console.log("SumoRings: game starting with " + players.map(userName).join(", "));
    }

    if (window.BS) init();
    else window.addEventListener("bs-loaded", init);
})();
