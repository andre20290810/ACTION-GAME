(() => {
  'use strict';

  // ---------- Canvas setup ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  // PLAY AREA / CONTROL AREA split (UI relayout): the game's own coordinate
  // space (W/H below) is derived from #play-area's own rendered size, NEVER
  // from window.innerWidth/innerHeight — #control-area is a separate
  // sibling in normal document flow below it, so its height can never
  // shift where the player/GABRIEL/bullets/camera/etc. are positioned.
  // game coordinates are therefore independent of page coordinates, and of
  // however tall the control panel happens to be at any breakpoint.
  const playArea = document.getElementById('play-area');

  let W = 0, H = 0;
  // Extra walkable WORLD space that opens up above the original screen once
  // a boss is fully defeated (PART 21-29) — see the "Stage world / camera"
  // section below. Declared here (not there) so the very first resize()
  // call below can safely set it before anything else runs.
  let worldExtraAbove = 0;
  let cameraY = 0;
  const WORLD_EXTRA_ABOVE_FACTOR = 1.3; // world opens up to 1.3x the screen height taller, post-victory

  // ---------- AREA 1 / AREA 2 vertical stage (SECTION C) ----------
  // The world is now always exactly 2 screens tall during BOSS MODE: AREA 1
  // (south, world Y band [0, H] — pixel-identical to the original
  // single-screen layout) and AREA 2 (north, world Y band [-H, 0]), both
  // drawn with the SAME background asset (see draw()'s stage-tiling loop) —
  // never a second image. worldExtraAbove above stays exactly what it was
  // before this batch (the small post-clear EXIT-hunting bonus space), just
  // now anchored an extra H further north (beyond AREA 2) rather than
  // directly above the original screen — see worldScrollUnlocked()/
  // exitWorldPos(), both re-gated on area2Cleared instead of the old single
  // boss-death check.
  let currentArea = 1;
  let area1Cleared = false;
  let area2Cleared = false;
  // Exponential smoothing rate, in 1/seconds (not a plain per-frame
  // fraction) so the follow speed stays consistent regardless of frame
  // rate — see the camera update in update(): cameraY moves toward its
  // target by (1 - e^(-RATE*dt)) of the remaining distance each frame.
  const CAMERA_FOLLOW_RATE = 6;
  // World Y of the top edge of the given area's own screen-sized band —
  // AREA 1's origin is world Y 0 (unchanged from every pre-existing single-
  // screen coordinate in this file); AREA 2 sits exactly one screen height
  // further north. Threaded through every function that places or clamps
  // something relative to "the current area's own screen," so the exact
  // same relative composition (spawn position, barrel margins, ...) works
  // identically in both areas with no separate code path per area.
  function areaTopY(area) { return area === 2 ? -H : 0; }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = playArea.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    worldExtraAbove = H * WORLD_EXTRA_ABOVE_FACTOR;
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 100));
  resize();

  // ---------- Stage background(s) ----------
  // SECTION K/L/M: this array holds only GABRIEL's 3 encounter backgrounds,
  // indexed by `bossEncounterIndex` (0-2) — see STORY_STAGE_PLAN/SECTION Q
  // further below for how STORY MODE's now-10-STAGE sequence maps onto this.
  // Each entry's `theme` is assigned by actually inspecting the
  // existing art (no new backgrounds generated): stage_b (a cracked open
  // road/tarmac, no walls in frame) is the one plausible OUTDOOR asset;
  // lab_b03 ("LAB B-03", ceiling-lit corridor) and stage_a (an enclosed
  // hangar/loading bay, "A-01", walled on both sides) are both INDOOR —
  // already visually distinct from each other as different source photos,
  // plus a small per-stage tint (`lightTint`) for extra separation per
  // M-3. Same data-driven list shape as before, so nothing else needs to
  // change to add a stage; only the fixed ORDER and the theme/tint fields
  // are new.
  // New-turn SECTION 20: index 0 ('stage_b') is no longer reachable in
  // STORY MODE — its own GABRIEL ENCOUNTER (bossEncounterIndex 0) was
  // removed from STORY_STAGE_PLAN below. Left in place harmlessly (never
  // referenced by any current STAGE) rather than removed, since removing it
  // would shift indices 1/2 and require renumbering bossEncounterIndex
  // everywhere else — see STORY_STAGE_PLAN's own comment for the full
  // reasoning.
  // New-turn SECTION 22/24: floorLeftFrac/floorRightFrac — the walkable
  // floor's own left/right edges, as a fraction of THIS image's own width
  // (0=left edge of the image, 1=right edge), measured by visually
  // inspecting each actual background file. Used only for the AREA1<->AREA2
  // boundary door-collision fix (SECTION 21-25) — see getFloorXRangeWorld().
  // stage_b has none: it's no longer reachable (SECTION 20 above).
  const STAGES = [
    { key: 'stage_b', file: 'assets/stage/stage_b_floor.jpg', theme: 'outdoor', lightTint: 'rgba(0,0,0,0)' },
    { key: 'lab_b03', file: 'assets/stage/lab_b03_floor.png', theme: 'indoor', lightTint: 'rgba(40,60,90,0.10)', floorLeftFrac: 0.08, floorRightFrac: 0.92 }, // re-measured this turn via pixel inspection: wall panels only in the extreme ~6% margins
    { key: 'stage_a', file: 'assets/stage/stage_a_floor.png', theme: 'indoor', lightTint: 'rgba(90,60,30,0.10)', floorLeftFrac: 0.08, floorRightFrac: 0.92 }, // re-measured: wide open floor, wall only at the extreme ~5% margins
  ];
  STAGES.forEach((s) => {
    s.img = new Image();
    s.ready = false;
    s.img.onload = () => { s.ready = true; };
    s.img.src = s.file;
  });
  // PART 5 SECTION E/T: STORY MODE is now a fixed, data-driven 10-STAGE
  // sequence — this ONE table (never scattered if/else) is the single
  // source of truth for what each STORY STAGE position is. `currentStageIndex`
  // (0-9) is the raw STORY STAGE POSITION; it must NEVER be read as if it
  // were the GABRIEL encounter number — `bossEncounterIndex` (0-2, SECTION Q)
  // is the ONLY thing GABRIEL difficulty/DARK PHASE/forced-STUN/barrel-count/
  // GAME CLEAR logic may key off. STAGES[] above (3 backgrounds) is indexed
  // by `bossEncounterIndex`, keeping each encounter's existing visual
  // identity (SECTION S-4).
  // New-turn SECTION 20: the STAGE that used to sit here — { type: 'boss',
  // encounterIndex: 0 }, GABRIEL ENCOUNTER 1, background STAGES[0]
  // ('stage_b', assets/stage/stage_b_floor.jpg — the "A-01" floor with the
  // up-arrow/">>>"/corner hazard-stripe motif) — has been removed from
  // STORY progression entirely per this turn's request. The array is simply
  // one entry shorter now (STAGE 5 becomes the new STAGE 4, etc. — pure
  // array-position renumbering, see the comments below); bossEncounterIndex
  // itself is deliberately left UNCHANGED at 1/2 for the two remaining
  // GABRIEL fights (never renumbered to 0/1) so every encounter-specific
  // system that keys off bossEncounterIndex — STAGES[] background lookup
  // (currentStage()), BOSS_ENCOUNTER_BARREL_COUNTS, getBossDifficultyMultiplier(),
  // the ENCOUNTER 2/3 DARK PHASE gate, and the ENCOUNTER 3 forced-STUN check
  // — needs ZERO changes: they simply never see bossEncounterIndex===0
  // again. STAGES[0]/BOSS_ENCOUNTER_BARREL_COUNTS[0]/difficulty index 0
  // become intentionally unreachable configuration, left in place harmlessly
  // (same convention as this file's other "legacy, no longer set" fields)
  // rather than renumbered, which would risk touching every one of those
  // systems for no functional gain.
  const STORY_STAGE_PLAN = [
    { type: 'drone', speedMult: 1.0, fixedCount: 3 },        // STAGE 1: fixed 3 (SECTION B — never randomized)
    { type: 'drone', speedMult: 1.0, fixedCount: 5 },        // STAGE 2: fixed 5
    { type: 'drone', speedMult: 1.0, fixedCount: 7 },        // STAGE 3: fixed 7
    { type: 'drone', speedMult: 1.3 },                       // STAGE 4 (was STAGE 5) — no fixedCount: 3/5/7 random per AREA, unchanged
    { type: 'drone', speedMult: 1.3 },                       // STAGE 5 (was STAGE 6)
    { type: 'boss', encounterIndex: 1 },                     // STAGE 6 (was STAGE 7): GABRIEL ENCOUNTER 2 (DARK PHASE, 3 BARREL) — encounterIndex intentionally stays 1, see note above
    { type: 'drone', speedMult: 1.5 },                       // STAGE 7 (was STAGE 8)
    { type: 'drone', speedMult: 1.5 },                       // STAGE 8 (was STAGE 9)
    { type: 'boss', encounterIndex: 2, final: true },        // STAGE 9 (was STAGE 10): GABRIEL ENCOUNTER 3, FINAL, 0 BARREL + 3 DRONE
  ];
  // SECTION K/X: per-ENCOUNTER barrel count, indexed by bossEncounterIndex —
  // ENCOUNTER1=5 (this turn: no longer reachable, see SECTION 20 note
  // above), ENCOUNTER2=3 (down from 5), ENCOUNTER3=0 (replaced by the
  // FINAL STAGE's 3 DRONEs instead, SECTION M-5).
  const BOSS_ENCOUNTER_BARREL_COUNTS = [5, 3, 0];
  let currentStageIndex = 0; // 0-9: raw STORY STAGE position (SECTION Q — NEVER the encounter index)
  let bossEncounterIndex = 0; // 0-2: which GABRIEL encounter this is (SECTION Q — the ONLY thing encounter-specific logic may key off)
  // New-turn SECTION 3: true once the FINAL STAGE's own one-time 2nd DRONE
  // wave has been spawned (after the initial 3 are all destroyed) — guards
  // against ever spawning a 3rd wave, and is reset to false every time the
  // FINAL STAGE is (re)entered (enterStoryStage()'s own `plan.final` branch),
  // including via RETRY, so a fresh attempt always starts from "wave 1, not
  // yet respawned" exactly like a brand-new run.
  // PART8 SECTION I: split into ONE flag PER AREA — Area1 and Area2 each run
  // their own independent wave1->wave2 progression (3 die -> 3 more, once),
  // so one Area's wave state can never gate or be gated by the other's.
  let finalDroneRespawnedByArea = { 1: false, 2: false };
  // SECTION S: DRONE-only STORY stages reuse TRAINING_BACKGROUNDS (below) —
  // this index is re-picked fresh every time a drone-type STAGE is entered.
  let storyDroneBgIndex = 0;

  // SECTION D: TRAINING MODE's own separate background pool — the 5
  // attached FIELD images, used exactly as provided (no AI regeneration/
  // re-cropping/design changes), kept fully independent of STORY MODE's
  // STAGES array/currentStageIndex above so TRAINING never shares or
  // interferes with STORY's 3-stage progression. D-4: registering all 5 in
  // the pool doesn't require using them all at once — TRAINING_BG_INDEX
  // just picks which one is currently active (a future SETTING-style
  // picker could reassign it; not required by this turn's spec).
  // New-turn SECTION 22/24: floorLeftFrac/floorRightFrac — see STAGES[]'s
  // own comment above for what these mean.
  const TRAINING_BACKGROUNDS = [
    // PART2-turn SECTION A/AA: re-measured this turn by actually cropping
    // and visually inspecting the top ~35% of each raw asset file (where
    // the door threshold sits) with a 10%-gridline overlay, rather than
    // the previous turn's un-measured guesses — several of those (cargo_lift_e12_a/b,
    // fortress_a01 especially) were significantly too wide, which is the
    // root cause SECTION A's real-device wall-clipping traced back to.
    { key: 'cargo_lift_e12_a', file: 'assets/stages/training/cargo_lift_e12_a.jpg', floorLeftFrac: 0.28, floorRightFrac: 0.70 },
    { key: 'experiment_lab_c09', file: 'assets/stages/training/experiment_lab_c09.jpg', floorLeftFrac: 0.15, floorRightFrac: 0.86 },
    { key: 'cargo_lift_e12_b', file: 'assets/stages/training/cargo_lift_e12_b.jpg', floorLeftFrac: 0.20, floorRightFrac: 0.78 },
    { key: 'shelter_b07', file: 'assets/stages/training/shelter_b07.jpg', floorLeftFrac: 0.17, floorRightFrac: 0.83 },
    { key: 'fortress_a01', file: 'assets/stages/training/fortress_a01.jpg', floorLeftFrac: 0.19, floorRightFrac: 0.81 },
  ];
  TRAINING_BACKGROUNDS.forEach((s) => {
    s.img = new Image();
    s.ready = false;
    s.img.onload = () => { s.ready = true; };
    s.img.src = s.file;
  });
  // PART 4 SECTION O: was a hardcoded const (always index 0) — now mutable
  // so advanceTrainingStage() can randomize it on every AREA2 EXIT, the
  // same way SECURITY TRAINING's own index already worked (O-1).
  let basicTrainingBgIndex = 0;

  // PART 2 SECTION B/D: SECURITY TRAINING picks ONE background from the same
  // TRAINING_BACKGROUNDS pool at session start and keeps using that same one
  // across both AREA1 and AREA2 (re-randomized in resetModeState()).
  let securityTrainingBgIndex = 0;

  // DARK OUT PART 1: the new-content STAGE REGISTRY — every NORMAL/EVENT/BOSS
  // background for the upcoming ROID1/ROID2/ADAM content, registered as one
  // flat, type-tagged table rather than three separate pools, so a single
  // lookup (getStageRegistryEntry()) covers all of them. Deliberately reuses
  // the exact same lazy-load shape TRAINING_BACKGROUNDS/STAGES already use
  // (file/img/ready, populated via the same forEach-with-onload pattern) —
  // no new asset-loading mechanism. floorLeftFrac/floorRightFrac are
  // intentionally omitted here: these backgrounds aren't wired into any real
  // walkable-floor/collision path yet (out of scope for this PART), so
  // fabricating unmeasured fractions would be worse than leaving them unset
  // — getFloorXRangeWorld() already treats "undefined" as "no floor data"
  // and fails open, exactly like the legacy stage_b entry in STAGES[] does.
  //
  // NOT wired into currentStage() / gameState.mode dispatch this PART, per
  // spec — STORY MODE and TRAINING MODE must keep reading STAGES[]/
  // TRAINING_BACKGROUNDS exactly as before. This registry exists purely as
  // an independently loadable, independently verifiable table for now;
  // getStageRegistryEntry() below is its only access point.
  //
  // BOSS entries are fixed 1:1 per the spec (never randomized): c1=ROID1,
  // c2=ROID2, c3=GABRIEL (all 3 encounters share it), c4=ADAM. EVENT entries
  // are fixed to their real usage (b1=PROJECT ADAM pickup, b2=blood-sample
  // hand-in/ADAM activation). NORMAL a1-a5's eventual STORY ordering is
  // deliberately left undecided — they're registered as a flat, unordered
  // pool, not STAGE1-5.
  const STAGE_REGISTRY = [
    { id: 'normal_a1', type: 'normal', background: { file: 'assets/stages/normal/a1.jpg' } },
    { id: 'normal_a2', type: 'normal', background: { file: 'assets/stages/normal/a2.jpg' } },
    { id: 'normal_a3', type: 'normal', background: { file: 'assets/stages/normal/a3.jpg' } },
    { id: 'normal_a4', type: 'normal', background: { file: 'assets/stages/normal/a4.jpg' } },
    { id: 'normal_a5', type: 'normal', background: { file: 'assets/stages/normal/a5.jpg' } },
    { id: 'event_b1_project_adam', type: 'event', background: { file: 'assets/stages/event/b1.jpg' } },
    { id: 'event_b2_adam_lab', type: 'event', background: { file: 'assets/stages/event/b2.jpg' } },
    { id: 'boss_c1_roid1', type: 'boss', background: { file: 'assets/stages/boss/c1.jpg' } },
    { id: 'boss_c2_roid2', type: 'boss', background: { file: 'assets/stages/boss/c2.jpg' } },
    { id: 'boss_c3_gabriel', type: 'boss', background: { file: 'assets/stages/boss/c3.jpg' } },
    { id: 'boss_c4_adam', type: 'boss', background: { file: 'assets/stages/boss/c4.jpg' } },
  ];
  STAGE_REGISTRY.forEach((s) => {
    s.background.img = new Image();
    s.background.ready = false;
    s.background.img.onload = () => { s.background.ready = true; };
    s.background.img.src = s.background.file;
  });
  // The one lookup point for STAGE_REGISTRY — returns the full entry
  // ({id, type, background}) or null if the id doesn't exist. Used for
  // dev/verification loading only this PART (see window.__game export);
  // no gameplay code calls this yet.
  function getStageRegistryEntry(id) {
    return STAGE_REGISTRY.find((s) => s.id === id) || null;
  }

  // DARK OUT PART 3: BOSS BATTLE MODE — an independent battle/dev-test
  // context reachable from MAIN MENU, completely separate from STORY MODE's
  // own progression (currentStageIndex/bossEncounterIndex/STORY_STAGE_PLAN/
  // scenario/item flags are never read or written by anything in this
  // block or by startBossBattle()/exitBossBattle() below — see section 19's
  // own explicit protection list). Fixed BOSS->STAGE_REGISTRY mapping per
  // spec section 8 — never randomized, never derived from STORY state.
  // playable:false (ROID1/ROID2/ADAM) means "shown in BOSS SELECT, but
  // pressing it starts nothing" — sprite registries exist (PART 2) but no
  // AI/state-machine for these three yet (PART 4+), never a paywall.
  const BOSS_BATTLE_TARGETS = {
    roid1: { stageId: 'boss_c1_roid1', label: 'ROID1', playable: false },
    roid2: { stageId: 'boss_c2_roid2', label: 'ROID2', playable: false },
    gabriel: { stageId: 'boss_c3_gabriel', label: 'GABRIEL', playable: true },
    adam: { stageId: 'boss_c4_adam', label: 'ADAM', playable: false },
  };
  const bossBattleState = {
    target: null, // one of BOSS_BATTLE_TARGETS' own keys, or null when no fight is active
    stageId: null, // mirrors BOSS_BATTLE_TARGETS[target].stageId — the ONE thing currentStage() below reads while active
    active: false, // true only for the duration of an actual BOSS BATTLE MODE fight (set by startBossBattle(), cleared by exitBossBattle())
    defeatHandled: false, // guards triggerBossBattleDefeat() (below) from firing more than once per fight
  };
  // SECTION 16: a brief "BOSS DEFEATED" hold before auto-returning to BOSS
  // SELECT — same shape/spirit as the existing gameClearRemainingMs, but a
  // fully separate counter and a separate small draw() block (see near the
  // existing "GAME CLEAR!!" overlay) — never reuses/branches the STORY-only
  // GAME CLEAR->RESULT path, since BOSS BATTLE MODE must never reach RESULT
  // (no STORY stats, no ARTIST PAGE, wrong "return to MAIN MENU" semantics).
  let bossBattleDefeatRemainingMs = 0;
  const BOSS_BATTLE_DEFEAT_DISPLAY_MS = 2000;

  // SECTION D: the ONE place draw()/barrel-spawn/etc. read "the current
  // background" from — returns TRAINING's own pool while in TRAINING MODE,
  // STORY's STAGES otherwise, so every existing caller (draw()'s
  // currentStage().img/.ready, etc.) picks up the right image with no
  // further changes needed anywhere else.
  function currentStage() {
    // DARK OUT PART 3 SECTION 9: checked first, ahead of every existing
    // branch below — BOSS BATTLE MODE's background always comes from the
    // fixed STAGE_REGISTRY mapping above, never from STORY's STAGES[]/
    // bossEncounterIndex or TRAINING_BACKGROUNDS. currentStageIndex itself
    // is never read or written here.
    if (bossBattleState.active) {
      const entry = getStageRegistryEntry(bossBattleState.stageId);
      if (entry) return entry.background;
    }
    if (gameState.mode === 'training') return TRAINING_BACKGROUNDS[basicTrainingBgIndex];
    if (gameState.mode === 'securityTraining') return TRAINING_BACKGROUNDS[securityTrainingBgIndex];
    // SECTION S: a DRONE-type STORY STAGE reads from the same TRAINING
    // background pool (never STAGES[], which is GABRIEL-encounter-only).
    const plan = STORY_STAGE_PLAN[currentStageIndex];
    if (plan && plan.type === 'drone') return TRAINING_BACKGROUNDS[storyDroneBgIndex];
    return STAGES[bossEncounterIndex];
  }

  // New-turn SECTION 21-25: the SAME "cover"-scale + horizontal-center
  // formula draw() already uses to place the current background image —
  // factored out here so the AREA1<->AREA2 door-collision check
  // (getFloorXRangeWorld() below) can compute the EXACT same
  // on-screen image bounds draw() renders, rather than a second, potentially
  // drifting approximation (SECTION 22's own "見た目とコリジョン位置を一致
  // させる" requirement).
  function getStageDrawMetrics(stage) {
    const iw = stage.img.naturalWidth, ih = stage.img.naturalHeight;
    const scale = Math.max(W / iw, H / ih);
    const dw = iw * scale, dh = ih * scale;
    const dx = (W - dw) / 2;
    const baseDy = (H - dh) / 2;
    return { iw, ih, scale, dw, dh, dx, baseDy };
  }

  // PART2-turn SECTION A/B/I: the walkable floor's world/screen X range for
  // the CURRENT background, derived from its own floorLeftFrac/floorRightFrac
  // (a fraction of the image's OWN width — see STAGES[]/TRAINING_BACKGROUNDS'
  // own comments, now measured directly from each actual asset file via
  // pixel inspection rather than guessed) mapped through the SAME dx/dw the
  // image is actually drawn with (getStageDrawMetrics()). This is Y-
  // independent — the background is only ever tiled VERTICALLY (draw()'s own
  // loop), so dx/dw — and therefore the floor's X range — are identical at
  // every world Y for a given background, which is exactly why this same
  // function now also anchors DRONE placement margins (pickSecurityDroneCenterX()/
  // spawnFinalStageDrones()), not just the AREA-boundary door check below.
  // Returns null if the image hasn't loaded yet (fails OPEN — callers must
  // each decide their own safe fallback rather than block against a
  // not-yet-visible background) or declares no floorLeftFrac/floorRightFrac
  // at all (stage_b, no longer reachable in STORY MODE anyway).
  function getFloorXRangeWorld() {
    const stage = currentStage();
    if (!stage || !stage.ready || !stage.img.naturalWidth) return null;
    if (stage.floorLeftFrac === undefined || stage.floorRightFrac === undefined) return null;
    const m = getStageDrawMetrics(stage);
    return { left: m.dx + stage.floorLeftFrac * m.dw, right: m.dx + stage.floorRightFrac * m.dw };
  }
  // PART2-turn SECTION A: every world Y where a background tile boundary —
  // and therefore a "door" opening — actually occurs. Since dh (the drawn
  // tile height) lands almost exactly on H at the portrait aspect ratios
  // this game targets, tile seams fall at Y=0 (AREA1<->AREA2, areaTopY(2))
  // and Y=-H (AREA2<->the post-clear bonus EXIT band) — the only two
  // crossings that exist in this game's actual world structure (SECTION B's
  // own investigation: there is no separate, third tracked "Area" — see
  // worldExtraAbove/exitWorldPos() — only these two boundaries need a door).
  function getAreaBoundaryYs() { return [0, -H]; }

  // PART8 SECTION M/AJ: the ONE shared "is this straight line blocked by an
  // Area-boundary WALL" check — reused for AUTO AIM candidate filtering,
  // player SHOT, enemy projectile (DRONE LASER), and every GABRIEL CLAW
  // kind (including the DEFENSE-counter's own CLAW), so MOVE/AIM/SHOT/CLAW
  // can never disagree about where the wall actually is (AJ's own explicit
  // "判定ズレを防ぐ" requirement). A segment from (x1,y1) to (x2,y2) is
  // blocked only if it crosses one of getAreaBoundaryYs()'s Y values at an
  // X outside the REAL measured door opening (getFloorXRangeWorld()) — the
  // exact same [WALL][DOOR][WALL] geometry clampPlayerToScreen() already
  // enforces for the player's own movement. Fails open (never blocks) if
  // the floor's own bounds aren't measured yet, matching
  // clampPlayerToScreen()'s identical guard.
  function segmentCrossesAreaWall(x1, y1, x2, y2) {
    const floor = getFloorXRangeWorld();
    if (!floor) return false;
    if (y1 === y2) return false; // a horizontal segment can only ever run exactly along a boundary, never cross one
    for (const boundaryY of getAreaBoundaryYs()) {
      if ((y1 - boundaryY) * (y2 - boundaryY) > 0) continue; // both endpoints on the same side of this boundary — no crossing here
      const t = (boundaryY - y1) / (y2 - y1);
      const crossX = x1 + (x2 - x1) * t;
      if (crossX < floor.left || crossX > floor.right) return true; // crosses the WALL part, not the DOOR opening
    }
    return false;
  }
  // How far (in world Y, both directions) around an exact boundary the
  // door-width constraint applies. Kept small and symmetric — just enough
  // that normal per-frame movement speed can never "jump across" the band
  // in one frame (SECTION Z-4's DASH-through-the-wall check) — outside this
  // band, AREA1/AREA2's own full-corridor-width movement is completely
  // unchanged (SECTION 23).
  const AREA_BOUNDARY_DOOR_BAND = 80;

  // PART 5 SECTION Q/T: the ONLY 3 helpers anything should ever use to ask
  // "what kind of STORY STAGE is this" — every DRONE-related system
  // (spawn/update/draw/FIRE-hit/EXIT-unlock/STUN/barrel-count) reads
  // STORY_STAGE_PLAN[currentStageIndex] through these, never `boss.*`
  // (PART 6 SECTION A-2: DRONE systems must stay fully independent of
  // GABRIEL's own visibility/state), and never a raw stage-position number
  // compared directly (SECTION Q-4's own named bug class).
  function isStoryDroneStage() {
    if (gameState.mode !== 'boss') return false;
    const plan = STORY_STAGE_PLAN[currentStageIndex];
    return !!plan && plan.type === 'drone';
  }
  function isFinalStoryStage() {
    if (gameState.mode !== 'boss') return false;
    const plan = STORY_STAGE_PLAN[currentStageIndex];
    return !!plan && plan.type === 'boss' && plan.final === true;
  }
  // Gates every DRONE update/draw/FIRE-hit system: SECURITY TRAINING always,
  // plus any STORY STAGE that has DRONEs present at all (every DRONE-type
  // STAGE, and the FINAL STAGE alongside GABRIEL).
  function isSecurityDroneSystemActive() {
    return gameState.mode === 'securityTraining' || isStoryDroneStage() || isFinalStoryStage();
  }

  // ---------- Sprite loading ----------
  // Only 4 cardinal directions this asset set: UP (back-facing), DOWN
  // (front-facing), LEFT, RIGHT — no diagonals, no separate idle pose.
  // Both AIM and FIRE frames are genuine dedicated renders per direction,
  // so no canvas-side flip is needed.
  const DIRS = ['up', 'down', 'left', 'right'];
  const POSES = ['aim', 'fire'];
  const sprites = {};
  let spritesReady = 0;
  const spritesTotal = DIRS.length * POSES.length;

  POSES.forEach((pose) => {
    sprites[pose] = {};
    DIRS.forEach((dir) => {
      const img = new Image();
      img.src = `assets/alexandre/${dir}_${pose}.png`;
      img.onload = () => { spritesReady++; };
      sprites[pose][dir] = img;
    });
  });

  const SPRITE_DRAW_H = 116; // on-screen character height in px (unchanged)
  let spriteAspect = 384 / 340;
  // Every player sprite (including right_dash/left_dash) is pre-aligned onto
  // this same shared 384x340 canvas with its foot at row 336 (see the
  // *_build_meta.json files) — drawPlayer() always draws that whole canvas
  // centered on player.x/y, so row 336-of-340 is the universal ground
  // baseline for every direction/pose without needing a per-sprite constant.
  const PLAYER_CANVAS_H = 340, PLAYER_FOOT_Y = 336;
  // East/west DASH only, shown 10% smaller than every other sprite (see
  // drawPlayer()) — a display-only shrink with the foot position corrected
  // so it lands on the exact same screen row as before, never lifting or
  // sinking the character (north/south DASH and DASH's game logic/hitbox
  // are all untouched).
  const SIDE_DASH_DISPLAY_SCALE = 0.90;

  // DASH (right/left only) and SOUTH RELAXED IDLE — separate from the
  // aim/fire pose grid above since they're pose overrides, not part of the
  // 4-direction x {aim,fire} cycle. Same shared 384x340 canvas as every
  // other player frame (see assets/alexandre/dash_relaxed_build_meta.json
  // for the exact per-frame crop/scale/anchor measurements), so switching
  // into/out of DASH or RELAXED never jumps or resizes the character.
  const dashSprites = { right: new Image(), left: new Image(), up: new Image(), down: new Image() };
  dashSprites.right.src = 'assets/alexandre/right_dash.png';
  dashSprites.left.src = 'assets/alexandre/left_dash.png';
  dashSprites.up.src = 'assets/alexandre/dash_north.png';
  dashSprites.down.src = 'assets/alexandre/dash_south.png';
  const relaxedSprite = { down: new Image() };
  relaxedSprite.down.src = 'assets/alexandre/down_relaxed.png';

  // NORTH/WEST/EAST/SOUTH ordinary-walk 3-frame cycles (photo-sourced,
  // aligned onto the same shared 384x340 canvas/foot-baseline/center
  // convention as every other player frame — see
  // assets/alexandre/walk_north_west_build_meta.json, walk_east_build_meta.json
  // and batch2_build_meta.json for the exact per-frame crop/scale/anchor
  // measurements). SOUTH's 3rd frame arrived in the 2nd image batch,
  // completing its own cycle — DASH still uses its own dedicated
  // dash_south.png, unaffected.
  const walkSprites = {
    up: [new Image(), new Image(), new Image()],
    left: [new Image(), new Image(), new Image()],
    right: [new Image(), new Image(), new Image()],
    down: [new Image(), new Image(), new Image()],
  };
  walkSprites.up[0].src = 'assets/alexandre/walk_north_1.png';
  walkSprites.up[1].src = 'assets/alexandre/walk_north_2.png';
  walkSprites.up[2].src = 'assets/alexandre/walk_north_3.png';
  walkSprites.left[0].src = 'assets/alexandre/walk_west_1.png';
  walkSprites.left[1].src = 'assets/alexandre/walk_west_2.png';
  walkSprites.left[2].src = 'assets/alexandre/walk_west_3.png';
  walkSprites.right[0].src = 'assets/alexandre/walk_east_1.png';
  walkSprites.right[1].src = 'assets/alexandre/walk_east_2.png';
  walkSprites.right[2].src = 'assets/alexandre/walk_east_3.png';
  walkSprites.down[0].src = 'assets/alexandre/walk_south_1.png';
  walkSprites.down[1].src = 'assets/alexandre/walk_south_2.png';
  walkSprites.down[2].src = 'assets/alexandre/walk_south_3.png';
  const PLAYER_WALK_FRAME_PERIOD_MS = 260; // same cadence as boss WALK_FRAME_PERIOD_MS

  // ---------- Boss sprite loading ----------
  // 13 pre-aligned frames (built offline via alpha-crop + uniform rescale +
  // foot-baseline/center-of-mass anchoring onto one shared 700x920 canvas —
  // see assets/boss/sprite_build_meta.json and
  // assets/boss/defense_dirs_build_meta.json for the exact per-frame
  // measurements). No AI regeneration/redraw; only crop/resize/pad/
  // translate was applied to the original pixels. The 4 DEFENSE frames
  // (defense_south is the original "defense.png" file, kept under that
  // name for continuity) are keyed by asset key -> filename since the key
  // naming (defense_south/_north/_east/_west) differs from the on-disk
  // filename for the south one.
  const BOSS_FRAME_FILES = {
    south_idle: 'south_idle', east_idle: 'east_idle', west_idle: 'west_idle', north_idle: 'north_idle',
    // NORTH has no PRE_ATTACK (per spec) — attack_north is its only attack
    // frame, shown directly. SOUTH alone still goes through a PRE_ATTACK
    // telegraph — EAST/WEST used to telegraph as well, but that PRE_ATTACK
    // has been removed, so their old shared telegraph art (the plain
    // `attack` file) is no longer loaded at all. SOUTH's own former
    // telegraph art (the old dedicated `attack_south` render) is likewise
    // retired from active use — no new dedicated wind-up art was supplied,
    // so the telegraph simply reuses the new release-moment render itself,
    // differentiated from the real release only by its own PRE_ATTACK_SCALE
    // and timing.
    attack_north: 'attack_north',
    attack_south_release: 'attack_south_release',
    attack_west_release: 'attack_west_release',
    attack_east_release: 'attack_east_release',
    preattack_south: 'attack_south_release',
    defense_south: 'defense', defense_north: 'defense_north', defense_east: 'defense_east', defense_west: 'defense_west',
    // SOUTH is a 3-frame cycle again (real-device feedback on the earlier
    // 2-frame version) — see game.js's own SOUTH_WALK_FRAME_PERIOD_MS
    // comment and this batch's south walk asset replacement.
    walk_south_1: 'walk_south_1', walk_south_2: 'walk_south_2', walk_south_3: 'walk_south_3',
    // NORTH (3-frame) / EAST (2-frame) / WEST (2-frame) walk cycles —
    // fully wired in bossFrameName() below. Supersedes the old single-frame
    // walk_east.png/walk_west.png pair (which had its content swapped from
    // its filename — walk_east.png was actually the west-facing render and
    // vice versa); that pair is no longer loaded or referenced anywhere.
    walk_north_1: 'walk_north_1', walk_north_2: 'walk_north_2', walk_north_3: 'walk_north_3',
    walk_east_1: 'walk_east_1', walk_east_2: 'walk_east_2',
    walk_west_1: 'walk_west_1', walk_west_2: 'walk_west_2',
    // STRAIGHT CLAW counterattack — non-directional, used regardless of
    // boss.dir (see straight_claw_build_meta.json).
    straight_claw_windup: 'straight_claw_windup', straight_claw_release: 'straight_claw_release',
  };
  const bossSprites = {};
  let bossSpritesReady = 0;
  Object.entries(BOSS_FRAME_FILES).forEach(([key, file]) => {
    const img = new Image();
    img.src = `assets/boss/${file}.png`;
    img.onload = () => { bossSpritesReady++; };
    bossSprites[key] = img;
  });
  const BOSS_CANVAS_W = 700, BOSS_CANVAS_H = 920; // shared aligned canvas size
  const BOSS_DRAW_H = SPRITE_DRAW_H * 1.5; // ~1.5x player height
  const BOSS_DRAW_W = BOSS_DRAW_H * (BOSS_CANVAS_W / BOSS_CANVAS_H);

  // ---------- Boss CINEMATIC POSE / DOWN (intro / HP-threshold / death only) ----------
  // Two separate, standalone images — never mixed into the normal IDLE/WALK/
  // ATTACK/DEFENSE frame set above, never used as a movement sprite. Used
  // as-is (both images' bboxes already span almost the entire source
  // canvas, so no extra crop was needed) at each image's own aspect ratio
  // rather than forced onto the narrower 700x920 movement-sprite canvas,
  // since their wings are spread wide enough that doing so would clip them.
  //
  // FRONT (south-facing) is the original image; BACK (north/east/west) is a
  // second, distinct photograph — see getCinematicImageFor()/boss.downFacing
  // below for which one is picked. GABRIEL's facing at the moment DOWN/
  // CINEMATIC begins is captured once (boss.downFacing) and never changes
  // mid-sequence, even if something else mutates boss.dir underneath it.
  const cinematicPoseImg = new Image();
  cinematicPoseImg.src = 'assets/boss/cinematic_pose.png';
  const cinematicPoseBackImg = new Image();
  cinematicPoseBackImg.src = 'assets/boss/cinematic_pose_back.png';
  const CINEMATIC_ASPECT = 1176 / 1636; // the front source image's own W/H
  const CINEMATIC_BACK_ASPECT = 1314 / 1692; // the back source image's own W/H
  // Drawn height as a fraction of BOSS_DRAW_H (the normal boss sprite's own
  // on-screen height) — the SAME single constant applies uniformly to
  // intro/30%/60%/90%/death, there is no per-event variation. Reduced by a
  // further 13% (x0.87) from the previously-tuned 0.90, per explicit
  // instruction that the whole DOWN/CINEMATIC family read smaller relative
  // to normal battle sprites (SOUTH WALK/ATTACK, NORTH IDLE/ATTACK, etc,
  // are NOT touched by this — see those scales elsewhere, unchanged).
  const CINEMATIC_SCALE = 0.90 * 0.87; // = 0.783
  const CINEMATIC_DRAW_H = BOSS_DRAW_H * CINEMATIC_SCALE;
  const CINEMATIC_DRAW_W = CINEMATIC_DRAW_H * CINEMATIC_ASPECT;
  // Body-landmark fill fractions of each image's OWN canvas (head-top to
  // feet-bottom / canvas height, and center-x / canvas width) — measured
  // directly off each source's alpha channel; see
  // assets/boss/cinematic_pose_back_build_meta.json for the exact pixel
  // measurements. The front and back photographs fill their own canvases by
  // different amounts, so matching canvas-height scale alone would NOT
  // produce the same on-screen body size — CINEMATIC_BACK_SCALE below
  // corrects for that directly from these measured fractions.
  const CINEMATIC_FRONT_FEET_FRAC = 1633 / 1636;
  const CINEMATIC_FRONT_CENTER_FRAC = 592 / 1176;
  const CINEMATIC_FRONT_BODY_FRAC = (1633 - 284) / 1636;
  const CINEMATIC_BACK_FEET_FRAC = 1688 / 1692;
  const CINEMATIC_BACK_CENTER_FRAC = 597.4 / 1314;
  const CINEMATIC_BACK_BODY_FRAC = (1688 - 351) / 1692;
  const CINEMATIC_BACK_SCALE = CINEMATIC_SCALE * (CINEMATIC_FRONT_BODY_FRAC / CINEMATIC_BACK_BODY_FRAC);
  const CINEMATIC_BACK_DRAW_H = BOSS_DRAW_H * CINEMATIC_BACK_SCALE;
  const CINEMATIC_BACK_DRAW_W = CINEMATIC_BACK_DRAW_H * CINEMATIC_BACK_ASPECT;
  // The front image's own anchor (plain center-on-boss.y/x, offset 0) is the
  // already-shipped baseline; the back image gets an explicit per-axis
  // offset so its OWN body landmark (feet-bottom / center-x) lands at
  // exactly the same on-screen position the front image's would, at their
  // respective drawn sizes — eliminating any foot-position or left/right
  // jump when the DOWN facing switches between front and back.
  const CINEMATIC_FRONT_OFFSET_X = 0;
  const CINEMATIC_FRONT_OFFSET_Y = 0;
  const CINEMATIC_BACK_OFFSET_X =
    CINEMATIC_DRAW_W * (CINEMATIC_FRONT_CENTER_FRAC - 0.5) -
    CINEMATIC_BACK_DRAW_W * (CINEMATIC_BACK_CENTER_FRAC - 0.5);
  const CINEMATIC_BACK_OFFSET_Y =
    CINEMATIC_DRAW_H * (CINEMATIC_FRONT_FEET_FRAC - 0.5) -
    CINEMATIC_BACK_DRAW_H * (CINEMATIC_BACK_FEET_FRAC - 0.5);

  // Picks which CINEMATIC/DOWN image + geometry to use for the CURRENT
  // sequence, based on boss.downFacing (captured once when DOWN begins —
  // see startBossThreshold()/startBossDying()/spawnBoss()). SOUTH uses the
  // original front pose; NORTH/EAST/WEST all share the one back pose.
  function getCinematicImageInfo() {
    if (boss.downFacing === 'south') {
      return {
        img: cinematicPoseImg, w: CINEMATIC_DRAW_W, h: CINEMATIC_DRAW_H,
        offX: CINEMATIC_FRONT_OFFSET_X, offY: CINEMATIC_FRONT_OFFSET_Y,
      };
    }
    return {
      img: cinematicPoseBackImg, w: CINEMATIC_BACK_DRAW_W, h: CINEMATIC_BACK_DRAW_H,
      offX: CINEMATIC_BACK_OFFSET_X, offY: CINEMATIC_BACK_OFFSET_Y,
    };
  }

  // ---------- DARK PHASE (GABRIEL's total-invulnerability shadow state) ----------
  // The shared on-screen anchor point every direction's head image is drawn
  // around (see getDarkPhaseHeadScreenPos()/isAimedAtDarkPhaseHead() below)
  // is fixed independently of which image is actually showing — it was
  // originally derived from the bbox center of a red-eye-glow crop taken out
  // of the very first (single-direction) DARK PHASE render
  // (assets/boss/source/dark_phase_source.png), in that render's own
  // 1152x1728 canvas space. That crop is no longer drawn for any direction
  // (NORTH's own head photo arrived in this batch, completing all 4), but
  // the anchor point itself is kept byte-for-byte identical so the FLASH
  // head-aim hit-test's existing behavior/tuning never changes.
  const DARKPHASE_EYES_SOURCE_W = 1152, DARKPHASE_EYES_SOURCE_H = 1728;
  const DARKPHASE_EYES_CROP_X0 = 534, DARKPHASE_EYES_CROP_Y0 = 269;
  const DARKPHASE_EYES_CROP_X1 = 669, DARKPHASE_EYES_CROP_Y1 = 426;
  // Single anchor point (the crop's own bbox center, in source-canvas
  // coordinates) used for BOTH drawing the head art AND the FLASH head-aim
  // hit-test — see getDarkPhaseHeadScreenPos()/isAimedAtDarkPhaseHead()
  // below, so the two can never drift apart as GABRIEL moves.
  const DARKPHASE_HEAD_CANVAS_X = (DARKPHASE_EYES_CROP_X0 + DARKPHASE_EYES_CROP_X1) / 2;
  const DARKPHASE_HEAD_CANVAS_Y = (DARKPHASE_EYES_CROP_Y0 + DARKPHASE_EYES_CROP_Y1) / 2;
  // PART 19/20: the head display grew 20% (see DARKPHASE_HEAD_DISPLAY_H
  // below) — the hit-test tolerance grows by the same factor so it keeps
  // matching the now-larger visual head area rather than staying pinned to
  // the old (smaller) size or being left arbitrarily oversized.
  const DARKPHASE_HEAD_HIT_RADIUS = 55 * 1.20; // screen px — perpendicular tolerance for the FLASH aim-ray check, see isAimedAtDarkPhaseHead()

  // Direction-aware DARK PHASE heads: all 4 directions now have their own
  // real head render. Each source is alpha-cropped tightly to its own bbox
  // (no rescale/reshape baked into the file — see
  // assets/boss/darkphase_heads_build_meta.json for the exact per-image
  // measurements). south/east/west each record their big red eye's own
  // centroid (found via connected-component analysis to isolate it from the
  // smaller side eyes) as their "eye offset"; north's photo is a back-of-
  // head view with no visible eye, so its offset is a head-center point
  // instead (horizontally centered, vertically at the same ~46.7% head-
  // height fraction the other three directions' eyes sit at) — see the
  // "north" entry's own note in darkphase_heads_build_meta.json. Either way,
  // this per-image offset is where drawing aligns the SHARED anchor point
  // above, so all 4 directions read as the same rotating head regardless of
  // which one is showing.
  const darkPhaseHeadImgs = { south: new Image(), east: new Image(), west: new Image(), north: new Image() };
  darkPhaseHeadImgs.south.src = 'assets/boss/darkphase_head_south.png';
  darkPhaseHeadImgs.east.src = 'assets/boss/darkphase_head_east.png';
  darkPhaseHeadImgs.west.src = 'assets/boss/darkphase_head_west.png';
  darkPhaseHeadImgs.north.src = 'assets/boss/darkphase_head_north.png';
  // Every direction is displayed at the same footprint so no single
  // direction suddenly reads as bigger/smaller than the others — PART 19:
  // 120% of the previous 23px (aspect ratio, and every direction's own
  // eye/head-center anchor offset, both stay proportional automatically
  // since they're derived FROM this same scale below).
  const DARKPHASE_HEAD_DISPLAY_H = 23 * 1.20;
  const DARKPHASE_HEAD_METRICS = {
    south: { nativeW: 746, nativeH: 1285, eyeOffsetX: 361.4, eyeOffsetY: 602.7 },
    east: { nativeW: 771, nativeH: 1277, eyeOffsetX: 688.4, eyeOffsetY: 594.7 },
    west: { nativeW: 771, nativeH: 1281, eyeOffsetX: 81.6, eyeOffsetY: 598.7 },
    north: { nativeW: 789, nativeH: 1276, eyeOffsetX: 394.5, eyeOffsetY: 596.3 },
  };
  Object.keys(DARKPHASE_HEAD_METRICS).forEach((key) => {
    const m = DARKPHASE_HEAD_METRICS[key];
    m.scale = DARKPHASE_HEAD_DISPLAY_H / m.nativeH;
    m.displayW = m.nativeW * m.scale;
    m.displayH = DARKPHASE_HEAD_DISPLAY_H;
    m.eyeOffsetScaledX = m.eyeOffsetX * m.scale;
    m.eyeOffsetScaledY = m.eyeOffsetY * m.scale;
  });
  // Body-fill fraction of the ORIGINAL dark_phase_source.png (measured
  // during the earlier batch that built dark_phase.png — see
  // dark_phase_build_meta.json's body_landmarks), reused here so the eye
  // crop is positioned/scaled as if the full body were drawn at the same
  // size as GABRIEL's normal battle sprites (same method as
  // CINEMATIC_BACK_SCALE), NOT an arbitrary new scale.
  const DARKPHASE_BODY_FRAC = (1654 - 231) / 1728;
  const DARKPHASE_SCALE = CINEMATIC_SCALE * (CINEMATIC_FRONT_BODY_FRAC / DARKPHASE_BODY_FRAC);
  // DARK PHASE STALK/CLOSE-IN/PAUSE/LUNGE/ARC-CLAW/DISENGAGE AI speed/range/
  // timing constants are declared further below (next to BOSS_SPEED/
  // BOSS_ATTACK_RANGE, which several of them derive from).

  // ---------- Explosive barrel (game object, supplied image) ----------
  // The attached render used as-is (real alpha transparency already
  // present, no crop/regeneration applied) — see
  // assets/objects/source/explosive_barrel_source.png for the untouched
  // original. Drawn at a deliberately small scale (not the image's native
  // 512x512) so it reads as a small stage prop, never rivaling the player
  // or boss in size.
  const barrelImg = new Image();
  barrelImg.src = 'assets/objects/explosive_barrel.png';

  // PART7 SECTION R/S: the 5 attached red first-aid-box photos, added
  // verbatim (only non-generative resizing applied — see
  // assets/objects/source/heal_box_N_source.png for the untouched
  // originals) in their exact attachment order 1-5, which HEAL_ITEM_IMAGES'
  // own index order preserves for the SECTION S loop below.
  const HEAL_ITEM_IMAGES = [1, 2, 3, 4, 5].map((n) => {
    const img = new Image();
    img.src = `assets/objects/heal_box_${n}.png`;
    return img;
  });
  // Full draw box (including the image's own transparent margin); the
  // visible drum within it ends up ~26% of the player's height, inside
  // the requested 20-30% band.
  const BARREL_DRAW_H = SPRITE_DRAW_H * 0.30;
  const BARREL_HITBOX_RADIUS = 12; // scaled down to match the smaller draw size
  const BARREL_EXPLOSION_RADIUS = 300; // area-effect range, not tied to the sprite size (3x the previous 100) — PLAYER's own damage-adjacent knockback AND the boss's own knockback both still key off this exact, unchanged value (SECTION C's spec explicitly forbids touching either)
  // SECTION C (this turn): a separate, narrower radius for the BOSS's own
  // explosion DAMAGE reach check only (applyExplosionDamageToBoss() below)
  // — ~82% of BARREL_EXPLOSION_RADIUS, within the requested 80-85% band.
  // Every other barrel-explosion effect (PLAYER knockback, BOSS knockback,
  // the visual explosion itself) still reads BARREL_EXPLOSION_RADIUS above,
  // completely untouched.
  // PART8 SECTION AC/AE: this turn's own further 30% reduction — applied
  // ONLY to this DAMAGE-reach radius (the one genuine "blast damage" radius
  // in the explosion system; BARREL_EXPLOSION_RADIUS above is knockback-only
  // and untouched, exactly as its own comment already requires). Also
  // shared by the FINAL STAGE's DRONE-explosion-vs-GABRIEL damage check
  // (applyDamageToSecurityDrone()), which reads this exact same constant —
  // so both explosion sources get the SAME 30% narrower damage reach.
  const EXPLOSION_DAMAGE_RADIUS_REDUCTION = 0.70; // new radius = old radius * 0.70 (a 30% DEcrease, not "30% of")
  const BARREL_EXPLOSION_DAMAGE_RADIUS_BOSS = BARREL_EXPLOSION_RADIUS * 0.82 * EXPLOSION_DAMAGE_RADIUS_REDUCTION;
  // SECTION E: always 5 barrels — every spawn/restock site below uses this
  // one constant instead of the old random 2-4 range. Positions themselves
  // are still randomized per-barrel every time via pickBarrelSpot().
  const BARREL_COUNT = 5;
  // SECTION F: blast knockback for whoever (player and/or boss) is caught
  // within BARREL_EXPLOSION_RADIUS — separate from damage (applyExplosionDamageToBoss()
  // above is unaffected). Distance-scaled: full strength at the barrel's
  // own center, tapering linearly to 0 exactly at the radius edge.
  const BARREL_EXPLOSION_KNOCKBACK_DISTANCE = 150; // max push, at point-blank — same order of magnitude as the other knockback distances in this file
  const BARREL_EXPLOSION_KNOCKBACK_SUPPRESS_MS = 260;
  // Ceiling-drop restock: when every barrel on stage is gone, a fresh batch
  // falls in from above instead of the field staying permanently empty.
  const BARREL_RESTOCK_DELAY_MIN_MS = 1000, BARREL_RESTOCK_DELAY_MAX_MS = 2000;
  const BARREL_FALL_MS = 550; // ceiling -> landing duration
  const BARREL_FALL_HEIGHT = 460; // px above the landing spot the drop starts from (visual only)

  // ---------- ARC CLAW SLASH (boss melee-range attack) ----------
  // The claw IMAGE is the attack's actual body (real supplied art, no
  // generated/inpainted content) — it travels along a curved Bezier path
  // with its own rotation continuously re-aligned to the live tangent
  // direction (see updateArcClawSlashes()/ARC_CLAW_BASE_TIP_ANGLE below).
  // The thin silver-to-white crescent shape from the earlier Canvas-VFX-only
  // version is kept too, but only as a faint auxiliary slash-trail mark
  // behind the claw image — see drawArcClawImage() (main body) vs
  // drawArcClawCrescentTrail() (auxiliary) in drawArcClawSlash().
  const arcClawImg = new Image();
  let arcClawImgReady = false;
  arcClawImg.onload = () => { arcClawImgReady = true; };
  arcClawImg.src = 'assets/boss/attacks/arc_claw_slash.png';
  // Tip<->base axis of the cropped claw art, measured via PCA of its own
  // opaque-pixel mask (long axis of the elongated claw+speed-line
  // silhouette) — see assets/boss/source/MANIFEST.md batch 7 notes. Used so
  // the sprite's own "pointing" direction lines up with the live tangent
  // angle rather than just spinning in place.
  const ARC_CLAW_BASE_TIP_ANGLE = 2.3594412320307216; // ~135.19deg, unmirrored
  const ARC_CLAW_BASE_TIP_ANGLE_FLIPPED = Math.PI - ARC_CLAW_BASE_TIP_ANGLE; // ~44.81deg, mirrored
  const ARC_CLAW_TIP_LOCAL = { x: 3, y: 1251 }; // tip pixel, cropped-image space
  const ARC_CLAW_IMG_DIAG = 1742.6; // measured tip<->base pixel distance in the cropped source art
  const ARC_CLAW_DRAW_LENGTH = 72; // on-screen tip-to-base length, px — ~62% of SPRITE_DRAW_H(116), within the 45-65% band
  const ARC_CLAW_DRAW_SCALE = ARC_CLAW_DRAW_LENGTH / ARC_CLAW_IMG_DIAG;
  const ARC_CLAW_CRESCENT_BOW = 15; // px, how far the auxiliary crescent trail bows away from its own straight axis
  const ARC_CLAW_LIFETIME_MS = 650; // start -> full wind-through -> finish
  const ARC_CLAW_TRAIL_LEN = 4; // afterimage frames kept
  // Start/end angular deviation from the straight boss->player line, each
  // independently randomized within its own band per PART spec (start:
  // 45-70deg either side; end: 45-90deg the opposite side), giving a total
  // sweep of 90-160deg — enough to read as a real swing, never a full
  // 360deg spin.
  const ARC_CLAW_DEV_START_MIN = 45 * Math.PI / 180, ARC_CLAW_DEV_START_MAX = 70 * Math.PI / 180;
  const ARC_CLAW_DEV_END_MIN = 45 * Math.PI / 180, ARC_CLAW_DEV_END_MAX = 90 * Math.PI / 180;
  const ARC_CLAW_HIT_HALF_LEN_FWD = ARC_CLAW_DRAW_LENGTH * 0.20; // small margin ahead of the exact tip pixel
  const ARC_CLAW_HIT_HALF_LEN_BACK = ARC_CLAW_DRAW_LENGTH * 1.0; // covers the claw body trailing behind the tip
  const ARC_CLAW_HIT_HALF_WIDTH = 16;
  const ARC_CLAW_KNOCKBACK_DISTANCE = 170; // ~1.5x player sprite height (116px), within the requested 1-2x band
  const ARC_CLAW_KNOCKBACK_SUPPRESS_MS = 240;

  // ---------- CLAW STING (PART 8/10: reuses the SAME claw image/VFX above) ----------
  // A straight, fast thrust toward a target LOCKED once at spawn time —
  // clearly distinct from ARC CLAW SLASH's curved sweep, never re-aiming
  // mid-flight (so the player can dodge simply by not being at the locked
  // point anymore once it arrives). Shares arcClawSlashes' array/draw/hit
  // machinery entirely — see spawnClawSting()/updateArcClawSlashes().
  const CLAW_STING_LIFETIME_MS = 380; // quick stab — faster than ARC_CLAW_LIFETIME_MS's full arc
  const CLAW_STING_OVERSHOOT = 1.3; // travels this far past the locked point along the same line, so it reads as a real thrust-through, not a stop-on-a-dime

  // ---------- STRAIGHT CLAW counterattack (guard-break punish) ----------
  // A dedicated, non-directional special counter — triggers when GABRIEL has
  // blocked STRAIGHT_CLAW_TRIGGER_GUARDS consecutive shots in a row while in
  // DEFENSE (see boss.consecutiveGuardedShots / applyBodyHitToBoss()), taking
  // priority over normal AI. Its own boss.state ('straightclaw') owns the
  // whole windup->release->recovery sequence via updateBossStraightClaw() —
  // see the early-return dispatch in updateBoss(), same pattern as
  // intro/darkphase/teleport — so normal CHASE/ATTACK/DEFENSE movement never
  // runs during it. The actual hit uses the SAME straight-line, fixed-
  // rotation motion + oriented-rectangle hitbox as CLAW STING above (a new
  // 'straightClaw' kind in the shared arcClawSlashes array), never ARC CLAW
  // SLASH's curved bezier hitbox.
  const STRAIGHT_CLAW_TRIGGER_GUARDS = 2; // this turn: was 5 — the 2nd consecutive guarded shot now deterministically triggers it (never a random/probabilistic gate — see applyBodyHitToBoss())
  const STRAIGHT_CLAW_WINDUP_MS = 2000; // straight_claw_windup.png shown; no damage/hit/knockback can occur yet
  const STRAIGHT_CLAW_ATTACK_MS = 400; // straight_claw_release.png shown; the actual straight-line hit travels during this window
  // PART8 SECTION T/Z: the DEFENSE-counter's own straightClaw instance
  // travels the SAME total distance in HALF the time (2x average speed) —
  // this system is time-based interpolation (u = elapsed/lifetimeMs), so
  // "2x speed" here means dividing the effective lifetime by this factor.
  // Applies ONLY to the boss.isDefenseCounter-triggered instance (read
  // fresh at spawn, same pattern as piercesDashInvulnerability below) —
  // the close-range proximity COUNTER's own straightClaw (south direction)
  // keeps STRAIGHT_CLAW_ATTACK_MS completely unchanged.
  const COUNTER_CLAW_SPEED_MULTIPLIER = 2.0;
  const STRAIGHT_CLAW_RECOVERY_MS = 600; // straight_claw_release.png still shown; no new hit, GABRIEL still invulnerable
  const STRAIGHT_CLAW_OVERSHOOT = 1.3; // same convention as CLAW_STING_OVERSHOOT — travels past the locked point so it reads as a real thrust-through
  const STRAIGHT_CLAW_HIT_HALF_LEN_FWD = 26; // small margin ahead of the line's end point
  const STRAIGHT_CLAW_HIT_HALF_LEN_BACK = 620; // covers the whole travel back to GABRIEL's own position — a single long thrust, not just its tip
  const STRAIGHT_CLAW_HIT_HALF_WIDTH = 20; // a hair wider than ARC_CLAW's 16 — this is the single, deliberate blow of a punish counter, not a fast graze
  const STRAIGHT_CLAW_KNOCKBACK_DISTANCE = 200; // clearly-visible "blown away" distance, in the same band as ARC_CLAW_KNOCKBACK_DISTANCE (170) but a touch stronger since this is the bigger punish hit
  const STRAIGHT_CLAW_KNOCKBACK_LOCK_MS = 400; // within the requested 300-500ms band

  // COUNTER ATTACK direction split: the pose used by STRAIGHT CLAW's own
  // windup/release images only reads correctly when GABRIEL is facing the
  // player (i.e. the player is south of it, the direction the images were
  // built for) — see boss.counterDir, captured once at trigger time in
  // applyBodyHitToBoss(). When the player is north/east/west instead, the
  // counter reuses the EXISTING per-direction ARC CLAW SLASH attack pose
  // and geometry (no new images), just at double speed.
  // COUNTER_STING_SCALE: the south-direction STING release image's own
  // render scale — real-device feedback said it read too large, 10%
  // smaller. Kept as-is (A-4: this batch's edge-clipping fix must not
  // shrink it further to "solve" the clipping).
  const COUNTER_STING_SCALE = 0.90;
  // COUNTER_WINDUP_SCALE: the shared windup telegraph pose (south/east/west
  // — north instead shows north_idle, see bossFrameName()) got its OWN
  // separate real-device complaint of reading too SMALL, opposite of
  // release's — "current display scale x1.10" = COUNTER_STING_SCALE*1.10,
  // not a fresh 1.10 off the unscaled source, and explicitly independent of
  // release's own (unchanged) 0.90.
  const COUNTER_WINDUP_SCALE = COUNTER_STING_SCALE * 1.10;
  const COUNTER_ARC_CLAW_LIFETIME_MS = ARC_CLAW_LIFETIME_MS / 2; // "2x speed" = half the normal travel time along the SAME bezier geometry — see the 'counterArc' kind in updateArcClawSlashes()
  // SECTION J: north/east/west COUNTER now rolls between the existing 2x
  // ARC CLAW and a new STRAIGHT CLAW variant (reusing spawnStraightClaw()'s
  // own already direction-agnostic straight-line thrust — the same shape
  // south's STING already uses) — see boss.counterAttackKind, rolled once
  // alongside counterDir in applyBodyHitToBoss().
  const COUNTER_STRAIGHT_CLAW_PROB = 0.5;
  // SECTION K: a short screen flicker on the transition into COUNTER, so
  // the player gets a clear "this is now the dangerous invulnerable
  // counter phase" cue — a handful of brief on/off pulses, never a long or
  // fully-opaque flash (deliberately distinct from U-11's one-shot death
  // flash and FLASH GRENADE's own screen flash).
  const COUNTER_FLASH_PULSE_COUNT = 3;
  const COUNTER_FLASH_ON_MS = 70;
  const COUNTER_FLASH_OFF_MS = 70;
  const COUNTER_FLASH_CYCLE_MS = COUNTER_FLASH_ON_MS + COUNTER_FLASH_OFF_MS;
  const COUNTER_FLASH_TOTAL_MS = COUNTER_FLASH_PULSE_COUNT * COUNTER_FLASH_CYCLE_MS;
  const COUNTER_FLASH_ALPHA_MAX = 0.38;
  let counterFlashRemainingMs = 0;
  // COUNTER_DAMAGE_MULTIPLIER/COUNTER_ATTACK_DAMAGE are defined further
  // below, right after BULLET_DAMAGE (the constant they derive from).

  // ---------- Direction bucket mapping (ACTION STICK -> base facing) ----------
  // angle: 0 = right, positive = clockwise (down), atan2(dy, dx), dy-down positive
  function angleToBucket(angle) {
    let deg = angle * 180 / Math.PI;
    deg = ((deg + 180) % 360 + 360) % 360 - 180;
    const a = Math.abs(deg);
    if (a <= 45) return 'right';
    if (a <= 135) return deg > 0 ? 'down' : 'up';
    return 'left';
  }

  // Same 4-way split as angleToBucket, but widens the zone around whichever
  // bucket is already current by a few degrees, so a stick angle sitting
  // right on a 45/135 boundary doesn't flicker between two buckets every
  // frame. The widened margin is small (HYST) so it never perceptibly
  // delays a real direction change — only stabilizes a boundary that's
  // already essentially neutral.
  const STICK_BUCKET_HYSTERESIS_DEG = 6;
  function stickAngleToBucket(angle, prevBucket) {
    let deg = angle * 180 / Math.PI;
    deg = ((deg + 180) % 360 + 360) % 360 - 180;
    const a = Math.abs(deg);
    const H = STICK_BUCKET_HYSTERESIS_DEG;
    if (prevBucket === 'right' && a <= 45 + H) return 'right';
    if (prevBucket === 'left' && a >= 135 - H) return 'left';
    if ((prevBucket === 'up' || prevBucket === 'down') && a > 45 - H && a < 135 + H) {
      return deg > 0 ? 'down' : 'up';
    }
    return angleToBucket(angle);
  }

  // Screen-space meaning is fixed regardless of internal representation:
  // up=true up, right=true right, down=true down, left=true left.
  const BASE_ANGLE = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
  // No longer enforced anywhere in the AIM pipeline (PART 9 removed the old
  // +-60deg wedge — AIM STICK now reaches the full 360deg circle). Left
  // defined, unused, only so any external script still referencing
  // window.__game.HALF_RANGE/clampToHalfRange doesn't hard-crash.
  const HALF_RANGE = Math.PI / 3;

  // ACTION STICK dead zone: fraction of the stick's radius that must be
  // crossed before any direction/movement registers at all. Kept small
  // (~12%) so input feels immediate — big enough only to ignore a resting
  // thumb's tiny involuntary tremor, not to noticeably delay a real push.
  const ACTION_STICK_DEADZONE = 0.12;

  // Returns (angle - center) clamped to +-HALF_RANGE, preserving whichever
  // side of center it's already on (nearest-valid-angle correction). The
  // result is an offset relative to `center`, not an absolute angle.
  // UNUSED by the AIM pipeline since PART 9 — see HALF_RANGE above.
  function clampToHalfRange(angle, center) {
    const TWO_PI = Math.PI * 2;
    let diff = angle - center;
    diff = ((diff + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
    if (diff > HALF_RANGE) diff = HALF_RANGE;
    else if (diff < -HALF_RANGE) diff = -HALF_RANGE;
    return diff;
  }

  // ---------- Player state ----------
  const player = {
    x: 0,
    y: 0,
    lastValidY: 0, // PART2-turn SECTION A: last Y clampPlayerToScreen() itself resolved to — the AREA-boundary wall check's "were we already inside the door band" reference, reset alongside x/y on every stage/mode reset

    speed: 240 * 0.80, // px/sec — PART 28: 80% of the previous 240 (DASH speed/distance untouched)
    baseDir: 'down',   // discrete sprite bucket — driven by AIM STICK while it's engaged, by MOVE STICK otherwise (see update())
    // aimOffsetRaw/aimOffset: ABSOLUTE angles (radians, atan2 convention),
    // not offsets relative to baseDir — PART 9 removed the old +-60deg
    // wedge entirely, so AIM STICK can point anywhere in the full circle.
    // Only meaningful while aiming (aimStickActive or the double-tap lock
    // is active) — getFinalAimAngle() ignores them otherwise. aimOffsetRaw
    // is the raw stick angle; aimOffset is that same angle after AUTO AIM's
    // gentle blend toward a nearby target (see updateAutoAim()).
    aimOffsetRaw: 0,
    aimOffset: 0,
    moving: false,
    // DASH: one of the 4 cardinal directions, always the direction the
    // player is currently facing (baseDir) at the moment DASH is pressed —
    // all 4 now have dedicated dash art, so no horizontal-fallback is
    // needed for south/north anymore.
    dashing: false,
    dashDir: 'right', // 'right' | 'left' | 'up' | 'down' — SPRITE selection only (nearest cardinal)
    dashAngle: 0, // radians — the REAL movement direction (MOVE STICK vector if held, else current facing — see dashButtonPress())
    dashStartAt: -Infinity,
    dashFromX: 0,
    dashFromY: 0,
    dashDistance: 0,
    knockbackUntil: 0, // brief movement-input suppression after a forced-counter KNOCKBACK
    lastCounterDamage: 0, // SECTION 7 future-LIFE placeholder — set to COUNTER_ATTACK_DAMAGE on a landed COUNTER hit (STING or COUNTER ARC CLAW); never subtracted from anything since no LIFE stat exists yet
    // RELAXED IDLE (SOUTH only): tracks how long all inputs have been idle.
    lastActivityAt: performance.now(),
    relaxed: false,
    // STEALTH (PART 13-21): a PLAYER-side status field, deliberately never
    // a boss.state value — `now < player.stealthUntil` while active. Ending
    // (the 5s timer running out) is just this timestamp being in the past;
    // it never itself touches boss.state, so whatever GABRIEL was doing
    // (darkphase, attack, teleport, ...) is left completely alone.
    stealthUntil: -Infinity,
    stealthStartedAt: -Infinity, // for the ~150ms fade-in/out — see getStealthVisualAlpha()
    // SECTION D: 30-shot FIRE magazine, infinite reserve — see FIRE_MAG_SIZE/
    // FIRE_COOLDOWN_MS and the ammo decrement/cooldown logic in update().
    ammo: 30,
    ammoCooldownRemainingMs: 0, // dt-driven (not a `now` deadline) so it correctly freezes during PAUSE, same pattern as the other countdown timers in this file
    reloadType: null, // PART8 SECTION A: 'manual' | 'auto' | null — which duration (MANUAL_RELOAD_MS/EMPTY_RELOAD_MS) the current ammoCooldownRemainingMs countdown is measured against
    // SECTION E: formal LIFE stat, default Infinity (never reduced by
    // attacks at that setting — see applyDamageToPlayerLife()). Max is
    // chosen via the PAUSE MENU / MAIN MENU SETTING (playerMaxLife below).
    life: Infinity,
    // SECTION C (STUN feature, distinct from the SECTION A root-cause fix
    // below): a genuine status-effect flag, separate from isBossIntroLocked()
    // — it never gets that lock's own "MOVE STICK still changes facing"
    // carve-out, since STUN is meant to be a total lockout of MOVE/AIM/FIRE/
    // DASH/FLASH/STEALTH (PAUSE stays usable). See triggerStun()/the PAUSE
    // MENU "Reboot The Control Pannel" handler for how it's set/cleared.
    stunned: false,
  };

  // PART 12/14: the ONE final-angle computation every aim/fire-direction
  // consumer routes through — the dotted aim guide line (drawAimLine()),
  // the RANGE endpoint (derived from this same angle), the FIRE-time bullet
  // spawn angle/velocity (spawnBullet()), AUTO AIM's correction (folded
  // into player.aimOffset by updateAutoAim() before this ever runs), and
  // the FLASH DARK-PHASE-head aim-gate (isAimedAtDarkPhaseHead()). There is
  // no separate portrait/landscape branch anywhere in this file —
  // orientation only ever affects layout (CSS/resize()), never this angle
  // math, so both orientations are guaranteed to derive their aim line and
  // their fired bullet from the exact same number, always.
  //
  // PART 9/10: while the AIM STICK is actively engaged (dragging, or a
  // double-tap snap still locked in), this is player.aimOffset — a full
  // 360deg ABSOLUTE angle, no longer clamped to any wedge around baseDir.
  // baseDir itself is kept in sync with this same angle the whole time (see
  // handleAimStickMove()/performNearestAutoAimSnap()), so an un-aimed shot
  // (AIM STICK not held) still exactly matches whatever the player is
  // currently facing — it just falls back to that facing's own true angle.
  function getFinalAimAngle() {
    if (aimStickActive || performance.now() < aimDoubleTapLockUntil) {
      return player.aimOffset;
    }
    return BASE_ANGLE[player.baseDir];
  }

  function resetPlayerPosition() {
    player.x = W / 2;
    player.y = H / 2;
  }
  resetPlayerPosition();

  // SECTION H: BOSS mode places the player DIRECTLY at the fixed pre-
  // battle/intro pose (the same coordinates spawnBoss() itself uses, always
  // AREA 1) from the very start — never "screen-center, then jump to the
  // intro pose the instant spawnBoss() fires several seconds later" (the
  // previous, visibly-inconsistent behavior). PART 3 SECTION P: BASIC
  // TRAINING and SECURITY TRAINING now start at this exact same position/
  // facing too — investigation found no other system depended on TRAINING's
  // previous separate "screen-center, facing down" default (it was simply
  // never asked to match STORY's own pose until now), so unifying it here
  // is safe and keeps the single source of truth P-1 asks for rather than
  // duplicating these coordinates anywhere else. Safe to call from
  // resetModeState() before `gameState` exists is NOT a concern here since
  // this function itself is only ever called later, at runtime — never at
  // module top-level like the bare resetPlayerPosition() call just above.
  function resetPlayerToBattlePose() {
    player.x = W * 0.50;
    player.y = areaTopY(1) + H * 0.80; // mode start / a fresh STAGE transition both always begin in AREA 1
    player.lastValidY = player.y; // PART2-turn SECTION A: always well outside any boundary band at spawn
    player.baseDir = 'up'; // P-2: facing north, same as STORY's BOSS battle pose
    player.aimOffsetRaw = BASE_ANGLE.up;
    player.aimOffset = BASE_ANGLE.up;
  }

  // Unconditionally applies a new base facing. PART 9/10: AIM STICK is now
  // an independent 360deg control, so changing baseDir (via MOVE STICK, the
  // only remaining caller of setBaseDir()) no longer touches the AIM
  // STICK's own angle/knob at all — those are only ever set by the AIM
  // STICK's own handlers below.
  function forceSetBaseDir(dir) {
    player.baseDir = dir;
    updateAimSectorOverlay();
  }

  function setBaseDir(dir) {
    if (dir === player.baseDir) return;
    forceSetBaseDir(dir);
  }

  // SECTION G: AREA 1 and AREA 2 are both walkable from the very start of
  // the game now — area1Cleared is no longer a gate on this clamp at all
  // (it was the actual mechanism blocking early AREA 2 entry). Only the
  // small post-clear EXIT-hunting bonus space beyond AREA 2 stays gated on
  // worldScrollUnlocked() (area2Cleared), unchanged from before.
  function clampPlayerToScreen() {
    const halfW = (SPRITE_DRAW_H * spriteAspect) / 2;
    const halfH = SPRITE_DRAW_H / 2;
    let topY = -H + halfH; // AREA 1 + AREA 2's own full band, open from the start
    // PART 4 SECTION K/L: TRAINING's own bonus EXIT space must be reachable
    // too, not just STORY's — without this, the player was clamped back
    // out of it before ever reaching TRAINING's EXIT zone.
    if (worldScrollUnlocked() || trainingWorldScrollUnlocked()) {
      topY = -H - worldExtraAbove + halfH;
    }
    player.x = Math.max(halfW, Math.min(W - halfW, player.x));
    player.y = Math.max(topY, Math.min(H - halfH, player.y));

    // PART2-turn SECTION A/B/C (root-cause redo of last turn's fix): a
    // genuine solid WALL at each AREA boundary, with only the door opening
    // passable — [ WALL ][ DOOR ][ WALL ], never a post-hoc "snap sideways
    // into the door" once already inside the band. Last turn's version
    // clamped player.x unconditionally the instant |player.y| entered the
    // band, which (a) used floorLeftFrac/floorRightFrac values that were
    // too wide for several backgrounds (re-measured directly from the
    // actual asset files this turn — see STAGES[]/TRAINING_BACKGROUNDS),
    // and (b) is exactly what produced SECTION C's "sudden AREA1->AREA2
    // warp": snapping x sideways by 50-100+px in the same instant the
    // player's y crosses into the band reads as a teleport even though
    // only x moved. The fix below instead behaves like a real wall: if the
    // player was OUTSIDE the band last frame (player.lastValidY) and this
    // frame's movement would put them INSIDE the band at an x outside the
    // door, their Y is reverted to lastValidY — blocking the crossing
    // outright — while x is left alone, so they can still slide left/right
    // along the wall face to line up with the door, exactly like bumping
    // into a real obstacle. Only if they were ALREADY inside the band last
    // frame (e.g. spawned there) does it fall back to nudging x into the
    // door, as a safety net. Checked at every real tile-boundary Y
    // (getAreaBoundaryYs() — SECTION B: AREA1<->AREA2 at 0, AREA2<->the
    // bonus EXIT band at -H; there is no third tracked Area), and applies
    // identically in every mode (SECTION 24).
    const floor = getFloorXRangeWorld();
    if (floor) {
      const doorLeft = floor.left + halfW, doorRight = floor.right - halfW;
      for (const boundaryY of getAreaBoundaryYs()) {
        if (Math.abs(player.y - boundaryY) > AREA_BOUNDARY_DOOR_BAND) continue;
        if (player.x >= doorLeft && player.x <= doorRight) continue; // inside the door — nothing to block
        const wasOutsideBand = player.lastValidY === undefined || Math.abs(player.lastValidY - boundaryY) > AREA_BOUNDARY_DOOR_BAND;
        if (wasOutsideBand) {
          player.y = player.lastValidY !== undefined ? player.lastValidY : player.y; // block the crossing; x is untouched (slide along the wall)
        } else {
          player.x = Math.max(doorLeft, Math.min(doorRight, player.x)); // already inside the band from a prior frame — nudge into the door rather than getting permanently stuck
        }
      }
    }
    player.lastValidY = player.y;
  }

  // ---------- DASH (4 directions, button-triggered, re-triggerable) ----------
  const DASH_DURATION_MS = 800;
  const DASH_DISTANCE_FRAC = 0.20; // 20% of screen width — within the 15-25% target
  const RELAXED_IDLE_DELAY_MS = 400;

  // angleOverride (radians) lets the DASH button dash along the exact MOVE
  // STICK vector (which may be diagonal) while player.dashDir (nearest
  // cardinal, via angleToBucket — the same 4-way split used everywhere
  // else) still picks which of the 4 existing DASH sprites to show, since
  // no diagonal dash art exists. Omitting it falls back to the player's
  // current facing. Always (re)starts the dash from wherever the player
  // currently is — see dashButtonPress()'s DASH_RETRIGGER_INTERVAL_MS gate,
  // which is what actually limits how often this can be called, not this
  // function itself (so window.__game.requestDash() keeps working for
  // direct verification without also having to fake button-press timing).
  function tryStartDash(now, angleOverride) {
    const angle = (angleOverride === undefined || angleOverride === null) ? BASE_ANGLE[player.baseDir] : angleOverride;
    player.dashing = true;
    player.dashAngle = angle;
    player.dashDir = angleToBucket(angle);
    player.dashStartAt = now;
    player.dashFromX = player.x;
    player.dashFromY = player.y;
    // Same distance value on every axis (screen-width based, not
    // screen-height) so vertical DASH feels like the same distance as
    // horizontal DASH instead of being stretched on tall portrait screens.
    player.dashDistance = W * DASH_DISTANCE_FRAC;
    player.lastActivityAt = now;
  }

  // debug/verification only — see tryStartDash()'s comment above.
  function requestDash(now, angleOverride) {
    tryStartDash(now, angleOverride);
  }

  // Fast burst then a short settle, not a constant 0.8s slide: full travel
  // distance is reached by 45% of the duration (ease-out cubic), the
  // remaining time is just the recovery/invulnerability tail.
  function dashTravelProgress(t) {
    const travelPortion = 0.45;
    if (t >= travelPortion) return 1;
    const u = t / travelPortion;
    return 1 - Math.pow(1 - u, 3);
  }

  function updateDash(now) {
    if (!player.dashing) return;
    const elapsed = now - player.dashStartAt;
    if (elapsed >= DASH_DURATION_MS) {
      player.dashing = false;
      return;
    }
    // Real movement always follows the exact dashAngle (which may be a
    // diagonal from the MOVE STICK) — dashDir only ever affects which
    // sprite is drawn, never the actual travel vector.
    const progress = dashTravelProgress(elapsed / DASH_DURATION_MS);
    player.x = player.dashFromX + Math.cos(player.dashAngle) * player.dashDistance * progress;
    player.y = player.dashFromY + Math.sin(player.dashAngle) * player.dashDistance * progress;
  }

  // Single source of truth for "can the player be damaged right now" — DASH
  // grants full invulnerability to every enemy-origin hit for its whole
  // 0.8s duration (boss melee, boss claw projectile, any future source).
  function isPlayerInvulnerable() {
    return player.dashing;
  }

  // ---------- Boss ----------
  // State machine: CHASE -> ATTACK -> RECOVER -> CHASE, with DEFENSE now
  // entered instantly the moment any body shot lands (not after a hit
  // count) — see applyBodyHitToBoss(). Only 4 facing directions
  // (north/south/east/west), chosen from the boss's movement vector the
  // same way the player's ACTION STICK picks a direction bucket
  // (angleToBucket + BASE_ANGLE keys, mapped to the boss's asset names).
  const BOSS_HP_MAX = 5000; // 5x the previous 1000
  const HUD_BAR_W = 90, HUD_BAR_H = 6; // SECTION E/F/V: shared PLAYER LIFE / BOSS LIFE gauge size — declared early since it's referenced from the window.__game debug-exposure literal further down
  const HUD_MARGIN_X = 10; // SECTION E/F/V: shared HUD side margin — same early-declaration reason as HUD_BAR_W/HUD_BAR_H above
  // SECTION B: CONTROL RECOVERY WATCHDOG — a defensive mechanism, wholly
  // separate from the STUN game mechanic itself (see triggerStun() and
  // SECTION I's own explicit independence requirement). lastPlayerInputAt
  // is bumped by every real MOVE/AIM/FIRE/DASH/FLASH/STEALTH input (never
  // by PAUSE) — see update()'s movement block and the DASH/FLASH/STEALTH
  // press handlers. Declared early for the same window.__game-literal
  // forward-reference reason as HUD_BAR_W above.
  let lastPlayerInputAt = 0;
  const CONTROL_WATCHDOG_IDLE_MS = 4000;
  // SECTION D: how fast the orange STUN LIFE bar pulses — within the
  // requested 500-700ms band, deliberately NOT a fast/flashy blink.
  const STUN_LIFE_PULSE_MS = 600;
  // SECTION M/N: the one confirmed official artist page URL (provided
  // directly this turn) — used by both GAME OVER and RESULT's own ARTIST
  // PAGE links, so it only ever needs updating in one place.
  const ARTIST_PAGE_URL = 'https://www.tunecore.co.jp/artists?id=1140292&utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAdGRleAUBDaFwZG9mAmZkaWQWUNfnDNp7K4OsR1rDORVcLG0AXA4O12V4dG4DYWVtAjExAHNydGMGYXBwX2lkDzEyNDAyNDU3NDI4NzQxNAABpwXbm4sakBiMJ9ZlYKC8rJYDSVbb6nyHcFcsnqaYmSRyGKJCnX_N71DFNmgD_aem_YS0e_NpMoesX0DHRet6cWQ';
  const BOSS_SPEED = 78; // px/sec — 60% of the previous 130 (was too fast to react to). Kept as-is: DARK PHASE's STALK/CLOSE-IN/LUNGE/DISENGAGE speeds below are all derived from this and must not drift.
  // PART 29/30: normal CHASE-state movement only, ×0.90 — a separate
  // constant (not a mutation of BOSS_SPEED itself) so DARK PHASE's own
  // speeds above stay completely untouched. Player MOVE speed is now 192
  // (240×0.80) vs this 70.2, still comfortably faster than GABRIEL.
  const BOSS_CHASE_SPEED = BOSS_SPEED * 0.90;
  const BOSS_ATTACK_RANGE = 130; // distance at which CHASE -> ATTACK
  const BOSS_ATTACK_WINDUP_MS = 400;
  const BOSS_ATTACK_ACTIVE_MS = 150;
  const BOSS_ATTACK_REACH = 108; // forward offset of the claw hitbox center
  const BOSS_ATTACK_HIT_RADIUS = 68;
  const BOSS_RECOVER_MS = 350;
  // SECTION N: per-ENCOUNTER difficulty scaling — currentStageIndex IS the
  // encounter index (0/1/2), see the STAGES reorder above. Managed through
  // this one function rather than editing the base constants directly, so
  // every consumer (movement below, RECOVER's own cooldown) stays in sync
  // and the base BOSS_SPEED/BOSS_CHASE_SPEED/BOSS_RECOVER_MS constants
  // remain each ENCOUNTER's true baseline (encounter 1 == the multiplier
  // 1.00 case, i.e. unchanged from before this section).
  const BOSS_DIFFICULTY_TABLE = [
    { movement: 1.00, attackFrequency: 1.00 },
    { movement: 1.10, attackFrequency: 1.15 },
    { movement: 1.20, attackFrequency: 1.30 },
  ];
  function getBossDifficultyMultiplier(encounterIndex) {
    const i = Math.max(0, Math.min(BOSS_DIFFICULTY_TABLE.length - 1, encounterIndex));
    return BOSS_DIFFICULTY_TABLE[i];
  }
  const BOSS_DEFENSE_MS = 1800;
  const BOSS_HURT_RADIUS = 46; // small torso-only hurtbox, not the full sprite
  const BULLET_DAMAGE = 40;
  // COUNTER ATTACK damage placeholder (SECTION 7): the player has no LIFE/HP
  // stat yet, so this is never subtracted from anything — it's derived from
  // BULLET_DAMAGE (the only "normal attack damage" constant that exists
  // anywhere in this game) purely so a future LIFE system has a single,
  // already-scaled number to read (player.lastCounterDamage, set on a
  // COUNTER hit — see updateArcClawSlashes()). Both the south STING variant
  // and the north/east/west COUNTER ARC CLAW variant use this SAME multiplier.
  const COUNTER_DAMAGE_MULTIPLIER = 1.3;
  const COUNTER_ATTACK_DAMAGE = BULLET_DAMAGE * COUNTER_DAMAGE_MULTIPLIER;
  // GUARD BREAK: a valid AUTO-AIM-assisted hit during DEFENSE (weak point or,
  // where none exists, the body target AUTO AIM falls back to) counts toward
  // this; the 4th one breaks DEFENSE outright into a brief stagger and then
  // straight into ATTACK, instead of just chipping the guard down forever.
  const DEFENSE_GUARD_BREAK_HITS = 4;
  const GUARD_BREAK_PAUSE_MS = 250;
  // Separate from GUARD BREAK above: ANY valid weak-point damage hit
  // (manually aimed or AUTO-AIM-assisted) counts toward this one, so a
  // player who only ever lands manual precision shots — never triggering
  // GUARD BREAK's AUTO-AIM-only counter — still eventually gets forced off
  // the weak point. In practice GUARD BREAK's lower threshold (4) always
  // preempts this (5) when every hit happens to be AUTO-AIM-assisted, so
  // the two never double-fire on the same hit — see applyWeakPointHitToBoss().
  const WEAKPOINT_FORCED_COUNTER_HITS = 5;
  const KNOCKBACK_DISTANCE = 110; // px, pushed directly away from the boss
  const KNOCKBACK_SUPPRESS_MS = 280; // brief movement-input suppression, not a full stun
  // POINT-BLANK counter: a shot fired while the player is standing almost
  // on top of GABRIEL (rushing in to farm the weak point/GUARD BREAK at
  // zero risk) deals no damage at all — GABRIEL briefly can't be damaged
  // and instead shoves the player back out to a normal fighting distance,
  // reusing the same knockback + input-suppression machinery as the
  // weak-point forced counter below. Scoped to ordinary combat states only
  // (see the gate at the bullet/boss collision check) — DARK PHASE's own
  // close-in AI must never be undermined by this.
  const CLOSE_RANGE_SHOT_THRESHOLD = 70; // px, player<->boss distance at/under which a shot counts as point-blank
  // SECTION I: derived from the ARC CLAW's own actual measured reach —
  // ARC_CLAW_HIT_HALF_LEN_BACK (= ARC_CLAW_DRAW_LENGTH * 1.0 = 72px, see
  // its own definition above) is the real distance behind a CLAW's live
  // tip that still registers a hit, i.e. the genuine "the claw is
  // guaranteed to connect from here" range — not a value picked by eye.
  // It lands almost exactly on the pre-existing CLOSE_RANGE_SHOT_THRESHOLD
  // (70px, the point-blank BULLET counter's own distance), confirming that
  // constant was already implicitly calibrated to "within the claw's own
  // physical reach."
  const BOSS_CLOSE_COUNTER_DISTANCE = ARC_CLAW_HIT_HALF_LEN_BACK;
  // SECTION J: DARK PHASE guarantee — if ENCOUNTER 2/3 hasn't organically
  // triggered DARK PHASE (4 AUTO-AIM hits) by the time HP drops to this
  // fraction, force it right then. Deliberately NOT one of the existing
  // 70%/40%/10%-remaining THRESHOLD cinematic checkpoints (never collides
  // with those), positioned comfortably mid-fight so it is guaranteed to
  // be crossed before the boss can die (HP only ever decreases).
  const DARK_PHASE_GUARANTEE_HP_FRAC = 0.5;
  const CLOSE_RANGE_COUNTER_INVULN_MS = 300; // GABRIEL's own brief invulnerability after the counter fires
  // ANY 4 valid AUTO-AIM-assisted damage hits (body or weak point, in any
  // boss state — distinct from GUARD BREAK's DEFENSE-only counter) send the
  // boss into DARK PHASE — total damage immunity (this time including
  // barrel explosions, unlike DEFENSE) with a SLASH/STING-only AI,
  // specifically to interrupt sustained normal-fire spam rather than to
  // punish/reward anything about DEFENSE specifically. DARK PHASE has NO
  // timeout of its own — see startBossDarkPhase()/updateBossDarkPhase() —
  // the only way out is a successful FLASH GRENADE.
  const AUTO_AIM_INVULN_HITS = 4;
  const DARKPHASE_FADE_MS = 450; // within the requested 300-600ms band, both fade-in AND fade-out
  // Drawn UNDER the player/bullets/claw attacks (see draw()) rather than as
  // a final full-screen overlay on top of everything, so it can go this
  // dark — near-total black — without also dimming the things that must
  // stay clearly visible. Not literal 255 alpha (never an instant pure-
  // black cut, and a hair of the background stays technically present).
  const DARKPHASE_OVERLAY_ALPHA = 0.97;
  // DARK PHASE AI (SECTION C rebuild) — GABRIEL relocates to a new random
  // spot, vanishes completely (no sprite/hitbox/mask/target at all) for
  // DARK_PHASE_HIDDEN_MS, then the direction-appropriate mask reappears at
  // that new spot at a slightly larger runtime scale, holds for a
  // DARK_PHASE_MASK_TELEGRAPH_MS telegraph, fires 2-3 CLAW attacks (existing
  // ARC CLAW SLASH/CLAW STING geometry, reused as-is) spaced by
  // DARK_PHASE_CLAW_INTERVAL_MS, then vanishes and repeats indefinitely.
  // Replaces the previous STALK/CLOSE IN/PAUSE/LUNGE/ARC CLAW/DISENGAGE
  // chase-and-strike loop entirely — see updateBossDarkPhase() below.
  const DARK_PHASE_HIDDEN_MS = 3000; // fully invisible/untargetable window, per spec
  const DARK_PHASE_MASK_TELEGRAPH_MS = 1000; // named per spec — mask visible, no attack yet
  const DARK_PHASE_CLAW_INTERVAL_MS = 550; // gap AFTER each claw's own lifetime finishes, before the next fires — keeps every attack individually visible/dodgeable
  const DARK_PHASE_MASK_SCALE_BOOST = 1.03; // runtime-only ×1.03 on top of the existing DARKPHASE_SCALE — never baked into the source image

  // ================= PART 2/3: SECURITY TRAINING / SECURITY ROBOT (DRONE) =================
  // TRAINING-MODE-ONLY stealth-verification stage. Referred to in the spec
  // as "DRONE"; kept as the existing `securityRobot*` identifiers in code
  // (no renaming churn across an already-large system). PART 3 reworked
  // this from a fixed turret into a destructible, slowly left-right
  // patrolling enemy with a separate scanning searchlight SHADOW (SECTION
  // E-L) — see spawnSecurityRobots()/updateSecurityRobots() further below
  // for the full design writeup. gameState.mode === 'securityTraining' is a
  // mode wholly separate from 'boss'/'training' — updateBoss() already
  // early-returns for any mode other than 'boss' (see below), so GABRIEL/
  // BOSS INTRO/BOSS HUD/DARK PHASE are structurally impossible here with no
  // extra guard needed (SECTION S).
  // PART 4 SECTION B: retired the old free/random per-session robot count —
  // placement was a fixed, regular 3-per-AREA layout (B-2). PART 5 SECTION
  // C then retired THIS fixed count in turn — each AREA now independently
  // rolls its own count from SECURITY_DRONE_COUNT_CHOICES (3/5/7) via
  // pickSecurityDroneCount(); these two constants are kept only as the
  // legacy "3-per-AREA" reference point (still exposed for debug/
  // verification) and are no longer read by any spawn path.
  const SECURITY_ROBOTS_PER_AREA = 3;
  const SECURITY_ROBOT_COUNT = SECURITY_ROBOTS_PER_AREA * 2; // legacy reference only — 3+3 was the PART 4 fixed count
  const SECURITY_ROBOT_MIN_SPACING = 130; // px between any two robots' patrol CENTERS
  // SECTION C (this turn): DRONE LASER attack tempo doubled — halves both
  // the TELEGRAPH windup and the post-fire impact-resolution delay, so the
  // full detected->telegraph->laser sequence takes about half as long
  // overall. Still fully dodgeable (C-5): 225ms is still a real, visible
  // windup, and resolveSecurityLaserHit()'s own re-check-at-resolve-time
  // logic (fireSecurityLaser()'s "target lock, then a real window to step
  // off the line" design) is completely untouched — only these two timing
  // constants changed, never the fixed-target-lock mechanic itself (C-6).
  const SECURITY_TELEGRAPH_MS = 225; // was 450ms (PART 2/SECTION M) — halved
  const SECURITY_LASER_VISUAL_MS = 110; // was 220ms — halved
  const SECURITY_LASER_COOLDOWN_MIN_MS = 1000, SECURITY_LASER_COOLDOWN_MAX_MS = 2000; // SECTION O: per-robot cooldown after firing
  const SECURITY_MAX_SIMULTANEOUS_ATTACKS = 2; // SECTION O: global cap across ALL robots combined — unchanged from PART 2
  // SECTION F: slow left-right patrol around a fixed per-robot center — a
  // per-robot random pick within these bands (F-4) keeps every robot's
  // motion visibly distinct rather than uniform.
  const SECURITY_PATROL_RANGE_MIN = 40, SECURITY_PATROL_RANGE_MAX = 90; // px either side of patrolCenterX
  // PART8 SECTION F: raised ~27% from the original 18-34 (F-3's old
  // "deliberately slow" design) — DRONEs were reported too easy to outrun/
  // outshoot. FAST_PATROL's existing 1.5x multiplier below (unchanged) already
  // puts a FAST DRONE ~50% ahead of a NORMAL one drawn from this SAME base
  // range, which is within the requested 30-50% differential, so only the
  // base range itself needed raising, not the relative TYPE multipliers.
  const SECURITY_PATROL_SPEED_MIN = 23, SECURITY_PATROL_SPEED_MAX = 43; // px/sec
  // SECTION H/I/J: the new searchlight SHADOW — a horizontal oval/capsule
  // (never the old thin directional rectangle, which SECTION G explicitly
  // retires) that itself patrols back and forth along ONE fixed axis
  // (chosen once per robot at spawn — SECTION I) independently of the
  // robot's own left-right patrol motion (I-3).
  // PART 4 SECTION H: shrunk to ~1/3 of the PART 3 dimensions (H-1/H-2 —
  // linear dimensions, not area) while keeping the exact same wide/short
  // aspect ratio (H-3). Both the previous PART 3 values and the new ones
  // are kept here, explicitly, so the ×1/3 derivation stays traceable.
  const SECURITY_SHADOW_RADIUS_X_PART3 = 70, SECURITY_SHADOW_RADIUS_Y_PART3 = 30;
  const SECURITY_SHADOW_SHRINK_FACTOR = 1 / 3;
  const SECURITY_SHADOW_RADIUS_X = SECURITY_SHADOW_RADIUS_X_PART3 * SECURITY_SHADOW_SHRINK_FACTOR; // ~23.33
  const SECURITY_SHADOW_RADIUS_Y = SECURITY_SHADOW_RADIUS_Y_PART3 * SECURITY_SHADOW_SHRINK_FACTOR; // 10
  const SECURITY_SCAN_RANGE_MIN = 50, SECURITY_SCAN_RANGE_MAX = 100; // px either side of the scan center (J-4) — unchanged, this is the travel range, not the shadow's own size
  // PART 4 SECTION I: scan speed doubled from PART 3's 20-40px/sec.
  const SECURITY_SCAN_SPEED_MIN_PART3 = 20, SECURITY_SCAN_SPEED_MAX_PART3 = 40;
  const SECURITY_SCAN_SPEED_MIN = SECURITY_SCAN_SPEED_MIN_PART3 * 2; // 40
  const SECURITY_SCAN_SPEED_MAX = SECURITY_SCAN_SPEED_MAX_PART3 * 2; // 80
  // SECTION E: DRONE HP — "3〜5発程度" of the existing normal-attack
  // constant, never an invented arbitrary value.
  const SECURITY_DRONE_HP = BULLET_DAMAGE * 4;
  // PART 4 SECTION D: draw size trimmed 3% (D's own explicit request) —
  // the hit radius is scaled down by the exact same factor right below so
  // it never drifts further from the (now smaller) visible sprite than it
  // already was (D-3).
  const SECURITY_ROBOT_DRAW_SCALE = 0.97;
  const SECURITY_DRONE_HIT_RADIUS = 20 * SECURITY_ROBOT_DRAW_SCALE; // bullet-vs-drone collision radius — generous relative to the drone's small on-screen diameter, same spirit as BOSS_HURT_RADIUS being sized independently of the full sprite
  const SECURITY_DRONE_DEATH_MS = 350; // no longer used for a bespoke drone burst duration — PART 4 SECTION F reuses the barrel explosion's own EXPLOSION_DURATION_MS/drawExplosion() instead; kept only as a harmless legacy constant in case anything else still reads it
  // PART 4 SECTION E: independent per-DRONE damage-blink — same on/off-
  // segment timing PATTERN GABRIEL's own BOSS_DAMAGE_BLINK_* already uses
  // (3 blinks totalling ~300ms), reusing the exact same generic
  // drawBossWithHitTint() compositing helper (it takes a plain img/dx/dy/
  // w/h/tintT, nothing boss-specific) rather than a separately-invented
  // effect (E-1).
  const SECURITY_DRONE_HIT_TINT_MS = 50;
  const SECURITY_DRONE_HIT_BLINK_COUNT = 3;
  const SECURITY_DRONE_HIT_BLINK_TOTAL_MS = SECURITY_DRONE_HIT_TINT_MS * SECURITY_DRONE_HIT_BLINK_COUNT * 2; // 300ms, E-3
  // SECTION C: on-screen SECURITY ROBOT diameter is derived from GABRIEL's
  // OWN existing DARK PHASE mask size (not an arbitrary new value) — the
  // DARK PHASE "mask" IS the small head sprite drawn by drawBossDarkPhase()
  // (there is no separate larger body during DARK PHASE), displayed at
  // DARKPHASE_HEAD_DISPLAY_H boosted by DARK_PHASE_MASK_SCALE_BOOST. Using
  // that same final figure here means SECURITY ROBOT reads as "roughly the
  // same" occupied on-screen area as that mask, per spec. PART 4 SECTION D:
  // that whole figure is then trimmed by SECURITY_ROBOT_DRAW_SCALE (0.97),
  // applied identically to all 3 directions below (D-1) — the raw source
  // images themselves are never touched (D-2).
  const SECURITY_ROBOT_DRAW_D = DARKPHASE_HEAD_DISPLAY_H * DARK_PHASE_MASK_SCALE_BOOST * SECURITY_ROBOT_DRAW_SCALE;
  // Per-direction source metrics measured directly from the 3 attached
  // images (native pixel size + the fraction of the image's own opaque
  // pixel bounding box that is horizontally centered / vertically at the
  // very bottom) — used to compute a per-direction "visual center-bottom"
  // muzzle point (SECTION K) without hand-tuning per direction, and to
  // scale each direction to the SAME on-screen diameter (SECTION C-4: no
  // visible size jump between SOUTH/WEST/EAST).
  const SECURITY_ROBOT_METRICS = {
    south: { nativeW: 1279, nativeH: 1280, muzzleFracX: 0.4996, muzzleFracY: 0.9992 },
    west: { nativeW: 1278, nativeH: 1297, muzzleFracX: 0.4996, muzzleFracY: 0.9977 },
    east: { nativeW: 1261, nativeH: 1280, muzzleFracX: 0.4996, muzzleFracY: 0.9992 },
  };
  Object.keys(SECURITY_ROBOT_METRICS).forEach((key) => {
    const m = SECURITY_ROBOT_METRICS[key];
    m.scale = SECURITY_ROBOT_DRAW_D / Math.max(m.nativeW, m.nativeH);
    m.drawW = m.nativeW * m.scale;
    m.drawH = m.nativeH * m.scale;
  });

  // ==========================================================================
  // DARK OUT PART 2: CHARACTER / ITEM sprite registries + visual metadata.
  // ==========================================================================
  // Registers the 66 new PNGs (ROID1/ROID2/ADAM/ADAM SPHERE/ITEMs) as loadable
  // sprite entries, exactly reusing the existing lazy-image-load shape
  // (file/img/ready — same as TRAINING_BACKGROUNDS/STAGES/SECURITY_ROBOT_METRICS
  // above) via ONE small shared constructor rather than 66 copy-pasted
  // forEach blocks. NOT wired into any AI/render/collision/event code this
  // PART — see the PART 2 spec's own section 27 for the long "not yet" list.
  //
  // WHY body-scale metadata, not a resized PNG (audit + spec sections 5/7/29):
  // every one of these PNGs already carries proper alpha transparency (no
  // white background to remove — confirmed during the pre-implementation
  // audit), but their canvas dimensions vary enormously frame-to-frame for
  // reasons that have nothing to do with the character's actual on-screen
  // size — ROID1/ROID2 FIRE frames include a muzzle-flash effect layered
  // over (ROID1) or extending sideways from (ROID2) the body without the
  // character itself changing size; ADAM's wings/tail extend the canvas by
  // wildly different amounts pose-to-pose while ADAM's own body (head/torso/
  // legs) stays the same actual size. A naive "resize every PNG's canvas to
  // the same WxH" would therefore make the character visibly balloon or
  // shrink exactly when its effect/wing footprint changes — precisely the
  // "見た目が拡大縮小する" bug the spec calls out. Directly mirrors the
  // established DARKPHASE_HEAD_IMGS/SECURITY_ROBOT_METRICS pattern already
  // in this file above (nativeW/nativeH + a manually-measured reference
  // fraction, scale computed at load time — never canvas-width/height alone).
  //
  // bodyTopFrac/bodyBottomFrac: the vertical span (as a fraction 0-1 of the
  // frame's OWN nativeH) occupied by the character's actual body silhouette
  // (head-to-feet), deliberately EXCLUDING muzzle flash / wing-tip / tail
  // extent wherever those are visually distinguishable from the body itself
  // (spec section 29's explicit warning: "alpha bounds全体をそのままbody
  // boundsとしないこと" — confirmed necessary in practice: an automated
  // alpha-bbox pass on these exact files returned the full canvas for nearly
  // every frame, because isolated anti-aliasing pixels touch the image edge
  // — see the PART 2 completion report for that measurement). These were
  // established by directly viewing a representative frame from each pose
  // family (ROID1 SEARCH/FIRE, ROID2 SEARCH/FIRE, ADAM IDLE/WALK/DEFENSE/
  // ATTACK per direction) and are a considered FIRST-PASS visual estimate,
  // not a pixel-ruler measurement — deliberately called out here and in the
  // completion report as needing a dedicated visual-fit pass once these
  // sprites are actually wired into rendering (a later PART; out of scope
  // here per spec section 27's "ADAM movement/state machine" exclusion).
  // Frames within the same short pose-family (e.g. one WALK cycle's 3
  // frames, or ROID2's 5 SEARCH frames, which share an identical nativeH
  // across all 5) reuse the same fraction pair rather than inventing false
  // per-frame precision.
  function makeSpriteFrame(file, nativeW, nativeH, bodyTopFrac, bodyBottomFrac, extra) {
    const img = new Image();
    const frame = Object.assign({ file, img, ready: false, nativeW, nativeH, bodyTopFrac, bodyBottomFrac }, extra || {});
    img.onload = () => { frame.ready = true; };
    img.src = file;
    return frame;
  }
  // The one shared scale calculator every group below uses: body-silhouette
  // height (not canvas height) mapped to a target on-screen height. Anchor
  // (feet) is bodyBottomFrac * nativeH * scale from the frame's own top —
  // callers draw anchored to that point so SEARCH<->FIRE / IDLE<->WALK<->
  // DEFENSE<->ATTACK switches never jump vertically even though nativeH
  // differs frame to frame.
  function computeBodyVisualScale(frame, targetBodyHeightPx) {
    const bodyHeightPx = (frame.bodyBottomFrac - frame.bodyTopFrac) * frame.nativeH;
    return bodyHeightPx > 0 ? targetBodyHeightPx / bodyHeightPx : 1;
  }

  // ---------- ROID1 / ROID2 ----------
  // SECTION 8/9: target on-screen body height = BOSS_DRAW_H, the SAME
  // constant GABRIEL's own canvas is scaled to (BOSS_DRAW_H/BOSS_CANVAS_H —
  // GABRIEL's asset pipeline already keeps its body filling that aligned
  // canvas almost edge-to-edge, so BOSS_DRAW_H IS effectively GABRIEL's own
  // visible body height already) — "同程度をTARGETとする...BODY silhouette基準"
  // is satisfied by reusing this one existing constant rather than inventing
  // a new ROID-specific size.
  const ROID_BODY_TARGET_HEIGHT = BOSS_DRAW_H;
  // ROID_BURST_SHOT_INTERVAL_MS/ROID_BURST_COOLDOWN_MS are intentionally NOT
  // defined here — SECTION 5 of the confirmed design fixes them at 300ms/
  // 3000ms, but they belong to the ROID AI PART (not yet implemented), never
  // the asset-registration PART.
  const ROID1_SPRITES = {
    // SEARCH: 1->2->3->4->5->4->3->2->1 (ping-pong sequencing is a later
    // PART's job — this array IS the animation's frame-order data).
    search: [
      makeSpriteFrame('assets/characters/roid1/roid1_search_01.png', 983, 1280, 0.02, 0.99),
      makeSpriteFrame('assets/characters/roid1/roid1_search_02.png', 942, 1280, 0.02, 0.99),
      makeSpriteFrame('assets/characters/roid1/roid1_search_03.png', 1279, 1776, 0.05, 0.83),
      makeSpriteFrame('assets/characters/roid1/roid1_search_04.png', 753, 1280, 0.02, 0.99),
      makeSpriteFrame('assets/characters/roid1/roid1_search_05.png', 1280, 2427, 0.01, 0.88),
    ],
    // FIRE: 1->2->3->4->3->2->1. All 4 share one fixed 813x1280 canvas — the
    // muzzle flash is layered over the existing body silhouette rather than
    // extending the canvas, so it never needs excluding from bodyTop/
    // BottomFrac (unlike ROID2 below).
    fire: [
      makeSpriteFrame('assets/characters/roid1/roid1_fire_01.png', 813, 1280, 0.02, 0.99),
      makeSpriteFrame('assets/characters/roid1/roid1_fire_02.png', 813, 1280, 0.02, 0.99),
      makeSpriteFrame('assets/characters/roid1/roid1_fire_03.png', 813, 1280, 0.02, 0.99),
      makeSpriteFrame('assets/characters/roid1/roid1_fire_04.png', 813, 1280, 0.02, 0.99),
    ],
  };
  const ROID2_SPRITES = {
    // All 5 SEARCH frames share the exact same nativeH (1280) — only width
    // (arm/cannon spread) differs between them — so one fraction pair is
    // exactly right for all 5, not an approximation.
    search: [
      makeSpriteFrame('assets/characters/roid2/roid2_search_01.png', 1049, 1280, 0.05, 0.95),
      makeSpriteFrame('assets/characters/roid2/roid2_search_02.png', 1174, 1280, 0.05, 0.95),
      makeSpriteFrame('assets/characters/roid2/roid2_search_03.png', 1273, 1280, 0.05, 0.95),
      makeSpriteFrame('assets/characters/roid2/roid2_search_04.png', 1096, 1280, 0.05, 0.95),
      makeSpriteFrame('assets/characters/roid2/roid2_search_05.png', 1065, 1280, 0.05, 0.95),
    ],
    // FIRE: ROID2's flash is HORIZONTAL (spec section 9) and its own canvas
    // is genuinely shorter/differently-cropped per frame (1008/1568/1008/
    // 1008 vs SEARCH's constant 1280) — bodyBottomFrac is set narrower here
    // specifically to exclude the sideways flash spread from the body box.
    fire: [
      makeSpriteFrame('assets/characters/roid2/roid2_fire_01.png', 1792, 1008, 0.05, 0.90),
      makeSpriteFrame('assets/characters/roid2/roid2_fire_02.png', 1264, 1568, 0.10, 0.85),
      makeSpriteFrame('assets/characters/roid2/roid2_fire_03.png', 1792, 1008, 0.05, 0.90),
      makeSpriteFrame('assets/characters/roid2/roid2_fire_04.png', 1792, 1008, 0.05, 0.90),
    ],
  };

  // ---------- ADAM ----------
  // SECTION 10/11: IDLE is the body-scale reference; WALK/DEFENSE/ATTACK for
  // a given direction are scaled to match THAT direction's own IDLE body
  // height (never a cross-direction or canvas-based target) — exactly the
  // "adam_walk_south -> adam_idle_south" mapping the spec fixes per section 10.
  // getAdamReferenceBodyHeightPx() below is the single place that reads this.
  // Direction values (south/north/east/west) are the spec's own absolute
  // filename-to-direction mapping (section 11) — never re-derived from image
  // content.
  const ADAM_SPRITES = {
    idle: {
      south: makeSpriteFrame('assets/characters/adam/adam_idle_south.png', 1658, 1970, 0.36, 1.00, { direction: 'south' }),
      north: makeSpriteFrame('assets/characters/adam/adam_idle_north.png', 1815, 1475, 0.36, 1.00, { direction: 'north' }),
      east: makeSpriteFrame('assets/characters/adam/adam_idle_east.png', 1299, 1890, 0.30, 0.90, { direction: 'east' }),
      west: makeSpriteFrame('assets/characters/adam/adam_idle_west.png', 1311, 1891, 0.30, 0.90, { direction: 'west' }),
    },
    // WALK: 1->2->3->1->2->3... per direction (section 12).
    walk: {
      south: [
        makeSpriteFrame('assets/characters/adam/adam_walk_south_01.png', 1613, 1829, 0.36, 1.00, { direction: 'south' }),
        makeSpriteFrame('assets/characters/adam/adam_walk_south_02.png', 1609, 1906, 0.36, 1.00, { direction: 'south' }),
        makeSpriteFrame('assets/characters/adam/adam_walk_south_03.png', 1449, 1740, 0.36, 1.00, { direction: 'south' }),
      ],
      north: [
        makeSpriteFrame('assets/characters/adam/adam_walk_north_01.png', 1880, 1595, 0.36, 1.00, { direction: 'north' }),
        makeSpriteFrame('assets/characters/adam/adam_walk_north_02.png', 1815, 1475, 0.36, 1.00, { direction: 'north' }),
        makeSpriteFrame('assets/characters/adam/adam_walk_north_03.png', 1880, 1604, 0.36, 1.00, { direction: 'north' }),
      ],
      west: [
        makeSpriteFrame('assets/characters/adam/adam_walk_west_01.png', 1397, 1641, 0.30, 0.90, { direction: 'west' }),
        makeSpriteFrame('assets/characters/adam/adam_walk_west_02.png', 1362, 2007, 0.30, 0.90, { direction: 'west' }),
        makeSpriteFrame('assets/characters/adam/adam_walk_west_03.png', 1269, 1517, 0.30, 0.90, { direction: 'west' }),
      ],
      east: [
        makeSpriteFrame('assets/characters/adam/adam_walk_east_01.png', 1397, 1641, 0.30, 0.90, { direction: 'east' }),
        makeSpriteFrame('assets/characters/adam/adam_walk_east_02.png', 1362, 2007, 0.30, 0.90, { direction: 'east' }),
        makeSpriteFrame('assets/characters/adam/adam_walk_east_03.png', 1280, 1530, 0.30, 0.90, { direction: 'east' }),
      ],
    },
    defense: {
      south: makeSpriteFrame('assets/characters/adam/adam_defense_south.png', 1280, 1497, 0.08, 0.98, { direction: 'south' }),
      west: makeSpriteFrame('assets/characters/adam/adam_defense_west.png', 1579, 1475, 0.08, 0.93, { direction: 'west' }),
      east: makeSpriteFrame('assets/characters/adam/adam_defense_east.png', 1577, 1466, 0.08, 0.93, { direction: 'east' }),
      north: makeSpriteFrame('assets/characters/adam/adam_defense_north.png', 1228, 1298, 0.08, 0.98, { direction: 'north' }),
    },
    // ATTACK STANCE: registered for later blink-based attack-telegraph use
    // (ADAM_ATTACK_BLINK_MS, section 13) — no blink/state logic yet.
    attack: {
      south: makeSpriteFrame('assets/characters/adam/adam_attack_south.png', 1763, 1982, 0.30, 0.85, { direction: 'south' }),
      north: makeSpriteFrame('assets/characters/adam/adam_attack_north.png', 1886, 1290, 0.30, 0.85, { direction: 'north' }),
      west: makeSpriteFrame('assets/characters/adam/adam_attack_west.png', 1412, 1899, 0.30, 0.85, { direction: 'west' }),
      east: makeSpriteFrame('assets/characters/adam/adam_attack_east.png', 1453, 1885, 0.30, 0.85, { direction: 'east' }),
    },
    // SECTION 14/15: registered for the LATER PART's reuse of GABRIEL's own
    // spawnArcClawSlash()/ARC_CLAW_LIFETIME_MS and spawnStraightClaw()/
    // STRAIGHT_CLAW_ATTACK_MS — same visible size/attack speed as GABRIEL's,
    // no new attack logic here. STRAIGHT CLAW's target-side tip (the spec's
    // "画像の下方向へ伸びている爪先側") reuses GABRIEL's existing mirrored/
    // angle rotation math unchanged (PART8) — never re-implemented.
    arcClaw: makeSpriteFrame('assets/characters/adam/adam_arc_claw.png', 1280, 1223, 0, 1),
    straightClaw: makeSpriteFrame('assets/characters/adam/adam_straight_claw.png', 496, 1303, 0, 1),
  };
  // The one lookup for "what body height should THIS direction's WALK/
  // DEFENSE/ATTACK frame be scaled to" — always that direction's own IDLE.
  function getAdamReferenceBodyHeightPx(direction) {
    const idle = ADAM_SPRITES.idle[direction];
    return (idle.bodyBottomFrac - idle.bodyTopFrac) * idle.nativeH;
  }

  // ---------- ADAM SPHERE ----------
  // SECTION 17: target diameter = DRONE's own existing visible diameter x2
  // — SECURITY_ROBOT_DRAW_D IS that diameter (the constant every DRONE frame
  // above is already scaled to), so this is a pure relative multiple of an
  // existing value, never the sphere's own 1408x1408 source canvas.
  const ADAM_SPHERE_TARGET_DIAMETER = SECURITY_ROBOT_DRAW_D * 2;
  const ADAM_SPHERE_SPRITES = [
    // 1->2->3->4->1... loop (section 17). All 4 share the same 1408x1408
    // canvas and fill it nearly edge-to-edge (confirmed during the
    // pre-implementation audit's border-transparency sampling).
    makeSpriteFrame('assets/characters/adam_sphere/adam_sphere_01.png', 1408, 1408, 0.02, 0.98),
    makeSpriteFrame('assets/characters/adam_sphere/adam_sphere_02.png', 1408, 1408, 0.02, 0.98),
    makeSpriteFrame('assets/characters/adam_sphere/adam_sphere_03.png', 1408, 1408, 0.02, 0.98),
    makeSpriteFrame('assets/characters/adam_sphere/adam_sphere_04.png', 1408, 1408, 0.02, 0.98),
  ];

  // ---------- ITEMS ----------
  // SECTION 23: every item's reference is ADAM's own SOUTH IDLE body height
  // (the spec's own chosen common reference), with a per-item scaleMultiplier
  // layered on top — "全ITEMをADAMと同じ巨大サイズで表示" is explicitly NOT
  // the intent (section 23), so each group's multiplier is its own small
  // fraction, independently tunable later without touching the PNGs.
  function getItemReferenceBodyHeightPx() {
    return getAdamReferenceBodyHeightPx('south');
  }
  const ITEM_SPRITES = {
    // SECTION 18: SECRET FILE: PROJECT ADAM (never the old "PROJECT GABRIEL"
    // name) — 1->2->3->4->1... loop, picked up at EVENT STAGE b1.
    projectAdam: {
      scaleMultiplier: 0.35,
      frames: [
        makeSpriteFrame('assets/items/project_adam/project_adam_01.png', 1280, 1218, 0.20, 0.80),
        makeSpriteFrame('assets/items/project_adam/project_adam_02.png', 1138, 1280, 0.20, 0.80),
        makeSpriteFrame('assets/items/project_adam/project_adam_03.png', 596, 1280, 0.20, 0.80),
        makeSpriteFrame('assets/items/project_adam/project_adam_04.png', 951, 1280, 0.20, 0.80),
      ],
    },
    // SECTION 19/20: BLOOD SAMPLE (1)/(2)/(3) — secret-scenario-only, each
    // 1->2->3->1... looping, picked up after GABRIEL 1/2/3 respectively.
    bloodSample1: {
      scaleMultiplier: 0.30,
      frames: [
        makeSpriteFrame('assets/items/blood_sample_1/blood_sample_1_01.png', 662, 1280, 0.08, 0.95),
        makeSpriteFrame('assets/items/blood_sample_1/blood_sample_1_02.png', 726, 1280, 0.08, 0.95),
        makeSpriteFrame('assets/items/blood_sample_1/blood_sample_1_03.png', 672, 1280, 0.08, 0.95),
      ],
    },
    bloodSample2: {
      scaleMultiplier: 0.30,
      frames: [
        makeSpriteFrame('assets/items/blood_sample_2/blood_sample_2_01.png', 738, 1280, 0.08, 0.95),
        makeSpriteFrame('assets/items/blood_sample_2/blood_sample_2_02.png', 625, 1280, 0.08, 0.95),
        makeSpriteFrame('assets/items/blood_sample_2/blood_sample_2_03.png', 820, 1280, 0.08, 0.95),
      ],
    },
    bloodSample3: {
      scaleMultiplier: 0.30,
      frames: [
        makeSpriteFrame('assets/items/blood_sample_3/blood_sample_3_01.png', 682, 1280, 0.08, 0.95),
        makeSpriteFrame('assets/items/blood_sample_3/blood_sample_3_02.png', 735, 1280, 0.08, 0.95),
        makeSpriteFrame('assets/items/blood_sample_3/blood_sample_3_03.png', 578, 1280, 0.08, 0.95),
      ],
    },
    // SECTION 22: ESCAPE NAVIGATOR — 1->2->3->4->5->1... looping key item,
    // shared visual asset for both the MAIN and SECRET escape routes.
    escapeNavigator: {
      scaleMultiplier: 0.40,
      frames: [
        makeSpriteFrame('assets/items/escape_navigator/escape_navigator_01.png', 869, 1280, 0.05, 0.95),
        makeSpriteFrame('assets/items/escape_navigator/escape_navigator_02.png', 729, 1280, 0.05, 0.95),
        makeSpriteFrame('assets/items/escape_navigator/escape_navigator_03.png', 642, 1280, 0.05, 0.95),
        makeSpriteFrame('assets/items/escape_navigator/escape_navigator_04.png', 614, 1280, 0.05, 0.95),
        makeSpriteFrame('assets/items/escape_navigator/escape_navigator_05.png', 674, 1280, 0.05, 0.95),
      ],
    },
  };

  // Debug/verification only (section 26) — every one of the 66 new frames,
  // flattened, for load/count/metadata checks. Never read by gameplay code.
  function getAllNewCharacterItemFrames() {
    const out = [];
    ROID1_SPRITES.search.forEach((f) => out.push(f));
    ROID1_SPRITES.fire.forEach((f) => out.push(f));
    ROID2_SPRITES.search.forEach((f) => out.push(f));
    ROID2_SPRITES.fire.forEach((f) => out.push(f));
    Object.values(ADAM_SPRITES.idle).forEach((f) => out.push(f));
    Object.values(ADAM_SPRITES.walk).forEach((arr) => arr.forEach((f) => out.push(f)));
    Object.values(ADAM_SPRITES.defense).forEach((f) => out.push(f));
    Object.values(ADAM_SPRITES.attack).forEach((f) => out.push(f));
    out.push(ADAM_SPRITES.arcClaw, ADAM_SPRITES.straightClaw);
    ADAM_SPHERE_SPRITES.forEach((f) => out.push(f));
    Object.values(ITEM_SPRITES).forEach((group) => group.frames.forEach((f) => out.push(f)));
    return out;
  }
  // ==========================================================================
  // END DARK OUT PART 2 registries.
  // ==========================================================================

  // SECTION C/D: official, untouched, non-AI-regenerated assets — exact
  // mapping per the request (1st image=SOUTH, 2nd=WEST, 3rd=EAST), visually
  // confirmed to already carry proper alpha transparency (no white
  // background), so no cleanup/editing was applied to any of the 3 files.
  const securityRobotImgs = { south: new Image(), west: new Image(), east: new Image() };
  securityRobotImgs.south.src = 'assets/security/security_robot_south.png';
  securityRobotImgs.west.src = 'assets/security/security_robot_west.png';
  securityRobotImgs.east.src = 'assets/security/security_robot_east.png';
  let securityRobots = [];
  let securityAttackSlotsInUse = 0;

  // ================= PART 5 SECTION A: DRONE behavior profiles =================
  // Every DRONE is assigned exactly one of these 4 named profiles at spawn
  // (never re-rolled mid-life) — NORMAL/FAST_PATROL/FAST_SEARCH multiply the
  // existing random base patrol/scan speed (SECURITY_PATROL_SPEED_*/
  // SECURITY_SCAN_SPEED_*) picked per-robot exactly as before; CENTER_SCANNER
  // instead gets its own dedicated center-stop state machine (SECTION B)
  // layered on top of the same base speeds, so its own multiplier entry here
  // stays neutral (1.0/1.0) by design.
  const SECURITY_BEHAVIOR_TYPES = ['NORMAL', 'FAST_PATROL', 'FAST_SEARCH', 'CENTER_SCANNER'];
  const SECURITY_BEHAVIOR_MULTIPLIERS = {
    NORMAL: { patrol: 1.0, scan: 1.0 },
    FAST_PATROL: { patrol: 1.5, scan: 1.0 },
    FAST_SEARCH: { patrol: 1.0, scan: 1.5 },
    CENTER_SCANNER: { patrol: 1.0, scan: 1.0 },
  };
  // ================= PART 5 SECTION B: CENTER SCANNER state machine =================
  // patrol -> returningToCenter -> centerScan -> patrol. CENTER_SCAN_SLOW_
  // FACTOR (B-4) is applied ON TOP OF whatever scanSpeed this robot was
  // already given (base random × TYPE multiplier × the current STORY STAGE's
  // own speed multiplier, SECTION J-4/L-3) — so a CENTER SCANNER always
  // reads as slower than its OWN normal SEARCH speed, at any stage.
  const CENTER_SCAN_SLOW_FACTOR = 0.5;
  const CENTER_SCAN_DURATION_MIN_MS = 1500, CENTER_SCAN_DURATION_MAX_MS = 3000; // B-6
  const CENTER_SCAN_RETURN_SPEED = 50; // px/s while walking back to patrolCenterX
  const CENTER_SCAN_COOLDOWN_MIN_MS = 3000, CENTER_SCAN_COOLDOWN_MAX_MS = 6500; // time spent patrolling between center-stop trips — randomized per robot so trips never globally sync (B-6)
  // ================= PART 5 SECTION C: randomized DRONE count per AREA =================
  const SECURITY_DRONE_COUNT_CHOICES = [3, 5, 7];
  // ================= PART 5 SECTION N: FINAL STAGE's own DRONE spec =================
  // N-1: fixed at exactly 3, never drawn from the 3/5/7 pool above. N-6:
  // its own distinct, explicitly-named multiplier — defaults to 1.0 and
  // deliberately does NOT inherit STAGE 8/9's 1.5x (STORY_STAGE_PLAN's own
  // `speedMult` field further below is never read for the FINAL entry).
  // PART8 SECTION H: clarified this turn — FINAL_STAGE_DRONE_COUNT was being
  // read as "3 total for the whole FINAL STAGE" (the confirmed root cause of
  // the Area1=2/Area2=1 split bug), but the real spec is 3 PER AREA (6
  // total at wave1). FINAL_STAGE_DRONE_COUNT is kept only for any external
  // reference to "3"; every spawn/wave loop below uses the new, correctly-
  // named FINAL_DRONES_PER_AREA.
  const FINAL_STAGE_DRONE_COUNT = 3;
  const FINAL_DRONES_PER_AREA = 3;
  const FINAL_STAGE_DRONE_SPEED_MULTIPLIER = 1.0;
  // PART7 SECTION H: wave 2's one-time "falls from above and lands" entrance
  // duration — reuses the exact ease-in-fall + growing/darkening shadow
  // technique from drawBossIntro()'s SILENCE_END..SHADOW_END phase, scaled
  // down to a single lightweight per-DRONE timer (no new art, no copy of
  // GABRIEL's own multi-phase cinematic state machine).
  const FINAL_DRONE_DROP_MS = 650;
  // ================= END PART 2/5 constants (state machine/logic further below) =================

  // Minimum straight-line distance a new relocate position must keep from
  // the PREVIOUS one, so the loop never reads as a near-repeat/fixed spot.
  // Sized to comfortably fit the valid on-stage relocate box on the
  // smallest supported portrait canvas (see pickDarkPhaseRelocatePosition's
  // own margins) — a `from` point at the box's center can still always
  // reach a corner at least this far away.
  const DARK_PHASE_MIN_RELOCATE_DISTANCE = 180;
  const DARKPHASE_ATTACK_RANGE = BOSS_ATTACK_RANGE; // kept: still the distance the reused CLAW attacks are authored around
  const WALK_FRAME_PERIOD_MS = 260; // NORTH (3-frame wrap) / EAST / WEST (2-frame alternation) walk-cycle period
  // SOUTH is back to a 3-frame cycle (new walk_south_1/2/3 art, this
  // batch) — the earlier 2-frame version's much slower period (2.3x) was
  // specifically compensating for a fast on/off binary flicker with no 3rd
  // frame to smooth the transition; with all 3 frames restored, a period
  // close to the shared baseline reads naturally again. Kept a hair slower
  // than NORTH/EAST/WEST (1.15x) rather than identical, per instruction.
  const SOUTH_WALK_FRAME_PERIOD_MS = WALK_FRAME_PERIOD_MS * 1.15;
  // Was a small decorative sine bounce added back when NORTH had no real
  // walk art of its own (a stand-in for motion). Real NORTH walk art
  // (walk_north_1/2/3) now supplies its own genuine per-frame motion, and
  // real-device testing showed this extra synthetic vertical bob — synced
  // to the frame flip — compounds with the art's own pose changes into a
  // "wriggling" look rather than a clean walk. Zeroed rather than removed
  // outright so the mechanism stays available if ever needed again.
  const NORTH_BOUNCE_AMPLITUDE = 0;
  const SOUTH_WALK_SCALE = 1.10; // visual-only — SOUTH WALK reads a touch small next to the other directions
  const PRE_ATTACK_SCALE = 1.10; // visual-only — matches SOUTH_ATTACK_SCALE so the telegraph reads the same size as the real release
  const NORTH_IDLE_SCALE = 1.10; // visual-only — NORTH IDLE reads a touch small next to the other directions
  const NORTH_ATTACK_SCALE = 1.10; // visual-only — matched to NORTH IDLE so the two read as the same size
  // SOUTH ATTACK's own render-time scale — deliberately independent from
  // CINEMATIC_SCALE (a completely different image/role; never share this
  // constant with the cinematic pose). The source render's own body-height
  // (measured head-top to feet-bottom, not raw canvas bbox — its wingspan/
  // raised arm are wide enough that fitting it on the shared 700x920 canvas
  // without any clipping already lands close to the other directions' own
  // effective size) only needs a small boost here, tuned via Playwright
  // screenshot comparison against SOUTH IDLE/WALK/CINEMATIC so SOUTH ATTACK
  // reads as the SAME size as SOUTH IDLE/WALK — not larger — per the
  // "fit the smaller side, don't enlarge everything else" instruction.
  const SOUTH_ATTACK_SCALE = 1.10;
  // SOUTH/EAST/WEST attacks telegraph with a PRE_ATTACK pose before the
  // real ATTACK (blade release) frame; NORTH skips straight to ATTACK
  // (no dedicated PRE_ATTACK art for it) — see updateBoss()'s CHASE
  // branch. Matches the old BOSS_ATTACK_WINDUP_MS so the total telegraph
  // time (and therefore attack difficulty/reaction window) is unchanged.
  const PRE_ATTACK_MS = 400;

  // ---------- Boss cinematic sequences (intro / HP threshold / death) ----------
  // Intro (PART 1-8): player locked in place, facing north -> violent stage
  // shake -> shake stops -> silence -> GABRIEL's shadow slowly rises ->
  // GABRIEL lands INSTANTLY (no smooth descent) -> hard landing shake ->
  // shake stops -> a brief pause -> south idle -> south attack (telegraph
  // only, no real hitbox) -> battle begins. Every phase length is its own
  // named constant so the pacing can be retuned without touching the
  // update/draw logic itself.
  const BOSS_INTRO_INITIAL_SHAKE_MS = 1200;
  const BOSS_INTRO_SILENCE_MS = 2000;
  const BOSS_INTRO_SHADOW_REVEAL_MS = 1800;
  const BOSS_INTRO_LANDING_SHAKE_MS = 450; // SECTION S: within the requested 350-500ms band
  const BOSS_INTRO_POST_LANDING_PAUSE_MS = 1800;
  const BOSS_INTRO_SOUTH_IDLE_MS = 1000;
  const BOSS_INTRO_SOUTH_ATTACK_MS = 800;
  // Cumulative phase-end timestamps (ms since boss.cinematicElapsed=0) —
  // updateBossIntro()/drawBossIntro() both branch on these, so they can
  // never disagree about which phase is currently active.
  const BOSS_INTRO_SHAKE_END = BOSS_INTRO_INITIAL_SHAKE_MS;
  const BOSS_INTRO_SILENCE_END = BOSS_INTRO_SHAKE_END + BOSS_INTRO_SILENCE_MS;
  const BOSS_INTRO_SHADOW_END = BOSS_INTRO_SILENCE_END + BOSS_INTRO_SHADOW_REVEAL_MS; // instant landing happens exactly here
  const BOSS_INTRO_LANDING_SHAKE_END = BOSS_INTRO_SHADOW_END + BOSS_INTRO_LANDING_SHAKE_MS;
  const BOSS_INTRO_POST_PAUSE_END = BOSS_INTRO_LANDING_SHAKE_END + BOSS_INTRO_POST_LANDING_PAUSE_MS;
  const BOSS_INTRO_SOUTH_IDLE_END = BOSS_INTRO_POST_PAUSE_END + BOSS_INTRO_SOUTH_IDLE_MS;
  const INTRO_TOTAL_MS = BOSS_INTRO_SOUTH_IDLE_END + BOSS_INTRO_SOUTH_ATTACK_MS; // == south attack phase end; battle starts here
  // PART 4/6: both shakes stay scoped to PLAY AREA/canvas content only (see
  // getScreenShakeOffset()'s one call site inside draw(), which only ever
  // translates the canvas context — CONTROL AREA is a separate DOM region
  // it can never reach). The initial shake is clearly stronger than a
  // normal hit-shake (compare BOSS_HIT_TINT-adjacent shakes elsewhere, all
  // magnitude 2.5-8); the landing shake matches it for an equally hard hit.
  const BOSS_INTRO_SHAKE_MAG = 16;
  const BOSS_INTRO_LANDING_SHAKE_MAG = 18; // SECTION S: clearly stronger than a normal hit-shake for the hardest impact of the sequence
  // SECTION R: a short, distinct screen flicker the instant the real BOSS
  // INTRO trigger fires (AREA1 only, once — spawnBoss() itself, thanks to
  // SECTION A's fix, is now the single true encounter trigger) — separate
  // state/timer from every other flash in this file (COUNTER's own
  // flicker, BOSS defeat's flash, and this section's own landing flash)
  // so none of them can stomp on each other.
  const BOSS_INTRO_START_FLASH_PULSES = 3;
  const BOSS_INTRO_START_FLASH_ON_MS = 80;
  const BOSS_INTRO_START_FLASH_OFF_MS = 80;
  const BOSS_INTRO_START_FLASH_CYCLE_MS = BOSS_INTRO_START_FLASH_ON_MS + BOSS_INTRO_START_FLASH_OFF_MS;
  const BOSS_INTRO_START_FLASH_TOTAL_MS = BOSS_INTRO_START_FLASH_PULSES * BOSS_INTRO_START_FLASH_CYCLE_MS; // 480ms, within the requested 300-500ms band
  const BOSS_INTRO_START_FLASH_ALPHA_MAX = 0.5; // white/pale-gray, never fully opaque
  let introStartFlashRemainingMs = 0;
  // SECTION S: a short red flicker exactly when the DOWN sprite reaches the
  // ground (BOSS_INTRO_SHADOW_END — the same instant the existing landing
  // shake above already fires from), on its own separate timer.
  const BOSS_LANDING_RED_FLASH_PULSES = 3;
  const BOSS_LANDING_RED_FLASH_ON_MS = 70;
  const BOSS_LANDING_RED_FLASH_OFF_MS = 70;
  const BOSS_LANDING_RED_FLASH_CYCLE_MS = BOSS_LANDING_RED_FLASH_ON_MS + BOSS_LANDING_RED_FLASH_OFF_MS;
  const BOSS_LANDING_RED_FLASH_TOTAL_MS = BOSS_LANDING_RED_FLASH_PULSES * BOSS_LANDING_RED_FLASH_CYCLE_MS; // 420ms
  const BOSS_LANDING_RED_FLASH_ALPHA_MAX = 0.35;
  let landingRedFlashRemainingMs = 0;
  // SECTION J: ENCOUNTER 3's forced-STUN red flash — its OWN separate
  // timer/state, deliberately never sharing landingRedFlashRemainingMs (or
  // any other existing flash) so the two can never compete or get confused
  // with each other. J-3: ~3 pulses, same on/off cadence as the landing
  // flash above for visual consistency.
  const ENCOUNTER3_STUN_FLASH_PULSES = 3;
  const ENCOUNTER3_STUN_FLASH_ON_MS = 90;
  const ENCOUNTER3_STUN_FLASH_OFF_MS = 90;
  const ENCOUNTER3_STUN_FLASH_CYCLE_MS = ENCOUNTER3_STUN_FLASH_ON_MS + ENCOUNTER3_STUN_FLASH_OFF_MS;
  const ENCOUNTER3_STUN_FLASH_TOTAL_MS = ENCOUNTER3_STUN_FLASH_PULSES * ENCOUNTER3_STUN_FLASH_CYCLE_MS; // 540ms
  const ENCOUNTER3_STUN_FLASH_ALPHA_MAX = 0.45;
  let encounter3StunFlashRemainingMs = 0;
  // HP-threshold reactions: keyed by CUMULATIVE damage taken this life,
  // expressed as the HP value at/below which that much damage has landed
  // (HP only ever decreases, so this is equivalent and simpler than
  // tracking a separate cumulative-damage counter). Ordered deepest first
  // so a single hit that crosses more than one at once only plays the
  // deepest one's cinematic — see checkBossHpMilestones().
  const BOSS_PHASE_THRESHOLDS = [
    { key: 'p90', hpAtOrBelow: BOSS_HP_MAX * 0.10 }, // 90% of max HP lost
    { key: 'p60', hpAtOrBelow: BOSS_HP_MAX * 0.40 }, // 60% of max HP lost
    { key: 'p30', hpAtOrBelow: BOSS_HP_MAX * 0.70 }, // 30% of max HP lost
  ];
  const THRESHOLD_CINEMATIC_MS = 600;
  // SECTION U: death rework — sharp instant blacken -> the body cracks
  // apart from several points at once -> fine black/dark-gray shards sweep
  // away up/upper-right, accelerating as they go -> a brief dim residual
  // outline -> gone. No pre-blacken hold anymore (the old 500ms DOWN pose
  // pause read as "mosaic"/sluggish) — blackening starts the instant death
  // triggers. DYING_DURATION_MS is still the one value everything else
  // (updateBossDying()'s exit check, window.__game's exposed constant)
  // treats as "how long the whole 'dying' state lasts".
  const BOSS_DEFEAT_BLACKEN_MS = 140; // U-3: 100-180ms band — color dies almost instantly
  const BOSS_DEFEAT_DISINTEGRATE_MS = 860; // U-2: BLACKEN+DISINTEGRATE totals ~1000ms
  const BOSS_DEFEAT_BLACKEN_START = 0;
  const BOSS_DEFEAT_BLACKEN_END = BOSS_DEFEAT_BLACKEN_START + BOSS_DEFEAT_BLACKEN_MS;
  const DYING_DURATION_MS = BOSS_DEFEAT_BLACKEN_END + BOSS_DEFEAT_DISINTEGRATE_MS;
  // U-9: several simultaneous crack origins (shoulder/wing, torso, leg/claw
  // areas) instead of one single top-to-bottom sweep — a small FIXED set of
  // relative points (not re-randomized per death) so the pattern still
  // reads as controlled/consistent rather than a different shape every
  // time, while still looking like it starts from multiple places at once.
  const DEATH_CRACK_SEED_FRACS = [
    { x: 0.28, y: 0.20 }, { x: 0.72, y: 0.18 }, { x: 0.50, y: 0.48 },
    { x: 0.30, y: 0.80 }, { x: 0.70, y: 0.82 },
  ];
  // U-10: outer columns (wings/CLAW reach far to either side of the torso)
  // dissolve a little later, so the silhouette stays readable longest.
  const DEATH_OUTER_COLUMN_FRAC = 0.55; // |x - center| beyond this fraction of half-width counts as "outer"
  const DEATH_OUTER_DELAY_FRAC = 0.16; // added to dissolveAt for outer cells
  // U-5/U-6: swept away up/upper-right, not falling — angle jitter per
  // particle, distance grows with localT^EASE_POWER (slow start, fast
  // finish), no gravity at all anymore.
  const DEATH_PARTICLE_BASE_ANGLE = -Math.PI / 4; // upper-right
  const DEATH_PARTICLE_ANGLE_JITTER = 0.9; // +/- radians
  const DEATH_PARTICLE_EASE_POWER = 2.3;
  // U-7: most grains small (2-5px diameter == radius 1-2.5), a few larger
  // elongated shards (6-10px diameter == radius 3-5, drawn as thin rotated
  // rectangles rather than circles).
  const DEATH_SHARD_FRAC = 0.14; // fraction of particles rendered as elongated shards
  // U-8: the last ~250ms holds a faint, low-alpha residual outline of
  // whatever's left of the silhouette, then snaps off over a brief final
  // window — never a slow linear fade across the whole tail.
  const DEATH_RESIDUE_WINDOW_MS = 250;
  const DEATH_RESIDUE_SNAP_MS = 50;
  const DEATH_RESIDUE_ALPHA = 0.4;
  // U-11: a short, sharp one-shot screen flash + shake right as death
  // triggers — deliberately distinct from COUNTER's own multi-pulse
  // flicker (COUNTER_FLASH_*) and FLASH GRENADE's screen flash.
  const DEATH_FLASH_MS = 150;
  const DEATH_SHAKE_MAG = 10;
  const DEATH_SHAKE_MS = 200;
  let deathFlashRemainingMs = 0;
  // Fine sand/ash grain, not blocky squares — small enough that the sampling
  // grid itself reads as smooth erosion rather than visible pixel chunks.
  const DYING_CELL_SIZE = 3; // px, sampled at the cinematic sprite's on-screen size
  const PLAYER_HIT_RADIUS = 22;

  // Where the claw attacks (ARC CLAW SLASH / CLAW STING) spawn from — near
  // the claws, not the torso center. NORTH/SOUTH use fixed points measured directly on their own
  // attack_{north,south}.png canvas (converted to a boss-relative screen
  // offset the same way the DEFENSE weak points are); EAST/WEST keep the
  // pre-existing generic radial offset toward the facing direction, since
  // there's no dedicated EAST/WEST attack art to measure a claw position on.
  const CLAW_ORIGIN_CANVAS = {
    south: { x: 480, y: 470 }, // base of the extended claw cluster in attack_south.png
    north: { x: 200, y: 140 }, // raised claw joint in attack_north.png
  };
  function getClawOrigin() {
    const key = DIR_TO_BOSS_KEY[boss.dir];
    const off = CLAW_ORIGIN_CANVAS[key];
    if (off) {
      const scale = BOSS_DRAW_H / BOSS_CANVAS_H;
      return {
        x: boss.x + (off.x - BOSS_CANVAS_W / 2) * scale,
        y: boss.y + (off.y - BOSS_CANVAS_H / 2) * scale,
      };
    }
    const facing = BASE_ANGLE[boss.dir];
    return {
      x: boss.x + Math.cos(facing) * (BOSS_DRAW_W * 0.32),
      y: boss.y + Math.sin(facing) * (BOSS_DRAW_W * 0.32),
    };
  }

  // Weak point: the large red eye on the DEFENSE mask. Its screen position
  // depends on which DEFENSE direction is currently showing, since the
  // boss is a completely different silhouette from each side — measured
  // separately on each of the 4 defense_*.png 700x920 canvases (color-
  // cluster detection, confirmed visually against a marked-up crop for
  // each). NORTH is the boss's back — no face is visible at all — so it
  // has no weak point; a bullet can never score a weak-point hit while the
  // boss is defending north, no matter how precisely aimed.
  const WEAKPOINT_OFFSETS = {
    south: { x: 344.6, y: 215.5 },
    east: { x: 434.4, y: 248.8 },
    west: { x: 282.8, y: 193.3 },
    north: null, // back view — eye not visible, weak point disabled for this direction
  };
  const WEAKPOINT_HIT_RADIUS = 16; // screen px — generous for touch, still eye-only not head-wide

  // ---------- WEAK-POINT-SPAM teleport countermeasure (PART 7) ----------
  // Replaces the old "forced counter" response (knockback + immediate
  // counterattack) to WEAKPOINT_FORCED_COUNTER_HITS consecutive weak-point
  // hits: a brief full-screen blackout, GABRIEL vanishing, a teleport to a
  // freshly-validated random stage coordinate, then a fade back in and a
  // resume of normal combat from the new spot. Deliberately its OWN
  // blackout/state machinery — entirely separate variables and its own
  // boss.state ('teleport') — so it can never be confused with or corrupt
  // DARK PHASE's own blackout (darkPhaseOverlayAlpha/state 'darkphase').
  const TELEPORT_BLACKOUT_MS = 260; // screen fades to black, GABRIEL still at the old spot but no longer drawn
  const TELEPORT_HOLD_MS = 220; // fully black — the actual reposition happens here
  const TELEPORT_FADEIN_MS = 260; // fades back in at the new spot
  const TELEPORT_TOTAL_MS = TELEPORT_BLACKOUT_MS + TELEPORT_HOLD_MS + TELEPORT_FADEIN_MS;
  const TELEPORT_OVERLAY_ALPHA = 0.95; // near-total black, matches DARKPHASE_OVERLAY_ALPHA's read
  const TELEPORT_MIN_DIST_FROM_PLAYER = CLOSE_RANGE_SHOT_THRESHOLD * 3; // guarantees the reappear point is never point-blank to the player
  let teleportBlackoutAlpha = 0;

  const DIR_TO_BOSS_KEY = { up: 'north', down: 'south', left: 'west', right: 'east' };
  const OPPOSITE_COMPASS = { north: 'south', south: 'north', east: 'west', west: 'east' };

  const boss = {
    name: 'GABRIEL', // official display name — internal field so every player-visible label (WARNING banner, debug/aria text) reads from one source
    downFacing: 'south', // captured ONCE when a DOWN/CINEMATIC sequence begins (intro/threshold/dying) — see getCinematicImageInfo(); never mutated mid-sequence even if boss.dir changes underneath it
    x: 0, y: 0,
    spawned: false,
    state: 'inactive', // inactive | chase | preattack | attack | defense | guardbreak | recover | dead
    dir: 'down', // shared player-style bucket key; mapped to north/south/east/west for movement/attack facing
    defenseDir: 'south', // 'north'|'south'|'east'|'west' — which DEFENSE sprite/weak-point is active; set from incoming fire, independent of `dir`
    moving: false,
    hp: BOSS_HP_MAX,
    stateEnteredAt: 0,
    attackHitApplied: false,
    attackProjectileSpawned: false,
    attackFiresImmediately: false, // true when ATTACK arrived via PRE_ATTACK/forced-counter (blade fires on entry, no extra windup)
    attackType: 'blade', // 'blade' (existing melee swing) | 'arcClaw' (ARC CLAW SLASH) | 'clawSting' (CLAW STING) — chosen in enterAttackSequence()
    lastAttackType: 'blade', // tracks the previous attack so neither special attack can fire twice in a row
    darkPhaseArcAttackKind: 'slash', // 'slash' | 'sting' — which claw attack the current DARK PHASE strike uses, re-rolled fresh each individual claw
    chaseBackoffUntil: 0,
    deadAt: 0,
    defenseAimHits: 0, // valid AUTO-AIM-assisted hits landed during the current DEFENSE
    weakPointConsecutiveHits: 0, // ANY valid weak-point damage hit (auto-aimed or manual) landed during the current DEFENSE
    consecutiveGuardedShots: 0, // shots successfully BLOCKED (0 damage) during the current DEFENSE — see applyBodyHitToBoss(); resets to 0 on any non-'defense' state transition, same lifecycle as the two counters above
    straightClawHitSpawned: false, // guards the single spawnStraightClaw()/spawnCounterArcClaw() call per 'straightclaw' state — see bossEnterState()/updateBossStraightClaw()
    counterDir: 'south', // 'south'|'north'|'east'|'west' — captured ONCE at COUNTER ATTACK trigger time from the player's position relative to GABRIEL; picks STING (south) vs COUNTER ARC CLAW/STRAIGHT CLAW (north/east/west) — see applyBodyHitToBoss()/bossFrameName()/updateBossStraightClaw()
    counterAttackKind: 'arcClaw', // 'arcClaw'|'straightClaw' — SECTION J: rolled ONCE alongside counterDir, only meaningful when counterDir !== 'south' (south always keeps its own STING)
    // New-turn SECTION 14: true only for a 'straightclaw' COUNTER entered via
    // the DEFENSE-2-blocked-shots forced trigger (applyBodyHitToBoss()) —
    // false for every other way 'straightclaw' is entered (the close-range
    // proximity COUNTER just below it in updateBoss()). Read by
    // spawnStraightClaw() to mark ONLY that specific projectile as piercing
    // DASH invulnerability — see arcClawSlashes' own `piercesDashInvulnerability`
    // field and its one read site in updateArcClawSlashes().
    isDefenseCounter: false,
    autoAimHitStreak: 0, // ANY valid AUTO-AIM-assisted damage hit, body or weak point, regardless of state — see registerGlobalAutoAimHit()
    darkPhaseTriggeredThisEncounter: false, // SECTION J: reset fresh by spawnBoss() each ENCOUNTER — guarantees ENCOUNTER 2/3 see DARK PHASE at least once (see the guarantee check in updateBoss()), regardless of the player's own AUTO AIM usage
    invulnerableUntil: 0, // legacy field — no longer ever set to a nonzero value (4-hit AUTO AIM now triggers DARK PHASE, not a timed window); left in place harmlessly
    closeRangeInvulnUntil: 0, // set by the POINT-BLANK counter — see triggerCloseRangeCounter()
    teleportElapsed: 0, // dt-driven elapsed ms into the current 'teleport' state — see updateBossTeleport()
    teleportDest: null, // {x,y} chosen once at trigger time, applied at the blackout's midpoint — see pickTeleportDestination()
    // STEALTH tracking-suppression (PART 16-19): captured ONCE at STEALTH's
    // activation, never updated again while it's active — see
    // getBossTargetPos(), the single function every piece of GABRIEL AI
    // (CHASE movement/facing, every DARK PHASE sub-state, both normal and
    // DARK PHASE CLAW STING/ARC CLAW SLASH targeting) reads its "where is
    // the player" belief from, instead of live player.x/y, whenever STEALTH
    // is active.
    lastKnownPlayerX: 0,
    lastKnownPlayerY: 0,
    // Set the instant the player fires while STEALTH is active (any fire —
    // manual or AUTO-AIM-assisted, see the wantsFire block in update()),
    // cleared again only by the next STEALTH activation. null = no reveal
    // yet this STEALTH window, so getBossTargetPos() falls back to
    // lastKnownPlayerX/Y above.
    revealedShotX: null,
    revealedShotY: null,
    darkPhaseAttackTimer: 0, // dt-driven sub-phase timer, meaning depends on darkPhaseSubState — see updateBossDarkPhase()
    // SECTION C rebuild: 'hidden' (fully invisible/untargetable) ->
    // 'telegraph' (mask visible, no attack yet) -> 'attacking' (firing the
    // planned 2-3 CLAW attacks) -> back to 'hidden' at a new position,
    // forever. Defaults to 'attacking' (a visible, targetable placeholder)
    // so tests/tools that force boss.state='darkphase' directly without
    // going through startBossDarkPhase() still see a normal, aimable mask —
    // a genuine entry always explicitly sets this to 'hidden' first.
    darkPhaseSubState: 'attacking',
    darkPhasePrevX: 0, darkPhasePrevY: 0, // the position relocated FROM, so the next relocate can enforce DARK_PHASE_MIN_RELOCATE_DISTANCE from it
    darkPhaseClawsPlannedCount: 2, // 2 or 3, re-rolled 50/50 each time ATTACKING begins
    darkPhaseClawsFiredCount: 0,
    darkPhaseCurrentClawLifetimeMs: 0, // the just-fired claw's own lifetime, so ATTACKING knows how long to wait (+ DARK_PHASE_CLAW_INTERVAL_MS) before the next one
    // Cinematic sequence state (intro / HP threshold / death) — see the
    // "Boss cinematic sequences" constants above and startBossThreshold(),
    // startBossDying(), updateBossIntro/Threshold/Dying(), drawBoss*().
    phaseTriggered: { p30: false, p60: false, p90: false },
    introTargetY: 0, // the one resting Y position for the whole intro — PART 6: GABRIEL never visibly slides into place, so there is no separate "from" position anymore
    introLandingTriggered: false, // guards the one-shot landing shake at BOSS_INTRO_SHADOW_END
    // Elapsed ms into the CURRENT cinematic phase — updated only from
    // inside update() (which PAUSE already short-circuits entirely), so
    // every cinematic timer freezes for free whenever the game is paused
    // and resumes exactly where it left off; draw()-side rendering reads
    // this cached value instead of computing its own now-vs-stateEnteredAt
    // elapsed time, since draw() keeps receiving a live, ever-advancing
    // `now` even while paused.
    cinematicElapsed: 0,
    dyingParticlesBuilt: false,
    dyingParticles: [],
  };

  // Temporary local-verification aid (see the investigation into DARK PHASE
  // not triggering) — logs every boss.state transition through the single
  // function they all flow through. Disabled by default; flip to true only
  // for local debugging, never in a deployed build.
  const DEBUG_BOSS_STATE_LOG = false;
  function bossEnterState(state, now) {
    if (DEBUG_BOSS_STATE_LOG && state !== boss.state) {
      console.log(`[BOSS] ${boss.state} -> ${state}`);
    }
    boss.state = state;
    boss.stateEnteredAt = now;
    if (state === 'attack') {
      boss.attackHitApplied = false;
      boss.attackProjectileSpawned = false;
    }
    if (state === 'straightclaw') {
      boss.straightClawHitSpawned = false;
      // New-turn SECTION 14: defaults false on every entry into
      // 'straightclaw' — the DEFENSE-2-blocked-shots trigger site
      // (applyBodyHitToBoss()) sets this true immediately after calling
      // bossEnterState(), so every OTHER entry point (the close-range
      // proximity COUNTER) naturally stays false without needing its own
      // explicit reset.
      boss.isDefenseCounter = false;
    }
    // The GUARD BREAK, weak-point-streak, and guarded-shot counters only
    // ever mean something mid-DEFENSE — reset them the instant any other
    // state (fresh DEFENSE included, since this covers entering it too;
    // entering 'straightclaw' itself is included here too, satisfying "the
    // counter resets when the counter starts") is entered so a stale count
    // never survives.
    if (state !== 'defense') {
      boss.defenseAimHits = 0;
      boss.weakPointConsecutiveHits = 0;
      boss.consecutiveGuardedShots = 0;
    }
    // Cinematic phases track their own progress by accumulating `dt` inside
    // update() (which PAUSE already skips entirely) rather than by
    // `now - stateEnteredAt` — the latter would jump forward by however
    // long a real-world PAUSE lasted the instant it resumes, effectively
    // skipping the rest of the cinematic instead of continuing it.
    if (state === 'intro' || state === 'threshold' || state === 'dying' || state === 'flashdown') {
      boss.cinematicElapsed = 0;
    }
  }

  // Picks which attack this cycle will be, for NORMAL combat (PART 11):
  // melee ('blade' — the original swing, its own hitbox handled directly in
  // the 'attack' state branch below) + ARC CLAW SLASH + CLAW STING. Neither
  // special attack (SLASH/STING) is ever allowed to repeat itself back to
  // back — it falls back to melee instead — so the pattern stays varied
  // rather than repeating the newest, flashiest move every time; melee
  // itself has no such restriction, same as before this batch.
  function rollAttackType() {
    const r = Math.random();
    const choice = r < 1 / 3 ? 'arcClaw' : (r < 2 / 3 ? 'clawSting' : 'blade');
    if (choice !== 'blade' && choice === boss.lastAttackType) return 'blade';
    return choice;
  }

  // Shared entry point for "boss.dir is already set toward the target,
  // now begin an attack" — used by CHASE->ATTACK and the weak-point
  // forced-counter (PART 9/10). NORTH has no PRE_ATTACK art, so it skips
  // straight to ATTACK (self-contained windup, unchanged); SOUTH telegraphs
  // through PRE_ATTACK first. EAST/WEST used to telegraph too, but their
  // PRE_ATTACK has been removed — they now go straight to ATTACK exactly
  // like NORTH. GUARD BREAK's own attack entry deliberately does NOT go
  // through this — see its branch in updateBoss().
  function enterAttackSequence(now) {
    boss.attackType = rollAttackType();
    boss.lastAttackType = boss.attackType;
    if (DIR_TO_BOSS_KEY[boss.dir] === 'south') {
      bossEnterState('preattack', now);
    } else {
      boss.attackFiresImmediately = false;
      bossEnterState('attack', now);
    }
  }

  function spawnBoss(now) {
    const areaTop = areaTopY(currentArea); // SECTION C: same relative composition in AREA 1 or AREA 2
    boss.x = W / 2;
    boss.introTargetY = areaTop + Math.max(BOSS_DRAW_H * 0.55, H * 0.16); // the normal resting spawn spot
    boss.y = boss.introTargetY; // PART 6: no visible slide-in — GABRIEL is silhouette-revealed then lands INSTANTLY, always at this one position
    boss.spawned = true;
    boss.hp = BOSS_HP_MAX;
    boss.dir = 'down';
    boss.downFacing = 'south'; // fresh spawn always has no prior facing yet — default SOUTH per spec
    boss.defenseDir = 'south';
    boss.moving = false;
    boss.defenseAimHits = 0;
    boss.autoAimHitStreak = 0;
    boss.darkPhaseTriggeredThisEncounter = false; // SECTION J: fresh per ENCOUNTER
    boss.invulnerableUntil = 0;
    boss.attackType = 'blade';
    boss.lastAttackType = 'blade';
    boss.phaseTriggered = { p30: false, p60: false, p90: false };
    boss.introLandingTriggered = false;
    boss.cinematicElapsed = 0;
    boss.dyingParticlesBuilt = false;
    boss.dyingParticles = [];

    // PART 1: the player is placed into a fixed reference pose the instant
    // the intro begins — center-bottom of PLAY AREA, facing the direction
    // GABRIEL will land in (north) — expressed as a PLAY AREA fraction (W/H)
    // rather than an absolute pixel so the same composition holds on any
    // screen size/orientation. MOVE/AIM/FIRE/DASH/FLASH/STEALTH are all
    // locked out for the whole sequence — see isBossIntroLocked() and its
    // call sites — so nothing can move the player away from this pose
    // before battle actually starts.
    player.x = W * 0.50;
    player.y = areaTop + H * 0.80;
    player.baseDir = 'up';
    player.moving = false;
    player.dashing = false;
    player.aimOffsetRaw = BASE_ANGLE.up;
    player.aimOffset = BASE_ANGLE.up;
    triggerScreenShake(now, BOSS_INTRO_SHAKE_MAG, BOSS_INTRO_INITIAL_SHAKE_MS); // PART 4: the initial shake starts immediately, right as the intro begins
    introStartFlashRemainingMs = BOSS_INTRO_START_FLASH_TOTAL_MS; // SECTION R: the real BOSS INTRO trigger — spawnBoss() only ever fires once, in AREA1

    // BOSS MODE only ever shows this — TRAINING MODE never calls
    // spawnBoss() at all, so it never plays.
    bossEnterState('intro', now);
  }

  function bossIsInCinematic() {
    return boss.state === 'intro' || boss.state === 'threshold' || boss.state === 'dying' || boss.state === 'dead';
  }

  // PART 3 SECTION C: the SAME state checks applyBodyHitToBoss()/
  // applyExplosionDamageToBoss() already use to actually zero out damage —
  // reused here verbatim for the BOSS LIFE gauge's "無敵" indicator rather
  // than inventing a new, separate visual-only heuristic (C-1). 'defense'
  // (DEFENSE blocks all body-hit HP loss — see applyBodyHitToBoss()),
  // 'straightclaw' (COUNTER's own invulnerability window), 'darkphase' and
  // 'teleport' (both explicitly documented as "total damage immunity"
  // above) are the real damage-zero states; cinematic states
  // (intro/threshold/dying/dead) and the brief 250ms 'guardbreak' stagger
  // are deliberately excluded — those aren't the "boss is currently
  // blocking/evading your hits" mechanic this indicator is about.
  function isBossDamageImmune() {
    if (!boss.spawned || bossIsInCinematic()) return false;
    return boss.state === 'defense' || boss.state === 'straightclaw' || boss.state === 'darkphase' || boss.state === 'teleport';
  }

  // PART 8 / SECTION B: scoped to the whole boss-appearance window — from
  // BOSS MODE start (before spawnBoss() has even fired, boss.spawned still
  // false) through the INTRO cinematic itself — never threshold/dying/dead,
  // which have always left the player free to move. MOVE-TRANSLATION/AIM/
  // FIRE/DASH/FLASH/STEALTH are all suppressed for this whole window, so the
  // player can never walk away from wherever they're standing (or aim/fire)
  // before battle actually begins. SECTION H: MOVE STICK is the one allowed
  // exception, and only for facing (setBaseDir) — see the movement block in
  // update(), which still blocks actual x/y translation during this lock;
  // AIM STICK is now fully inert during this window (handleAimStickMove()
  // and both AIM-stick listeners early-return on this same check).
  function isBossIntroLocked() {
    // SECTION A (root-cause fix, this turn): LIFE reaching 0 on a finite
    // setting used to rely on THIS check alone to halt input — forever,
    // completely silently, since no GAME OVER screen existed to ever move
    // gameState.screen away from 'gameplay' again. That silent permanent
    // lock is the actual bug behind "operations become impossible during
    // DARK PHASE" (DARK PHASE's own CLAW barrage is simply the single
    // highest-damage, hardest-to-avoid attack pattern, so LIFE most often
    // actually reached 0 while DARK PHASE happened to be active — the bug
    // itself was never DARK-PHASE-specific). Fixed for real by giving
    // LIFE=0 a proper terminal screen (see triggerGameOver(), called from
    // applyDamageToPlayerLife()) instead of leaving it to this flag alone.
    // The check below is kept as a harmless defense-in-depth belt-and-
    // suspenders (by the time it could matter, gameState.screen has
    // already left 'gameplay' and update() has stopped running entirely,
    // so this line is not the thing doing the real work anymore).
    if (player.life <= 0) return true;
    // SECTION P: freeze input during the post-defeat "GAME CLEAR!!" overlay
    // window too, for the same reason (no gameplay should proceed while a
    // terminal screen is about to take over).
    if (gameClearRemainingMs > 0) return true;
    // DARK OUT PART 3: same reasoning as GAME CLEAR above, for BOSS BATTLE
    // MODE's own separate "BOSS DEFEATED" hold (see bossBattleDefeatRemainingMs).
    if (bossBattleDefeatRemainingMs > 0) return true;
    // DARK OUT PART 3: BOSS BATTLE MODE shares this exact same INTRO-lock
    // behavior (GABRIEL's own spawnBoss()/updateBoss() are reused as-is —
    // see startBossBattle()) — never a second copy of this check.
    if (gameState.mode !== 'boss' && gameState.mode !== 'bossBattle') return false;
    // PART (this turn) SECTION A: this lock exists ONLY to hold the player
    // still/blind/silent while GABRIEL's own BOSS INTRO cinematic is about
    // to play or playing — it must never apply to a DRONE-type STORY STAGE,
    // which has no GABRIEL/BOSS INTRO at all (boss.spawned is permanently
    // false there under the current STORY_STAGE_PLAN). Before this check,
    // `!boss.spawned` alone was true for the ENTIRE duration of every
    // DRONE-type STAGE — a lock with no release condition, which is the
    // actual root cause of "STORY DRONE STAGE开始時に操作不能" (not a timing
    // race, not something a delay/timeout could paper over). FINAL STAGE is
    // a boss-type STAGE (GABRIEL spawns immediately on entry — see
    // enterStoryStage()), so it keeps the exact same wait-for-INTRO
    // behavior as ENCOUNTER 1/2 below, unchanged.
    if (isStoryDroneStage()) return false;
    return !boss.spawned || boss.state === 'intro';
  }

  // SECTION C/I: STUN is a genuine, separate status effect (never folded
  // into isBossIntroLocked() itself) because that lock's own MOVE-STICK-
  // still-changes-facing carve-out (SECTION H) must NOT apply to STUN —
  // STUN blocks MOVE completely, no exceptions. Kept as its own tiny
  // predicate purely so every gate below reads the same way regardless of
  // which lock is in effect.
  function isStunLocked() {
    return player.stunned;
  }

  // Called after any HP reduction. Returns true if the hit was instead
  // absorbed by a cinematic transition (death, or a newly-crossed HP
  // threshold) — callers must stop and not apply any further state change
  // of their own for that same hit (this is also what makes a threshold
  // cinematic take priority over a same-frame GUARD BREAK, per spec).
  function checkBossHpMilestones(now) {
    if (boss.hp <= 0) {
      startBossDying(now);
      return true;
    }
    let deepestNew = null;
    for (const th of BOSS_PHASE_THRESHOLDS) {
      if (!boss.phaseTriggered[th.key] && boss.hp <= th.hpAtOrBelow) {
        boss.phaseTriggered[th.key] = true; // mark every crossed threshold so none re-fires later...
        if (!deepestNew) deepestNew = th.key; // ...but only the single deepest one actually plays
      }
    }
    if (deepestNew) {
      startBossThreshold(now);
      return true;
    }
    return false;
  }

  function startBossThreshold(now) {
    // Capture facing ONCE, right as the cinematic begins — bossEnterState()
    // below (and anything that runs afterward) must never change which
    // image this sequence uses partway through.
    boss.downFacing = DIR_TO_BOSS_KEY[boss.dir];
    triggerScreenShake(now, 5, 150);
    bossEnterState('threshold', now);
  }

  function startBossDying(now) {
    boss.downFacing = DIR_TO_BOSS_KEY[boss.dir]; // same one-time capture as startBossThreshold()
    arcClawSlashes.length = 0; // no lingering attack hazards during the death cinematic
    boss.dyingParticlesBuilt = false;
    boss.dyingParticles = [];
    // U-11: one short, sharp impact moment right as death triggers — a
    // one-shot white flash + brief shake, distinct from COUNTER's own
    // multi-pulse flicker.
    triggerScreenShake(now, DEATH_SHAKE_MAG, DEATH_SHAKE_MS);
    deathFlashRemainingMs = DEATH_FLASH_MS;
    bossEnterState('dying', now);
  }

  // Triggered by 4 valid AUTO-AIM-assisted hits (see registerGlobalAutoAimHit()
  // above) — GABRIEL goes fully invulnerable (body/weak-point/AUTO-AIM/
  // barrel-explosion damage all become 0 — see applyBodyHitToBoss()/
  // applyExplosionDamageToBoss()) and switches to a SLASH/STING-only AI
  // (see updateBossDarkPhase()). Deliberately NOT added to bossIsInCinematic()
  // — DARK PHASE must stay a valid AUTO AIM target (it just takes 0 damage),
  // and FLASH GRENADE must stay usable during it. Has NO timeout of its
  // own — see startBossFlashDown() below for the only way out.
  // SECTION C: reuses pickTeleportDestination()'s own safe-coordinate method
  // (stage margins, isNearUIZone, barrel clearance, player clearance) so a
  // DARK PHASE relocate is validated exactly the same way TELEPORT's own
  // reappear point already is — never off-screen, never inside a wall/UI
  // margin, never on top of a barrel, never too close to the player — plus
  // an extra check against `fromX/fromY` (the position being relocated FROM)
  // so consecutive relocations never land near-identical spots.
  function pickDarkPhaseRelocatePosition(fromX, fromY) {
    const marginX = BOSS_DRAW_W * 0.6;
    const marginTop = H * 0.22;
    const marginBottom = H * 0.30;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = marginX + Math.random() * (W - marginX * 2);
      const y = marginTop + Math.random() * (H - marginTop - marginBottom);
      if (isNearUIZone(x, y)) continue;
      if (Math.hypot(x - player.x, y - player.y) < TELEPORT_MIN_DIST_FROM_PLAYER) continue;
      if (Math.hypot(x - fromX, y - fromY) < DARK_PHASE_MIN_RELOCATE_DISTANCE) continue;
      let tooCloseToBarrel = false;
      for (const b of barrels) {
        if ((b.alive || b.falling) && Math.hypot(x - b.x, y - b.y) < BARREL_DRAW_H * 2) { tooCloseToBarrel = true; break; }
      }
      if (tooCloseToBarrel) continue;
      return { x, y };
    }
    // Fallback (all attempts collided, e.g. a very small screen or a very
    // crowded barrel layout): rather than a single fixed-angle projection
    // that clamping could undercut back toward `from`, pick whichever
    // corner of the valid on-stage box is actually farthest from `from` —
    // guaranteed to already be in-bounds, and the best achievable
    // separation this box allows.
    const corners = [
      { x: marginX, y: marginTop },
      { x: W - marginX, y: marginTop },
      { x: marginX, y: H - marginBottom },
      { x: W - marginX, y: H - marginBottom },
    ];
    let best = corners[0], bestDist = -1;
    for (const c of corners) {
      const d = Math.hypot(c.x - fromX, c.y - fromY);
      if (d > bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  function startBossDarkPhase(now) {
    arcClawSlashes.length = 0; // no lingering attacks from before DARK PHASE began
    boss.darkPhasePrevX = boss.x;
    boss.darkPhasePrevY = boss.y;
    const dest = pickDarkPhaseRelocatePosition(boss.x, boss.y);
    boss.x = dest.x;
    boss.y = dest.y;
    boss.darkPhaseAttackTimer = 0;
    boss.darkPhaseClawsFiredCount = 0;
    boss.darkPhaseSubState = 'hidden'; // fully invisible/untargetable for DARK_PHASE_HIDDEN_MS, per spec
    bossEnterState('darkphase', now);
    // SECTION J (PART 5 SECTION Q/R/W-5: now keyed off bossEncounterIndex,
    // never the raw STORY STAGE position): ENCOUNTER 3 forces STUN the
    // instant DARK PHASE transitions in — J-5's own explicit "on
    // transition, not on every loop" wording is satisfied for free here,
    // since startBossDarkPhase() only ever runs once per DARK PHASE entry
    // (the hidden->telegraph->attacking loop inside updateBossDarkPhase()
    // never calls this function again until the next FULL DARK PHASE
    // entry). J-4: skipped outright if already stunned, so this can never
    // re-flash/double-STUN a player who is already in that state for some
    // other reason (idle watchdog, a previous ENCOUNTER 3 DARK PHASE loop,
    // etc).
    if (bossEncounterIndex === 2 && !player.stunned) {
      encounter3StunFlashRemainingMs = ENCOUNTER3_STUN_FLASH_TOTAL_MS;
      triggerStun(now);
    }
  }

  function isDarkPhaseHidden() {
    return boss.state === 'darkphase' && boss.darkPhaseSubState === 'hidden';
  }

  // Fires ONE CLAW attack (SLASH or STING, 50/50, reusing the existing
  // ARC CLAW SLASH / CLAW STING geometry wholesale) from GABRIEL's current
  // (mask-visible) position, and records its lifetime so the ATTACKING
  // sub-state below knows how long to hold before the next one/the loop end.
  function fireDarkPhaseClaw(now) {
    const targetPos = getBossTargetPos(now);
    boss.dir = angleToBucket(Math.atan2(targetPos.y - boss.y, targetPos.x - boss.x));
    boss.darkPhaseArcAttackKind = Math.random() < 0.5 ? 'slash' : 'sting';
    if (boss.darkPhaseArcAttackKind === 'sting') {
      spawnClawSting(now, getClawOrigin(), targetPos);
      boss.darkPhaseCurrentClawLifetimeMs = CLAW_STING_LIFETIME_MS;
    } else {
      spawnArcClawSlash(now);
      boss.darkPhaseCurrentClawLifetimeMs = ARC_CLAW_LIFETIME_MS;
    }
  }

  // SECTION C rebuild — HIDDEN -> TELEGRAPH -> ATTACKING -> (relocate) ->
  // HIDDEN, forever, until FLASH GRENADE ends DARK PHASE (see
  // startBossFlashDown()). GABRIEL never chases/approaches during this
  // loop — every position change is an instant relocate between cycles;
  // the only motion in-frame is the reused CLAW attacks themselves.
  //   hidden    -> no sprite, no hitbox, no FLASH target at all, for
  //                DARK_PHASE_HIDDEN_MS
  //   telegraph -> the direction-appropriate mask reappears at the new
  //                (already relocated) position, scaled by
  //                DARK_PHASE_MASK_SCALE_BOOST, fully FLASH-targetable, for
  //                DARK_PHASE_MASK_TELEGRAPH_MS before any attack fires
  //   attacking -> fires 2 or 3 CLAW attacks (50/50, re-rolled each cycle),
  //                each one's own lifetime plus DARK_PHASE_CLAW_INTERVAL_MS
  //                separating it from the next, still fully FLASH-targetable
  // Once the planned claw count is reached, the mask disappears immediately
  // and GABRIEL relocates to a new position (never near-repeating the one
  // just vacated) and the whole loop restarts from HIDDEN.
  function updateBossDarkPhase(dt, now) {
    boss.moving = false; // never chases/approaches in this rebuild — see comment above
    boss.darkPhaseAttackTimer += dt * 1000;
    if (boss.darkPhaseSubState === 'hidden') {
      if (boss.darkPhaseAttackTimer >= DARK_PHASE_HIDDEN_MS) {
        boss.darkPhaseAttackTimer = 0;
        boss.darkPhaseSubState = 'telegraph';
      }
      return;
    }
    if (boss.darkPhaseSubState === 'telegraph') {
      if (boss.darkPhaseAttackTimer >= DARK_PHASE_MASK_TELEGRAPH_MS) {
        boss.darkPhaseAttackTimer = 0;
        boss.darkPhaseClawsPlannedCount = Math.random() < 0.5 ? 2 : 3;
        boss.darkPhaseClawsFiredCount = 0;
        boss.darkPhaseSubState = 'attacking';
        fireDarkPhaseClaw(now);
        boss.darkPhaseClawsFiredCount = 1;
      }
      return;
    }
    // 'attacking'
    const waitMs = boss.darkPhaseCurrentClawLifetimeMs + DARK_PHASE_CLAW_INTERVAL_MS;
    if (boss.darkPhaseAttackTimer >= waitMs) {
      boss.darkPhaseAttackTimer = 0;
      if (boss.darkPhaseClawsFiredCount < boss.darkPhaseClawsPlannedCount) {
        fireDarkPhaseClaw(now);
        boss.darkPhaseClawsFiredCount++;
      } else {
        // Cycle complete: mask disappears immediately, relocate, loop back
        // to HIDDEN.
        boss.darkPhasePrevX = boss.x;
        boss.darkPhasePrevY = boss.y;
        const dest = pickDarkPhaseRelocatePosition(boss.x, boss.y);
        boss.x = dest.x;
        boss.y = dest.y;
        boss.darkPhaseSubState = 'hidden';
      }
    }
  }

  // Single source of truth for GABRIEL's DARK PHASE "head" — both the
  // glowing-eye image's screen position (drawBossDarkPhase()) and the
  // FLASH head-aim hit-test (isAimedAtDarkPhaseHead()) call this, so the
  // two can never drift apart as boss.x/boss.y move through the AI above.
  // Same projection style getWeakPointScreenPos() already uses: a fixed
  // offset (here, the eye crop's own bbox center within its ORIGINAL
  // 1152x1728 source canvas) scaled by DARKPHASE_SCALE and re-centered
  // onto the boss's current on-screen position.
  function getDarkPhaseHeadScreenPos() {
    // SECTION C: DARK_PHASE_MASK_SCALE_BOOST (x1.03) is folded in here so
    // the FLASH/head-target anchor always matches the mask's actual
    // on-screen size — never baked into the source image, purely a runtime
    // multiplier on this same projection.
    const scale = (BOSS_DRAW_H * DARKPHASE_SCALE * DARK_PHASE_MASK_SCALE_BOOST) / DARKPHASE_EYES_SOURCE_H;
    return {
      x: boss.x + (DARKPHASE_HEAD_CANVAS_X - DARKPHASE_EYES_SOURCE_W / 2) * scale,
      y: boss.y + (DARKPHASE_HEAD_CANVAS_Y - DARKPHASE_EYES_SOURCE_H / 2) * scale,
    };
  }

  // FLASH's DARK PHASE aim-gate (PART 7-9): perpendicular distance from the
  // player's CURRENT effective aim ray (the same angle/origin spawnBullet()
  // itself fires along) to the head anchor above — not a fixed-distance tip
  // check like AUTO AIM's own target search, since GABRIEL's distance
  // varies continuously as it approaches/retreats. `along < 0` rejects a
  // head that's behind the player (aiming the wrong way entirely).
  function isAimedAtDarkPhaseHead() {
    // SECTION C: no target at all while fully hidden — FLASH must be
    // completely non-functional (no lock, cannot succeed) during that window.
    if (isDarkPhaseHidden()) return false;
    const head = getDarkPhaseHeadScreenPos();
    const angle = getFinalAimAngle();
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    const toHeadX = head.x - player.x, toHeadY = head.y - player.y;
    const along = toHeadX * dirX + toHeadY * dirY;
    if (along < 0) return false;
    const perpX = toHeadX - dirX * along, perpY = toHeadY - dirY * along;
    return Math.hypot(perpX, perpY) <= DARKPHASE_HEAD_HIT_RADIUS;
  }

  // PART 15-18: the ONE shared predicate for "does a FLASH thrown THIS
  // frame succeed" — used identically by flashPress() (the real success
  // check) and drawAimLine()/the reticle (the red "LOCK" visual), so the
  // two can never disagree again. Previously the red indicator was driven
  // by the ordinary AUTO AIM magnet (proximity to boss.x/boss.y, a
  // completely different point/radius than isAimedAtDarkPhaseHead()'s own
  // perpendicular-to-head-anchor test), which is exactly why "locked red"
  // and "FLASH actually lands" used to disagree so often. Also requires the
  // cooldown to already be at 0 — PART 17: never show "locked" as if a
  // press would hit when FLASH itself cannot currently be thrown at all.
  function isDarkPhaseFlashLocked() {
    return boss.state === 'darkphase' && flashCooldownRemainingMs <= 0 && isAimedAtDarkPhaseHead();
  }

  // General "is the player's raw aim ray currently pointed at GABRIEL's
  // body" check — same ray-to-point perpendicular-distance technique as
  // isAimedAtDarkPhaseHead() just above, targeting the boss's general body
  // center with its existing hurtbox radius instead of the DARK PHASE head
  // anchor. Used by canFlashTarget()/isAimingAtBoss() for COUNTER ATTACK
  // (boss.state === 'straightclaw'), where the ordinary AUTO AIM magnet is
  // deliberately inert (see getAutoAimTargetPoint()) so autoAimActive can
  // never become true there.
  function isAimedAtBossBody() {
    const angle = getFinalAimAngle();
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    const toX = boss.x - player.x, toY = boss.y - player.y;
    const along = toX * dirX + toY * dirY;
    if (along < 0) return false;
    const perpX = toX - dirX * along, perpY = toY - dirY * along;
    return Math.hypot(perpX, perpY) <= BOSS_HURT_RADIUS;
  }

  // Whether GABRIEL specifically (never a barrel, never "nothing") is the
  // current AIM target, via whichever mechanism is actually live for the
  // current boss state: the normal AUTO AIM magnet everywhere it's active,
  // or the raw-aim-ray check above for COUNTER ATTACK specifically.
  function isAimingAtBoss() {
    if (boss.state === 'straightclaw') return isAimedAtBossBody();
    return autoAimActive && autoAimTargetIsBoss;
  }

  // SECTION 9/10: the ONE shared predicate for "does a FLASH thrown THIS
  // instant actually affect GABRIEL" — used identically by flashPress()
  // (the real success check, captured once at throw time) and
  // drawAimLine()/the reticle (the red "LOCK" visual), generalizing the
  // pre-existing DARK-PHASE-only isDarkPhaseFlashLocked() pattern above to
  // EVERY boss state. Previously, outside DARK PHASE, the red indicator was
  // driven purely by the AUTO AIM magnet with no distance or cooldown
  // check at all, while flashPress() itself required distance but never
  // aim — the two could disagree in both directions. COUNTER ATTACK
  // (boss.state === 'straightclaw') is the one deliberate exception to the
  // distance requirement (SECTION 11) — aim still fully applies.
  function canFlashTarget() {
    if (!boss.spawned || flashDisabledByCinematic() || flashCooldownRemainingMs > 0) return false;
    if (boss.state === 'darkphase') return isAimedAtDarkPhaseHead();
    if (!isAimingAtBoss()) return false;
    if (boss.state !== 'straightclaw') {
      const dist = Math.hypot(boss.x - player.x, boss.y - player.y);
      if (dist < FLASH_MIN_DISTANCE) return false;
    }
    return true;
  }

  // FLASH GRENADE success: GABRIEL goes fully DOWN for FLASH_DOWN_MS — no
  // movement/attack/DEFENSE, but (unlike intro/threshold/dying/dead) still
  // fully damageable, and still a valid AUTO AIM target. Uses the SAME
  // direction-based DOWN image rule as threshold/dying (captured once, at
  // entry). Deliberately NOT added to bossIsInCinematic() — that list means
  // "untargetable", which flashdown must never be. This is also how FLASH
  // ends DARK PHASE: bossEnterState() below simply overwrites boss.state
  // from 'darkphase' to 'flashdown' unconditionally, exactly the transition
  // the DARK PHASE spec calls for (dark overlay fades out automatically —
  // see updateDarkPhaseOverlay() — since it isn't 'darkphase' anymore).
  function startBossFlashDown(now) {
    boss.downFacing = DIR_TO_BOSS_KEY[boss.dir];
    arcClawSlashes.length = 0; // no lingering attack hazards during the DOWN window
    boss.invulnerableUntil = 0; // legacy field, no longer ever set to a nonzero value — kept harmlessly in case anything else still reads it
    boss.autoAimHitStreak = 0;
    bossEnterState('flashdown', now);
  }

  function updateBossFlashDown(dt, now) {
    boss.cinematicElapsed += dt * 1000;
    if (boss.cinematicElapsed >= FLASH_DOWN_MS) {
      bossEnterState('chase', now);
    }
  }

  // Compass bucket (north/south/east/west) a bullet is travelling in,
  // reusing the same 4-way split the player's own ACTION STICK uses.
  function velocityToCompass(vx, vy) {
    return DIR_TO_BOSS_KEY[angleToBucket(Math.atan2(vy, vx))];
  }

  // Returns null when the current defense direction has no visible eye
  // (NORTH) — callers must treat that as "no weak point exists right now".
  function getWeakPointScreenPos(dir) {
    const off = WEAKPOINT_OFFSETS[dir];
    if (!off) return null;
    const scale = BOSS_DRAW_H / BOSS_CANVAS_H; // uniform scale, aspect preserved
    return {
      x: boss.x + (off.x - BOSS_CANVAS_W / 2) * scale,
      y: boss.y + (off.y - BOSS_CANVAS_H / 2) * scale,
    };
  }

  let guardBreakFlashUntil = 0;
  // A red hit-tint across the boss's whole sprite on a genuine damaging hit
  // (weak point, AUTO-AIM body-fallback, plain body hit, or barrel
  // explosion damage) — separate from the AUTO AIM reticle's own red color,
  // and drawn in drawBoss() via a source-atop tint rather than a flat color
  // fill, so it reads as "hit tint", not a solid red silhouette. PART 35/36:
  // every actual boss.hp reduction (never a mere graze/block) now blinks
  // this tint on/off BOSS_DAMAGE_BLINK_COUNT times rather than a single
  // fade, so a hit unambiguously reads as "3 flashes" — see
  // bossDamageBlinkStartAt below and its use in drawBoss(). Re-triggering
  // (another hit landing mid-blink) just restarts this one timestamp,
  // rather than queuing a second overlapping sequence.
  const BOSS_HIT_TINT_MS = 90; // within the original 50-120ms band — used as one blink half-step
  const BOSS_DAMAGE_BLINK_COUNT = 3;
  const BOSS_DAMAGE_BLINK_TOTAL_MS = BOSS_HIT_TINT_MS * BOSS_DAMAGE_BLINK_COUNT * 2; // on+off per cycle
  let bossDamageBlinkStartAt = -Infinity;

  // DEFENSE block feedback: NOT a shield — a plain (non-AUTO-AIM) body hit
  // reads as the bullet striking hard armor/claw/blade and deflecting off,
  // not being absorbed by a glowing barrier. No blue circles, no rings, no
  // rippling waves — a brief metallic spark burst plus a short ricochet
  // trail bent away from the bullet's own incoming angle, both anchored at
  // the bullet's actual impact point (never the boss's center). Purely
  // decorative: the hit is already fully resolved (0 damage) by the time
  // this spawns, so the deflected trail carries no hitbox of its own.
  const defenseRicochets = [];
  const RICOCHET_DURATION_MS = 90; // within the requested 50-120ms window
  const RICOCHET_SPARK_COUNT = 6; // within the requested 4-8 sparks

  function spawnDefenseRicochet(now, x, y, bulletVx, bulletVy) {
    const inAngle = Math.atan2(bulletVy, bulletVx);
    const sign = Math.random() < 0.5 ? -1 : 1;
    const deflectDeg = 30 + Math.random() * 40; // 30-70 degrees off the incoming line
    const deflectAngle = inAngle + sign * deflectDeg * Math.PI / 180;
    const sparks = [];
    for (let i = 0; i < RICOCHET_SPARK_COUNT; i++) {
      const a = inAngle + Math.PI + (Math.random() - 0.5) * 1.6; // scattered back toward where the bullet came from
      sparks.push({ angle: a, speed: 90 + Math.random() * 150, size: 1 + Math.random() * 1.3 });
    }
    defenseRicochets.push({ x, y, startAt: now, deflectAngle, sparks });
  }

  function drawDefenseRicochets(now) {
    for (const r of defenseRicochets) {
      const t = now - r.startAt;
      if (t >= RICOCHET_DURATION_MS) continue;
      const frac = t / RICOCHET_DURATION_MS;
      const alpha = 1 - frac;
      ctx.save();
      ctx.translate(r.x, r.y);
      // The deflected bullet trail — white/pale-yellow, short, no glow.
      const trailLen = 20 * (0.4 + frac * 0.6);
      ctx.strokeStyle = `rgba(255,248,222,${alpha * 0.9})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(r.deflectAngle) * trailLen, Math.sin(r.deflectAngle) * trailLen);
      ctx.stroke();
      // A handful of small sparks (white/pale-yellow/orange/silver).
      for (const s of r.sparks) {
        const d = s.speed * (t / 1000);
        ctx.fillStyle = `rgba(255,225,180,${alpha})`;
        ctx.beginPath();
        ctx.arc(Math.cos(s.angle) * d, Math.sin(s.angle) * d, s.size, 0, Math.PI * 2);
        ctx.fill();
      }
      // A tiny, near-instant white flash right at the impact point.
      ctx.fillStyle = `rgba(255,255,250,${Math.max(0, alpha - 0.5) * 1.4})`;
      ctx.beginPath();
      ctx.arc(0, 0, 3.2 * (1 - frac * 0.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    for (let i = defenseRicochets.length - 1; i >= 0; i--) {
      if (now - defenseRicochets[i].startAt > RICOCHET_DURATION_MS) defenseRicochets.splice(i, 1);
    }
  }

  // Shared by both damage paths below: registers one valid AUTO-AIM-assisted
  // hit landed while the boss is defending, and breaks the guard outright on
  // the DEFENSE_GUARD_BREAK_HITSth one — entering a brief stagger pause and
  // then straight into ATTACK — instead of letting DEFENSE block forever.
  function registerDefenseAimHit(now) {
    boss.defenseAimHits += 1;
    if (boss.defenseAimHits >= DEFENSE_GUARD_BREAK_HITS) {
      guardBreakFlashUntil = now + GUARD_BREAK_PAUSE_MS;
      bossEnterState('guardbreak', now); // also resets defenseAimHits back to 0
    }
  }

  // Separate from GUARD BREAK above (which only ever means something mid-
  // DEFENSE): counts ANY valid AUTO-AIM-assisted damage hit — body or weak
  // point, in ANY boss state — toward a total damage-immunity window, so a
  // player who never stops holding FIRE while AUTO AIM is engaged still
  // periodically gets shut out rather than melting the boss in one
  // uninterrupted stream. Runs independently alongside GUARD BREAK/the
  // weak-point forced counter — the same hit can legitimately count toward
  // more than one of these at once, they aren't mutually exclusive.
  function registerGlobalAutoAimHit(now) {
    boss.autoAimHitStreak += 1;
    if (boss.autoAimHitStreak >= AUTO_AIM_INVULN_HITS) {
      boss.autoAimHitStreak = 0;
      // Never (re)trigger DARK PHASE out of FLASH DOWN or an existing DARK
      // PHASE itself — FLASH DOWN is its own reward window and must run its
      // full 5s regardless of further AUTO-AIM hits landed during it; DARK
      // PHASE re-entry is simply redundant (already fully invulnerable).
      // bossIsInCinematic() (intro/threshold/dying/dead) is checked directly
      // here too, defensively — every real caller already gates on it before
      // a hit can even land, but DARK PHASE's entry condition must NEVER
      // fire once the death sequence (or any other cinematic) has begun, so
      // this doesn't rely solely on that indirect protection.
      // SECTION J (PART 5 SECTION Q/R keyed off bossEncounterIndex now):
      // ENCOUNTER 1 never sees DARK PHASE at all, organic AUTO-AIM trigger
      // included — only ENCOUNTER 2/3 do.
      if (bossEncounterIndex > 0 && boss.state !== 'flashdown' && boss.state !== 'darkphase' && !bossIsInCinematic()) {
        startBossDarkPhase(now);
        boss.darkPhaseTriggeredThisEncounter = true;
      }
    }
  }

  // A shot landing on the body/wings/claws/mask while the boss is NOT
  // already defending applies normal damage once, then instantly forces
  // DEFENSE, facing the direction the shot came FROM (i.e. the opposite of
  // the bullet's own travel direction) — PART 2/3 of the directional
  // rewrite. While already in DEFENSE, a plain (non-AUTO-AIM) body hit is
  // still fully blocked (0 damage, never reduced) but updates defenseDir to
  // face the new attack angle, so a player who flanks the boss makes it
  // turn to meet them. A body hit that WAS AUTO-AIM-assisted (the red
  // reticle was locked on, which for a direction with no weak point — e.g.
  // NORTH — is the only target DEFENSE ever offers) instead counts as a
  // genuine hit: full damage, and it counts toward GUARD BREAK.
  function applyBodyHitToBoss(now, bulletX, bulletY, bulletVx, bulletVy, autoAimed) {
    // GUARD BREAK's stagger pause is a brief (250ms), deliberately
    // untargetable beat between DEFENSE ending and ATTACK beginning — a hit
    // landing in that window must not re-trigger DEFENSE mid-transition.
    // bossIsInCinematic() also covers intro/threshold/dying/dead: the boss
    // is untargetable throughout every cinematic sequence, not just death.
    if (!boss.spawned || bossIsInCinematic() || boss.state === 'guardbreak') return;
    // DARK PHASE / STRAIGHT CLAW counter: total damage immunity — still
    // shows the same realistic ricochet/spark feedback as an ordinary
    // blocked hit, never a big blue barrier. Unlike DEFENSE (which barrel
    // explosions always bypass), these block EVEN barrel explosions — see
    // applyExplosionDamageToBoss(). DARK PHASE has no timeout of its own
    // (only FLASH GRENADE ends it); STRAIGHT CLAW's own windup->release->
    // recovery timeline (updateBossStraightClaw()) ends it. TELEPORT (PART
    // 7's own, entirely separate, total-immunity window) works the same way.
    if (boss.state === 'darkphase' || boss.state === 'teleport' || boss.state === 'straightclaw') {
      spawnDefenseRicochet(now, bulletX, bulletY, bulletVx, bulletVy);
      return;
    }
    const incomingFrom = OPPOSITE_COMPASS[velocityToCompass(bulletVx, bulletVy)];
    if (boss.state === 'defense') {
      // SECTION D: a normal player shot must NEVER reach `boss.hp -=` while
      // DEFENSE holds, autoAimed or not — every body hit here is blocked.
      // An autoAimed hit still counts toward GUARD BREAK (registerDefenseAimHit()/
      // registerGlobalAutoAimHit()) exactly as before; only the HP damage
      // itself (the actual defense-bypass bug) is removed. A non-autoAimed
      // hit still counts toward the separate STRAIGHT CLAW guard-streak,
      // exactly as before.
      boss.defenseDir = incomingFrom;
      spawnDefenseRicochet(now, bulletX, bulletY, bulletVx, bulletVy);
      if (autoAimed) {
        registerDefenseAimHit(now);
        registerGlobalAutoAimHit(now);
        return;
      }
      // STRAIGHT CLAW counter (A-2/A-3, this turn's SECTION 10/11/15/16):
      // counts CONSECUTIVE genuinely-blocked shots (0 damage) during DEFENSE
      // — a real-damage hit anywhere below resets this to 0 via
      // bossEnterState()'s own state !== 'defense' guard the instant DEFENSE
      // ends for any other reason, so the same blocks can never be reused
      // across separate DEFENSE windows (SECTION 15's own "per DEFENSE
      // session" requirement). STRAIGHT_CLAW_TRIGGER_GUARDS is now 2 (this
      // turn — was 5): the 2nd consecutive blocked shot deterministically
      // triggers the counter every time (SECTION 11 — no Math.random() gate
      // here at all). Once bossEnterState('straightclaw', ...) fires,
      // boss.state !== 'defense' immediately, so this whole branch can never
      // run again until a fresh DEFENSE starts — a 3rd/4th shot landing in
      // the same or a later frame hits the isBossDamageImmune()-style guard
      // at the top of this function instead, so at most one COUNTER ever
      // fires per DEFENSE session (SECTION 16).
      boss.consecutiveGuardedShots += 1;
      if (boss.consecutiveGuardedShots >= STRAIGHT_CLAW_TRIGGER_GUARDS) {
        // COUNTER ATTACK direction split (SECTION 2/3/4): captured ONCE,
        // right now, from the player's position relative to GABRIEL at the
        // exact instant the counter triggers — never re-evaluated later, so
        // a player who repositions during the windup doesn't change which
        // variant plays. 'down'/'up'/'left'/'right' -> DIR_TO_BOSS_KEY's own
        // south/north/west/east naming, same mapping used everywhere else.
        boss.counterDir = DIR_TO_BOSS_KEY[angleToBucket(Math.atan2(player.y - boss.y, player.x - boss.x))];
        // SECTION 13: this specific (DEFENSE-block) COUNTER is ALWAYS the
        // straight CLAW variant, deterministically — never the random
        // ARC CLAW roll the close-range proximity COUNTER below still uses.
        // South still renders via its own STING pose (isSouth override in
        // updateBossStraightClaw()) — already the same "straight line"
        // attack family, so this is still "a straight CLAW attack" there too.
        boss.counterAttackKind = 'straightClaw';
        counterFlashRemainingMs = COUNTER_FLASH_TOTAL_MS; // SECTION K: brief screen flicker on the transition into COUNTER
        bossEnterState('straightclaw', now); // takes priority over normal AI/DEFENSE's own exit timing — SECTION 12: GABRIEL is immune to all damage from this exact instant (isBossDamageImmune()/applyExplosionDamageToBoss() both already gate on boss.state==='straightclaw')
        // SECTION 14: set AFTER bossEnterState() — entering 'straightclaw'
        // itself resets this to false first (so every OTHER entry point
        // defaults correctly), so this specific trigger must override it
        // back to true right here, immediately after.
        boss.isDefenseCounter = true;
      }
      return;
    }
    boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
    // Brief hit-flash feedback (reuses the existing BOSS_DAMAGE_BLINK_*/
    // drawBossWithHitTint() machinery, already used by the DEFENSE-blocked
    // and weak-point hit paths below) — gated on actual HP damage having
    // just been applied above, not merely on a bullet touching the boss.
    bossDamageBlinkStartAt = now;
    if (checkBossHpMilestones(now)) return;
    if (autoAimed) registerGlobalAutoAimHit(now);
    // FLASH DOWN must never be interrupted into DEFENSE by an ordinary body
    // hit — it stays fully damageable for its whole duration instead. DARK
    // PHASE is the same: registerGlobalAutoAimHit() above may have JUST
    // entered it on this very hit (the 4th auto-aimed one), and without
    // this check the very next line would unconditionally stomp that back
    // into 'defense' in the same synchronous call — DARK PHASE would enter
    // and be overwritten within the same frame, before ever becoming
    // visible. This was the actual bug behind "DARK PHASE never triggers":
    // the state-machine transition fired correctly, but a later line in
    // this same function silently reverted it every time.
    if (boss.state !== 'flashdown' && boss.state !== 'darkphase') {
      boss.defenseDir = incomingFrom;
      bossEnterState('defense', now);
    }
  }

  // The weak point always takes genuine physical hits regardless of AUTO
  // AIM (a manually-aimed precision shot still works, unchanged from
  // before) — but only an AUTO-AIM-assisted weak-point hit also counts
  // toward GUARD BREAK, same rule as the body-target fallback above.
  // Pushes the player straight away from the boss by KNOCKBACK_DISTANCE
  // (no damage) and briefly suppresses movement input — used only by the
  // weak-point forced counter below, to guarantee distance actually opens
  // up rather than relying on where the subsequent attack happens to land.
  // Shared by every knockback source (weak-point forced counter, ARC CLAW
  // SLASH, ...): pushes the player along an explicit angle, clamped within
  // bounds, with a brief movement-input suppression — never any damage.
  function applyPlayerKnockbackAlongAngle(angle, distance, suppressMs, now) {
    const fromX = player.x, fromY = player.y;
    player.x = fromX + Math.cos(angle) * distance;
    player.y = fromY + Math.sin(angle) * distance;
    clampPlayerToScreen();
    let bestX = player.x, bestY = player.y;
    let bestMoved = Math.hypot(bestX - fromX, bestY - fromY);
    // If the player was already pinned near a wall/corner, clampPlayerToScreen()
    // can cancel most or all of the primary push, silently turning the
    // knockback into a no-op. Try both perpendicular directions from the
    // ORIGINAL position too and keep whichever escapes furthest, so the
    // player reliably gains real distance instead of just standing there.
    if (bestMoved < distance * 0.6) {
      for (const perp of [angle + Math.PI / 2, angle - Math.PI / 2]) {
        player.x = fromX + Math.cos(perp) * distance;
        player.y = fromY + Math.sin(perp) * distance;
        clampPlayerToScreen();
        const moved = Math.hypot(player.x - fromX, player.y - fromY);
        if (moved > bestMoved) { bestMoved = moved; bestX = player.x; bestY = player.y; }
      }
      player.x = bestX; player.y = bestY;
    }
    player.knockbackUntil = now + suppressMs;
  }
  function applyPlayerKnockback(now) {
    const dx = player.x - boss.x, dy = player.y - boss.y;
    applyPlayerKnockbackAlongAngle(Math.atan2(dy, dx), KNOCKBACK_DISTANCE, KNOCKBACK_SUPPRESS_MS, now);
  }

  // POINT-BLANK counter (PART 5): fires instead of any normal damage
  // resolution when the bullet/boss collision check finds the PLAYER
  // standing within CLOSE_RANGE_SHOT_THRESHOLD of GABRIEL — see the gate at
  // the bullet-vs-boss check in update(). Reuses the exact same knockback +
  // input-suppression primitive as the weak-point forced counter.
  function triggerCloseRangeCounter(now) {
    boss.closeRangeInvulnUntil = now + CLOSE_RANGE_COUNTER_INVULN_MS;
    applyPlayerKnockback(now);
  }

  // 5 consecutive valid weak-point hits (any aim mode) force DEFENSE open:
  // GABRIEL blacks out, vanishes, teleports to a fresh validated spot, and
  // fades back in there to resume combat (PART 7) — fully invulnerable for
  // the whole sequence (see updateBossTeleport()) — so the fight can't be
  // trivially chain-stunned by camping the weak point forever.
  function triggerWeakPointForcedCounter(now) {
    boss.weakPointConsecutiveHits = 0;
    boss.teleportElapsed = 0;
    boss.teleportDest = pickTeleportDestination();
    bossEnterState('teleport', now);
  }

  // 'blackout' (fade to black, GABRIEL still logically at the old spot but
  // never drawn) -> instantaneous reposition at the fully-black midpoint ->
  // 'fadein' (fade back to normal at the new spot) -> resume CHASE. Runs on
  // its own dt-driven elapsed counter (boss.teleportElapsed), same pattern
  // as every other cinematic-style timer in this file, so it freezes
  // correctly on PAUSE and never depends on `now - stateEnteredAt` (which
  // would jump forward by the pause's real-world length on resume).
  function updateBossTeleport(dt, now) {
    boss.teleportElapsed += dt * 1000;
    const e = boss.teleportElapsed;
    if (e < TELEPORT_BLACKOUT_MS) {
      teleportBlackoutAlpha = TELEPORT_OVERLAY_ALPHA * (e / TELEPORT_BLACKOUT_MS);
    } else if (e < TELEPORT_BLACKOUT_MS + TELEPORT_HOLD_MS) {
      teleportBlackoutAlpha = TELEPORT_OVERLAY_ALPHA;
      if (boss.teleportDest) {
        // Reposition exactly once, right as the screen reaches full black.
        boss.x = boss.teleportDest.x;
        boss.y = boss.teleportDest.y;
        boss.teleportDest = null;
      }
    } else {
      const fadeT = (e - TELEPORT_BLACKOUT_MS - TELEPORT_HOLD_MS) / TELEPORT_FADEIN_MS;
      teleportBlackoutAlpha = TELEPORT_OVERLAY_ALPHA * Math.max(0, 1 - fadeT);
    }
    if (e >= TELEPORT_TOTAL_MS) {
      teleportBlackoutAlpha = 0;
      boss.dir = angleToBucket(Math.atan2(player.y - boss.y, player.x - boss.x));
      bossEnterState('chase', now);
    }
  }

  // STRAIGHT CLAW counterattack — owns its whole windup->release->recovery
  // sequence via elapsed-time thresholds off boss.stateEnteredAt (like
  // DEFENSE/RECOVER above, not the dt-accumulated cinematicElapsed pattern
  // INTRO/THRESHOLD/DYING use — this state isn't paused/resumed across a
  // real-world PAUSE any differently than ordinary combat states already
  // are, since update() itself skips entirely while gameState.paused).
  // GABRIEL is invulnerable for this ENTIRE function's duration (see the
  // 'straightclaw' checks added to applyBodyHitToBoss()/
  // applyExplosionDamageToBoss()/getAutoAimTargetPoint()) — from the instant
  // bossEnterState('straightclaw', ...) fires (A-2) until bossEnterState
  // ('chase', ...) fires at the very end of this function (A-17).
  function updateBossStraightClaw(now) {
    const elapsed = now - boss.stateEnteredAt;
    // SECTION 3/4: boss.counterDir (captured once at trigger time — see
    // applyBodyHitToBoss()) picks which variant this instance is. South
    // keeps the original STING-style straight-line attack unchanged;
    // north/east/west instead fire a COUNTER ARC CLAW (SECTION 5's 2x-speed
    // reuse of the existing curved ARC CLAW SLASH geometry). Either way the
    // attack window's own duration also depends on the variant, since the
    // COUNTER ARC CLAW's travel time is intentionally half of STING's.
    const isSouth = boss.counterDir === 'south';
    // SECTION J: north/east/west now use whichever sub-variant was rolled
    // at trigger time (boss.counterAttackKind) — south always keeps its own
    // STING regardless of that field.
    const usesStraightClaw = isSouth || boss.counterAttackKind === 'straightClaw';
    const attackWindowMs = usesStraightClaw ? STRAIGHT_CLAW_ATTACK_MS : COUNTER_ARC_CLAW_LIFETIME_MS;
    // A-7/A-9: windup shows straight_claw_windup.png with zero damage/hit/
    // knockback for STRAIGHT_CLAW_WINDUP_MS; the player may move freely.
    // Exactly once, at the windup->release instant, lock the attack's
    // direction from GABRIEL's CURRENT belief of the player's position
    // (getBossTargetPos() — same STEALTH-aware helper CLAW STING already
    // uses) and fire the actual hit; A-11: never re-read afterward, so the
    // attack does not track the player post-release.
    if (elapsed >= STRAIGHT_CLAW_WINDUP_MS && !boss.straightClawHitSpawned) {
      boss.straightClawHitSpawned = true;
      if (isSouth) {
        spawnStraightClaw(now, { x: boss.x, y: boss.y }, getBossTargetPos(now));
      } else if (usesStraightClaw) {
        // J-3: north/east/west's own STRAIGHT CLAW originates from
        // GABRIEL's per-direction claw joint (getClawOrigin() — the SAME
        // origin point normal ARC CLAW SLASH attacks already use), not the
        // raw body center STING uses for its front-facing pose.
        spawnStraightClaw(now, getClawOrigin(), getBossTargetPos(now));
      } else {
        spawnCounterArcClaw(now, getClawOrigin(), getBossTargetPos(now));
      }
    }
    // A-16: windup -> release/attack -> recovery -> normal AI. Recovery has
    // no visual/behavioral difference from the release/attack window here
    // beyond the attack's own hitbox naturally expiring after
    // attackWindowMs (see updateArcClawSlashes()); this function simply
    // keeps GABRIEL in the same invulnerable state for the extra
    // STRAIGHT_CLAW_RECOVERY_MS before finally returning to CHASE.
    if (elapsed >= STRAIGHT_CLAW_WINDUP_MS + attackWindowMs + STRAIGHT_CLAW_RECOVERY_MS) {
      boss.chaseBackoffUntil = now + 300;
      bossEnterState('chase', now);
    }
  }

  function applyWeakPointHitToBoss(now, autoAimed, bulletX, bulletY, bulletVx, bulletVy) {
    if (!boss.spawned || boss.state !== 'defense') return;
    if (now < boss.invulnerableUntil) {
      // Legacy guard — boss.invulnerableUntil is never set to a nonzero
      // value anymore (4-hit AUTO AIM now triggers DARK PHASE instead, and
      // this function already can't run during DARK PHASE at all since the
      // guard above requires boss.state === 'defense'); left in place
      // harmlessly rather than risk touching more than necessary.
      const wp = getWeakPointScreenPos(boss.defenseDir);
      spawnDefenseRicochet(now, wp ? wp.x : bulletX, wp ? wp.y : bulletY, bulletVx, bulletVy);
      return;
    }
    boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
    bossDamageBlinkStartAt = now;
    if (checkBossHpMilestones(now)) return; // death or a threshold cinematic took over
    if (autoAimed) registerGlobalAutoAimHit(now);
    // DARK PHASE may have JUST been entered by the call above (this exact
    // hit could simultaneously be the 4th auto-aimed hit overall AND
    // partway through an independent weak-point-consecutive-hit streak) —
    // if so, stop here: neither the forced-counter's enterAttackSequence()
    // nor GUARD BREAK below may overwrite it in the same synchronous call.
    if (boss.state === 'darkphase') return;

    boss.weakPointConsecutiveHits += 1;
    if (boss.weakPointConsecutiveHits >= WEAKPOINT_FORCED_COUNTER_HITS) {
      triggerWeakPointForcedCounter(now); // this hit is "spent" here — never also registers toward GUARD BREAK
      return;
    }
    if (autoAimed) registerDefenseAimHit(now);
  }

  // STEALTH (PART 16-19): the SINGLE point every piece of GABRIEL AI reads
  // "where is the player" from. Outside STEALTH this is always the live
  // position (zero behavior change to anything that existed before this
  // batch). While STEALTH is active, it's whichever the player has last
  // revealed by firing (boss.revealedShotX/Y), or — if they haven't fired
  // at all yet this STEALTH window — the position captured at the moment
  // STEALTH began (boss.lastKnownPlayerX/Y). Never re-reads live
  // player.x/y while active, and never itself touches boss.state.
  function getBossTargetPos(now) {
    if (now < player.stealthUntil) {
      if (boss.revealedShotX !== null) return { x: boss.revealedShotX, y: boss.revealedShotY };
      return { x: boss.lastKnownPlayerX, y: boss.lastKnownPlayerY };
    }
    return { x: player.x, y: player.y };
  }

  function updateBoss(dt, now) {
    // DARK OUT PART 3: BOSS BATTLE MODE's GABRIEL fight reuses this EXACT
    // function (no copy) — widened from 'boss'-only so its own spawnBoss()
    // call (see startBossBattle()) actually gets an AI. TRAINING/SECURITY
    // TRAINING never spawn a boss and are unaffected by this widening.
    if (gameState.mode !== 'boss' && gameState.mode !== 'bossBattle') return;
    // PART 5 SECTION T: GABRIEL is now always spawned explicitly, the
    // instant a boss-type STORY_STAGE_PLAN entry is entered (see
    // enterStoryStage()) — there is no longer a delay-timer auto-spawn (the
    // old BOSS_SPAWN_DELAY_MS mechanism), since STAGE 0 is now always a
    // DRONE-type STAGE under the fixed plan and would otherwise spawn
    // GABRIEL into a supposedly boss-free STAGE once the old timer elapsed.
    if (!boss.spawned) return;
    if (boss.state === 'dead') return;
    // Cinematic sequences each own their own progression/timing entirely —
    // see updateBossIntro/Threshold/Dying() — and never fall through to the
    // normal CHASE/ATTACK/DEFENSE/RECOVER AI below.
    if (boss.state === 'intro') { updateBossIntro(dt, now); return; }
    if (boss.state === 'threshold') { updateBossThreshold(dt, now); return; }
    if (boss.state === 'dying') { updateBossDying(dt, now); return; }
    if (boss.state === 'flashdown') { updateBossFlashDown(dt, now); return; }
    if (boss.state === 'darkphase') { updateBossDarkPhase(dt, now); return; }
    if (boss.state === 'teleport') { updateBossTeleport(dt, now); return; }
    if (boss.state === 'straightclaw') { updateBossStraightClaw(now); return; }
    if (window.__game.freezeBossAI) return; // debug/verification only

    // SECTION I: close-range COUNTER — reuses the EXISTING 'straightclaw'
    // COUNTER attack sequence wholesale (same as the DEFENSE-guard-break
    // trigger just below applyBodyHitToBoss()'s own STRAIGHT_CLAW_TRIGGER_GUARDS
    // check), just with a different trigger condition: mere proximity
    // (player standing within a genuine CLAW's own reach — see
    // BOSS_CLOSE_COUNTER_DISTANCE's derivation above), not a shot count.
    // Only preempts the three "normal" combat states — chase/attack/
    // defense — never guardbreak/any cinematic/darkphase/teleport (all
    // already returned above), so this can never re-trigger every frame
    // while already in 'straightclaw' (that state's own early-return above
    // stops this code from running at all until the counter resolves).
    if ((boss.state === 'chase' || boss.state === 'attack' || boss.state === 'defense') &&
        Math.hypot(player.x - boss.x, player.y - boss.y) <= BOSS_CLOSE_COUNTER_DISTANCE) {
      boss.counterDir = DIR_TO_BOSS_KEY[angleToBucket(Math.atan2(player.y - boss.y, player.x - boss.x))];
      boss.counterAttackKind = (boss.counterDir !== 'south' && Math.random() < COUNTER_STRAIGHT_CLAW_PROB)
        ? 'straightClaw' : 'arcClaw';
      counterFlashRemainingMs = COUNTER_FLASH_TOTAL_MS;
      bossEnterState('straightclaw', now);
      return;
    }

    // SECTION J: DARK PHASE guarantee for ENCOUNTER 2/3 — if it hasn't
    // fired organically by the time HP crosses the halfway mark, force it
    // right here rather than leaving it purely up to whether the player
    // happens to land 4 AUTO-AIM hits.
    if (bossEncounterIndex > 0 && !boss.darkPhaseTriggeredThisEncounter &&
        boss.hp <= BOSS_HP_MAX * DARK_PHASE_GUARANTEE_HP_FRAC &&
        (boss.state === 'chase' || boss.state === 'attack' || boss.state === 'defense')) {
      boss.darkPhaseTriggeredThisEncounter = true;
      startBossDarkPhase(now);
      return;
    }

    // STEALTH (PART 16): CHASE's own distance/direction/facing all derive
    // from GABRIEL's current BELIEF about the player's position, not
    // necessarily their live one — see getBossTargetPos().
    const targetPos = getBossTargetPos(now);
    const dx = targetPos.x - boss.x;
    const dy = targetPos.y - boss.y;
    const dist = Math.hypot(dx, dy) || 1;
    const toPlayerX = dx / dist, toPlayerY = dy / dist;

    let vx = 0, vy = 0;
    boss.moving = false;

    if (boss.state === 'chase') {
      if (dist <= BOSS_ATTACK_RANGE) {
        // Lock facing toward the player at the instant ATTACK begins; the
        // attack image itself is never rotated, only this bucket direction
        // is used (for the forward claw-hitbox offset and the projectile's
        // spawn-side offset).
        boss.dir = angleToBucket(Math.atan2(dy, dx));
        enterAttackSequence(now);
      } else {
        let dirX = toPlayerX, dirY = toPlayerY;
        if (now < boss.chaseBackoffUntil) {
          // Brief separation after an attack before closing in again.
          dirX = -toPlayerX; dirY = -toPlayerY;
        } else {
          // Slight weave instead of a perfectly straight approach.
          const weave = Math.sin(now / 500) * 0.35;
          const perpX = -toPlayerY, perpY = toPlayerX;
          dirX = toPlayerX + perpX * weave;
          dirY = toPlayerY + perpY * weave;
          const len = Math.hypot(dirX, dirY) || 1;
          dirX /= len; dirY /= len;
        }
        // SECTION N: scaled by the current ENCOUNTER's own movement
        // multiplier (1.00/1.10/1.20 for encounter 1/2/3) — never mutates
        // the base BOSS_CHASE_SPEED constant itself.
        const chaseSpeed = BOSS_CHASE_SPEED * getBossDifficultyMultiplier(bossEncounterIndex).movement;
        vx = dirX * chaseSpeed;
        vy = dirY * chaseSpeed;
        boss.x += vx * dt;
        boss.y += vy * dt;
        boss.moving = true;
      }
    } else if (boss.state === 'preattack') {
      // SOUTH/EAST/WEST telegraph before ATTACK's blade release — NORTH
      // never enters this state (enterAttackSequence() skips straight to
      // 'attack' for it, using its own self-contained windup below,
      // unchanged from before this round).
      if (now - boss.stateEnteredAt >= PRE_ATTACK_MS) {
        boss.attackFiresImmediately = true;
        bossEnterState('attack', now);
      }
    } else if (boss.state === 'attack') {
      const elapsed = now - boss.stateEnteredAt;
      // Arriving via PRE_ATTACK (or the weak-point forced counter) already
      // spent its telegraph time in that state, so ATTACK fires the blade
      // right away; NORTH and GUARD BREAK's attack entry (unchanged from
      // before) still do their own self-contained windup here.
      const fireAt = boss.attackFiresImmediately ? 0 : BOSS_ATTACK_WINDUP_MS;
      const isArcClaw = boss.attackType === 'arcClaw';
      const isClawSting = boss.attackType === 'clawSting';
      // ARC CLAW SLASH and CLAW STING are both wholly separate attacks
      // (their own hitbox/damage/knockback, handled entirely inside
      // updateArcClawSlashes()) — either replaces the melee swing for this
      // cycle, never runs alongside it, and needs its own active window to
      // cover its full motion.
      const activeMs = isArcClaw ? ARC_CLAW_LIFETIME_MS : (isClawSting ? CLAW_STING_LIFETIME_MS : BOSS_ATTACK_ACTIVE_MS);
      if (elapsed >= fireAt) {
        if (!boss.attackProjectileSpawned) {
          boss.attackProjectileSpawned = true;
          if (isArcClaw) spawnArcClawSlash(now);
          else if (isClawSting) spawnClawSting(now, getClawOrigin(), getBossTargetPos(now)); // STEALTH (PART 19): locks onto GABRIEL's current belief, not necessarily the live position
          // else: plain melee — no projectile/VFX object to spawn, the
          // swing hitbox check right below is the entire attack.
        }
        if (!isArcClaw && !isClawSting && elapsed < fireAt + activeMs && !boss.attackHitApplied) {
          const facing = BASE_ANGLE[boss.dir];
          const hx = boss.x + Math.cos(facing) * BOSS_ATTACK_REACH;
          const hy = boss.y + Math.sin(facing) * BOSS_ATTACK_REACH;
          const hd = Math.hypot(player.x - hx, player.y - hy);
          if (!isPlayerInvulnerable() && hd <= BOSS_ATTACK_HIT_RADIUS + PLAYER_HIT_RADIUS) {
            boss.attackHitApplied = true;
            window.__game.playerHitCount++;
            applyDamageToPlayerLife(now, BULLET_DAMAGE); // SECTION E: no existing damage number for the plain melee swing — BULLET_DAMAGE is the codebase's one other real "per-hit" constant, reused rather than inventing a new one
            const pushLen = 18;
            player.x += Math.cos(facing) * pushLen;
            player.y += Math.sin(facing) * pushLen;
            clampPlayerToScreen();
          }
        }
      }
      if (elapsed >= fireAt + activeMs) {
        boss.chaseBackoffUntil = now + 300;
        bossEnterState('recover', now);
      }
    } else if (boss.state === 'defense') {
      if (now - boss.stateEnteredAt >= BOSS_DEFENSE_MS) {
        bossEnterState('recover', now);
      }
    } else if (boss.state === 'guardbreak') {
      // Brief stagger after the 4th AUTO-AIM-assisted DEFENSE hit, then
      // straight into ATTACK (facing the player at that instant) rather
      // than back to CHASE — the guard was broken, not just timed out.
      // Unchanged from before this round: no PRE_ATTACK telegraph here,
      // regardless of direction — GUARD BREAK's counter should feel
      // immediate/punishing, not telegraphed.
      if (now - boss.stateEnteredAt >= GUARD_BREAK_PAUSE_MS) {
        boss.dir = angleToBucket(Math.atan2(player.y - boss.y, player.x - boss.x));
        boss.attackFiresImmediately = false;
        boss.attackType = 'blade'; // GUARD BREAK's punish is always the familiar attack, never ARC CLAW SLASH
        boss.lastAttackType = 'blade';
        bossEnterState('attack', now);
      }
    } else if (boss.state === 'recover') {
      // SECTION N: higher attackFrequency means a SHORTER recovery (divide,
      // never multiply) — 1.15x frequency == cooldown / 1.15, exactly as
      // specified, so difficulty scaling never accidentally slows attacks
      // down.
      const recoverMs = BOSS_RECOVER_MS / getBossDifficultyMultiplier(bossEncounterIndex).attackFrequency;
      if (now - boss.stateEnteredAt >= recoverMs) {
        bossEnterState('chase', now);
      }
    }

    // Facing: derived from actual movement, same 4-direction bucket the
    // player's ACTION STICK uses; held steady while stopped/attacking so
    // the boss keeps facing the direction it last moved/attacked in.
    if (boss.moving && (vx !== 0 || vy !== 0)) {
      boss.dir = angleToBucket(Math.atan2(vy, vx));
    }

    // SECTION A (rework): clamp against the FULL combined AREA1+AREA2 band
    // (areaTopY(2)..areaTopY(1)+H, i.e. -H..H) — the boss is the same
    // persistent entity across the whole continuous 2-screen-tall stage,
    // so its own valid range must never depend on `currentArea` (which
    // only tracks the PLAYER's live position). The old code clamped
    // relative to `areaTopY(currentArea)`, so the instant the player alone
    // crossed the AREA1/AREA2 seam, the boss's own clamp bounds jumped by a
    // full screen height and could snap it to a completely different
    // absolute position it was never actually near.
    boss.x = Math.max(BOSS_DRAW_W * 0.3, Math.min(W - BOSS_DRAW_W * 0.3, boss.x));
    boss.y = Math.max(-H + BOSS_DRAW_H * 0.3, Math.min(H - BOSS_DRAW_H * 0.3, boss.y));
  }

  // BOSS MODE start (PART 1-8): initial violent shake -> silence -> shadow
  // silhouette reveal -> INSTANT landing (+ landing shake) -> pause -> south
  // idle -> south attack telegraph -> battle begins. boss.y never moves
  // during any of this (see spawnBoss()) — only the drawn appearance
  // changes phase to phase; boss.cinematicElapsed is cached here (not
  // recomputed in draw()) so a PAUSE mid-sequence freezes it for free and
  // RESUME continues from exactly the same point.
  function updateBossIntro(dt, now) {
    boss.cinematicElapsed += dt * 1000;
    const elapsed = boss.cinematicElapsed;
    if (elapsed >= BOSS_INTRO_SHADOW_END && !boss.introLandingTriggered) {
      boss.introLandingTriggered = true;
      triggerScreenShake(now, BOSS_INTRO_LANDING_SHAKE_MAG, BOSS_INTRO_LANDING_SHAKE_MS);
      landingRedFlashRemainingMs = BOSS_LANDING_RED_FLASH_TOTAL_MS; // SECTION S: same instant the DOWN sprite reaches the ground
    }
    if (elapsed >= INTRO_TOTAL_MS) {
      // PART 3 SECTION A: the ~9s BOSS INTRO cinematic locks out player
      // input entirely (see isBossIntroLocked()), but the CONTROL RECOVERY
      // WATCHDOG's own idle clock (lastPlayerInputAt) was never advanced
      // during that time — it was last set whenever resetModeState() (or
      // the player's last real action) happened to run, well before the
      // intro even started. Since the watchdog is gated on
      // !bossIsInCinematic(), the very first post-intro tick immediately
      // reads an idle gap far past CONTROL_WATCHDOG_IDLE_MS and fires an
      // instant, unearned STUN the moment BATTLE START begins. Resetting
      // here — at the exact instant the intro ends for EVERY encounter —
      // guarantees a full, fresh CONTROL_WATCHDOG_IDLE_MS grace window
      // starting from BATTLE START itself (A-1/A-2/A-3).
      lastPlayerInputAt = now;
      bossEnterState('chase', now); // PART 7: battle begins the instant the south attack telegraph finishes
    }
  }

  // Brief HP-milestone reaction (30/60/90% cumulative damage) — boss AI is
  // paused and untargetable (see bossIsInCinematic()) for THRESHOLD_CINEMATIC_MS,
  // then resumes into CHASE regardless of what it was doing beforehand.
  function updateBossThreshold(dt, now) {
    boss.cinematicElapsed += dt * 1000;
    if (boss.cinematicElapsed >= THRESHOLD_CINEMATIC_MS) {
      bossEnterState('chase', now);
    }
  }

  // Death: hold on the cinematic pose while it particle-dissolves (see
  // buildDyingParticles()/drawBossDying()), then flip to the true terminal
  // 'dead' state once the dissolve finishes — 'dead' itself draws nothing
  // at all, since the dissolve already completed the visual disappearance.
  function updateBossDying(dt, now) {
    boss.cinematicElapsed += dt * 1000;
    if (boss.cinematicElapsed >= DYING_DURATION_MS) {
      boss.state = 'dead';
      boss.deadAt = now;
      // SECTION L-2/O/P (PART 5 SECTION U-4: now keyed off the STORY_STAGE_
      // PLAN entry's own `final` flag, never a raw stage-position/STAGES.
      // length comparison): the FINAL GABRIEL ENCOUNTER triggers GAME CLEAR
      // directly, right as the existing defeat effect finishes — no EXIT
      // walk for the final encounter (nothing left to walk toward).
      // ENCOUNTER 1/2 are unaffected: they still use the pre-existing
      // EXIT-walk -> beginStageTransition() flow untouched.
      if (isFinalStoryStage()) {
        triggerGameClear(now);
      }
    }
  }

  // ---------- ARC CLAW SLASH / CLAW STING (both share one array/shape) ----------
  // The 3WAY BLADE ranged volley that used to live here has been fully
  // removed (PART 9) — GABRIEL's normal-combat attack set is now the
  // existing melee swing (see the 'attack' state branch in updateBoss()) +
  // ARC CLAW SLASH + CLAW STING + DEFENSE; DARK PHASE uses SLASH/STING only.
  // Each entry carries a `kind: 'slash' | 'sting'` — SLASH sweeps through a
  // quadratic-Bezier arc with its sprite rotation locked to the arc's live
  // tangent; STING travels in a straight line toward a target locked once
  // at spawn time (see spawnClawSting()) and never re-aims afterward.
  const arcClawSlashes = [];

  function quadBezierPoint(p0, p1, p2, t) {
    const mt = 1 - t;
    return {
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    };
  }
  function quadBezierTangentAngle(p0, p1, p2, t) {
    const dx = 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x);
    const dy = 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y);
    return Math.atan2(dy, dx);
  }
  // Slow -> fast -> slow: peak instantaneous speed lands at t=0.5, which is
  // where the control points below place the player — "accelerate, hit top
  // speed passing the player, then follow through" per spec, without a
  // flat/constant-speed glide at any point.
  function arcClawEase(u) {
    return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
  }

  // Builds the P0/P1/P2 control points and CW/CCW choice for one slash.
  // P0 = claw origin, P1 = an outward-bulged midpoint (so the path is a
  // real arc, not a straight line with a rotating sprite on top), P2 = a
  // point past the player along the swing's finishing angle. Two full
  // candidate geometries (clockwise and counter-clockwise) are built and
  // whichever stays closer to the current playable bounds is kept, so the
  // random CW/CCW pick can't occasionally sweep the attack somewhere the
  // player has no room to dodge.
  function pickArcClawGeometry(origin, target) {
    const dist = Math.hypot(target.x - origin.x, target.y - origin.y) || 1;
    const baseAngle = Math.atan2(target.y - origin.y, target.x - origin.x);
    const devStart = ARC_CLAW_DEV_START_MIN + Math.random() * (ARC_CLAW_DEV_START_MAX - ARC_CLAW_DEV_START_MIN);
    const devEnd = ARC_CLAW_DEV_END_MIN + Math.random() * (ARC_CLAW_DEV_END_MAX - ARC_CLAW_DEV_END_MIN);

    function buildFor(clockwise) {
      const sign = clockwise ? 1 : -1;
      const endAngle = baseAngle + sign * devEnd;
      const midAngle = baseAngle + sign * ((devEnd - devStart) / 2);
      return {
        p0: origin,
        p1: { x: origin.x + Math.cos(midAngle) * dist * 1.3, y: origin.y + Math.sin(midAngle) * dist * 1.3 },
        p2: { x: origin.x + Math.cos(endAngle) * dist * 1.2, y: origin.y + Math.sin(endAngle) * dist * 1.2 },
        mirrored: !clockwise, // the source art only has one hand — mirror it for the opposite swing direction
      };
    }
    function outOfBoundsPenalty(g) {
      const margin = 40;
      let penalty = 0;
      for (const pt of [g.p1, g.p2]) {
        if (pt.x < -margin) penalty += -margin - pt.x;
        if (pt.x > W + margin) penalty += pt.x - (W + margin);
        if (pt.y < cameraY - margin) penalty += cameraY - margin - pt.y;
        if (pt.y > cameraY + H + margin) penalty += pt.y - (cameraY + H + margin);
      }
      return penalty;
    }
    const cw = buildFor(true), ccw = buildFor(false);
    const cwPenalty = outOfBoundsPenalty(cw), ccwPenalty = outOfBoundsPenalty(ccw);
    if (Math.abs(cwPenalty - ccwPenalty) < 1) return Math.random() < 0.5 ? cw : ccw;
    return cwPenalty < ccwPenalty ? cw : ccw;
  }

  function spawnArcClawSlash(now) {
    const origin = getClawOrigin();
    // STEALTH (PART 19): aims at GABRIEL's current belief, not necessarily
    // the player's live position — see getBossTargetPos().
    const geo = pickArcClawGeometry(origin, getBossTargetPos(now));
    arcClawSlashes.push({
      kind: 'slash',
      p0: geo.p0, p1: geo.p1, p2: geo.p2, mirrored: geo.mirrored,
      startedAt: now, hasHit: false,
      x: geo.p0.x, y: geo.p0.y, angle: 0, tangentAngle: 0, trail: [],
    });
  }

  // CLAW STING (PART 8/10): `target` is the point to lock onto — captured
  // by the CALLER at the exact moment the attack fires (the player's
  // current position for normal combat, GABRIEL's own lunge-end position
  // for DARK PHASE), never read again afterward. Travels in a dead-straight
  // line from `origin` to a point CLAW_STING_OVERSHOOT past that locked
  // target, so it reads as a real thrust-through rather than stopping
  // exactly on the spot — the sprite's rotation is fixed for the whole
  // flight (a straight stab never re-aims), unlike SLASH's continuously
  // recomputed tangent.
  function spawnClawSting(now, origin, target) {
    const dist = Math.hypot(target.x - origin.x, target.y - origin.y) || 1;
    const angle = Math.atan2(target.y - origin.y, target.x - origin.x);
    const endX = origin.x + Math.cos(angle) * dist * CLAW_STING_OVERSHOOT;
    const endY = origin.y + Math.sin(angle) * dist * CLAW_STING_OVERSHOOT;
    const mirrored = Math.cos(angle) < 0;
    const baseTip = mirrored ? ARC_CLAW_BASE_TIP_ANGLE_FLIPPED : ARC_CLAW_BASE_TIP_ANGLE;
    arcClawSlashes.push({
      kind: 'sting',
      p0: origin, p2: { x: endX, y: endY }, mirrored,
      startedAt: now, hasHit: false,
      x: origin.x, y: origin.y, angle: angle - baseTip, tangentAngle: angle, trail: [],
    });
  }

  // STRAIGHT CLAW counterattack (A-9/A-10/A-11/A-12): a THIRD kind sharing
  // this same array/update/hit-test machinery, reusing STING's dead-straight
  // fixed-rotation motion (never ARC CLAW SLASH's curved bezier) but with
  // its own timing/hitbox/knockback constants. `target` is captured ONCE by
  // the caller (updateBossStraightClaw(), at the exact windup->release
  // instant) and never re-read afterward, so the player can freely move
  // during the 2s windup but the attack never re-aims once released.
  function spawnStraightClaw(now, origin, target) {
    const dist = Math.hypot(target.x - origin.x, target.y - origin.y) || 1;
    const angle = Math.atan2(target.y - origin.y, target.x - origin.x);
    const endX = origin.x + Math.cos(angle) * dist * STRAIGHT_CLAW_OVERSHOOT;
    const endY = origin.y + Math.sin(angle) * dist * STRAIGHT_CLAW_OVERSHOOT;
    // PART8 SECTION X/Y: mirrored/angle computed the SAME way spawnClawSting()
    // does (previously unused here since this kind was never drawn as a claw
    // image at all) — needed now that the DEFENSE-counter's own instance
    // draws a real, correctly-rotated claw sprite pointing along its locked
    // travel direction (see drawArcClawSlash()).
    const mirrored = Math.cos(angle) < 0;
    const baseTip = mirrored ? ARC_CLAW_BASE_TIP_ANGLE_FLIPPED : ARC_CLAW_BASE_TIP_ANGLE;
    arcClawSlashes.push({
      kind: 'straightClaw',
      p0: origin, p2: { x: endX, y: endY }, mirrored,
      startedAt: now, hasHit: false,
      x: origin.x, y: origin.y, angle: angle - baseTip, tangentAngle: angle, trail: [],
      // New-turn SECTION 14: only the DEFENSE-2-blocked-shots forced COUNTER
      // (boss.isDefenseCounter, set right at its own trigger site) ignores
      // the player's DASH invulnerability — this same function is ALSO used
      // by the close-range proximity COUNTER, which must keep respecting it,
      // so the flag is read from boss.isDefenseCounter fresh at spawn time
      // rather than being hardcoded true here.
      piercesDashInvulnerability: boss.isDefenseCounter,
      // PART8 SECTION T/Z: same read-fresh pattern — only the DEFENSE-
      // counter's own instance travels at 2x speed.
      speedMult: boss.isDefenseCounter ? COUNTER_CLAW_SPEED_MULTIPLIER : 1,
    });
  }

  // COUNTER ARC CLAW (SECTION 4/5): the north/east/west COUNTER ATTACK
  // variant. Reuses ARC CLAW SLASH's own curved-bezier geometry/hitbox/
  // knockback wholesale (pickArcClawGeometry() — the exact same function a
  // normal ARC CLAW SLASH attack calls) so it's visually and mechanically
  // the SAME attack, just travelling at COUNTER_ARC_CLAW_LIFETIME_MS (half
  // of ARC_CLAW_LIFETIME_MS) instead — see the 'counterArc' kind's lifetime
  // selection in updateArcClawSlashes(), the only place its speed differs
  // from a normal 'slash'. Never used for boss.counterDir === 'south' (that
  // direction keeps the existing STING-style spawnStraightClaw() above).
  function spawnCounterArcClaw(now, origin, target) {
    const geo = pickArcClawGeometry(origin, target);
    arcClawSlashes.push({
      kind: 'counterArc',
      p0: geo.p0, p1: geo.p1, p2: geo.p2, mirrored: geo.mirrored,
      startedAt: now, hasHit: false,
      x: geo.p0.x, y: geo.p0.y, angle: 0, tangentAngle: 0, trail: [],
    });
  }

  function updateArcClawSlashes(now) {
    for (let i = arcClawSlashes.length - 1; i >= 0; i--) {
      const s = arcClawSlashes[i];
      const isSting = s.kind === 'sting';
      const isStraightClaw = s.kind === 'straightClaw';
      const isCounterArc = s.kind === 'counterArc'; // COUNTER ATTACK's north/east/west variant — SAME curved-bezier motion as 'slash', just faster (see lifetimeMs below)
      const isStraightLine = isSting || isStraightClaw;
      // PART8 SECTION T/Z: straightClaw's own lifetime is divided by its
      // speedMult (2.0 for the DEFENSE-counter's instance, 1 for every
      // other straightClaw use) — same total travel distance in half the
      // time, i.e. 2x average speed, without inventing a separate velocity
      // system in what is otherwise a purely time-based interpolation.
      const lifetimeMs = isSting ? CLAW_STING_LIFETIME_MS : (isStraightClaw ? STRAIGHT_CLAW_ATTACK_MS / (s.speedMult || 1) : (isCounterArc ? COUNTER_ARC_CLAW_LIFETIME_MS : ARC_CLAW_LIFETIME_MS));
      const u = (now - s.startedAt) / lifetimeMs;
      if (u >= 1) { arcClawSlashes.splice(i, 1); continue; }
      const t = arcClawEase(Math.max(0, u));
      // SLASH sweeps a quadratic-Bezier arc with a continuously recomputed
      // tangent; STING/STRAIGHT CLAW both travel a dead-straight line at the
      // angle locked at spawn time (s.tangentAngle never changes afterward —
      // see spawnClawSting()/spawnStraightClaw()), so neither ever re-aims
      // mid-flight.
      const pos = isStraightLine
        ? { x: s.p0.x + (s.p2.x - s.p0.x) * t, y: s.p0.y + (s.p2.y - s.p0.y) * t }
        : quadBezierPoint(s.p0, s.p1, s.p2, t);
      const tangentAngle = isStraightLine ? s.tangentAngle : quadBezierTangentAngle(s.p0, s.p1, s.p2, t);
      // PART8 SECTION T/V/AB: an Area-boundary WALL between last frame's
      // position and this one vanishes the attack outright — applies to
      // EVERY CLAW kind here (SECTION T's general "GABRIELのCLAWも...壁を
      // 貫通してはいけない"), including the DEFENSE-counter's own instance,
      // which pierces ONLY the player's DASH invulnerability
      // (piercesDashInvulnerability) and never Area walls (SECTION AB —
      // the two are explicitly independent).
      if (segmentCrossesAreaWall(s.x, s.y, pos.x, pos.y)) {
        arcClawSlashes.splice(i, 1);
        continue;
      }

      // Each stored sample keeps its OWN position/rotation from when it was
      // the live frame — angle for the claw image's draw rotation, and the
      // raw tangentAngle too (the auxiliary crescent trail aligns to the
      // pure travel direction, not the image's own tip-offset rotation).
      s.trail.push({ x: s.x, y: s.y, angle: s.angle, tangentAngle: s.tangentAngle });
      if (s.trail.length > ARC_CLAW_TRAIL_LEN) s.trail.shift();

      s.x = pos.x; s.y = pos.y; s.tangentAngle = tangentAngle;
      if (!isStraightLine) {
        // Re-align the claw image's own tip<->base axis to the live tangent
        // direction, so it visibly points where it's travelling rather than
        // just spinning around its own center. STING/STRAIGHT CLAW's s.angle
        // was already fixed once at spawn time and stays that way for its
        // whole flight (and isn't drawn as a separate claw image at all for
        // STRAIGHT CLAW — see drawArcClawSlash()).
        const baseTip = s.mirrored ? ARC_CLAW_BASE_TIP_ANGLE_FLIPPED : ARC_CLAW_BASE_TIP_ANGLE;
        s.angle = tangentAngle - baseTip;
      }

      // New-turn SECTION 14: the DEFENSE-block forced COUNTER's own
      // straightClaw projectile (s.piercesDashInvulnerability, set only at
      // its own spawnStraightClaw() call) is the ONE exception that still
      // lands even while the player is DASHing — every other attack here
      // (plain STING/ARC CLAW/COUNTER ARC, and even the close-range
      // proximity COUNTER's own straightClaw) keeps respecting
      // isPlayerInvulnerable() exactly as before. DASH itself is completely
      // untouched — the player can still DASH freely, it simply doesn't grant
      // its usual invulnerability against this one specific attack.
      if (!s.hasHit && (!isPlayerInvulnerable() || s.piercesDashInvulnerability)) {
        // Oriented rectangle aligned to the live travel direction (never a
        // plain circle, and never ARC CLAW SLASH's curved hitbox — A-12) —
        // local +X is "ahead of the tip", local -X runs back along the
        // trailing claw body.
        const relX = player.x - s.x, relY = player.y - s.y;
        const c = Math.cos(-tangentAngle), sn = Math.sin(-tangentAngle);
        const localX = relX * c - relY * sn;
        const localY = relX * sn + relY * c;
        const halfLenFwd = isStraightClaw ? STRAIGHT_CLAW_HIT_HALF_LEN_FWD : ARC_CLAW_HIT_HALF_LEN_FWD;
        const halfLenBack = isStraightClaw ? STRAIGHT_CLAW_HIT_HALF_LEN_BACK : ARC_CLAW_HIT_HALF_LEN_BACK;
        const halfWidth = isStraightClaw ? STRAIGHT_CLAW_HIT_HALF_WIDTH : ARC_CLAW_HIT_HALF_WIDTH;
        if (localX >= -halfLenBack && localX <= halfLenFwd &&
            Math.abs(localY) <= halfWidth + PLAYER_HIT_RADIUS) {
          s.hasHit = true; // at most one damage instance per slash, ever
          window.__game.playerHitCount++;
          // SECTION 6/7/E: this is the ONLY place either COUNTER variant ever
          // "damages" the player — purely a genuine hitbox-overlap check
          // above (never an automatic hit on COUNTER start/trigger).
          // COUNTER hits reuse the existing COUNTER_ATTACK_DAMAGE value;
          // every other claw-family hit (plain ARC CLAW SLASH/STING, DARK
          // PHASE's reused claws) has no existing damage number of its own,
          // so BULLET_DAMAGE — the same reused fallback as the plain melee
          // swing above — applies instead. Either way this now actually
          // reduces LIFE (at finite settings) via applyDamageToPlayerLife().
          const isCounterHit = isStraightClaw || isCounterArc;
          if (isCounterHit) {
            player.lastCounterDamage = COUNTER_ATTACK_DAMAGE;
          }
          applyDamageToPlayerLife(now, isCounterHit ? COUNTER_ATTACK_DAMAGE : BULLET_DAMAGE);
          // A-13/A-14: knocks the player away FROM GABRIEL (along the same
          // straight line the attack travelled), a clearly-visible distance,
          // clamped within PLAY AREA/world bounds by
          // applyPlayerKnockbackAlongAngle()'s own clampPlayerToScreen() call
          // — never off-screen, never stuck in an obstacle forever.
          if (isStraightClaw) {
            applyPlayerKnockbackAlongAngle(tangentAngle, STRAIGHT_CLAW_KNOCKBACK_DISTANCE, STRAIGHT_CLAW_KNOCKBACK_LOCK_MS, now);
          } else {
            applyPlayerKnockbackAlongAngle(tangentAngle, ARC_CLAW_KNOCKBACK_DISTANCE, ARC_CLAW_KNOCKBACK_SUPPRESS_MS, now);
          }
        }
      }
    }
  }

  // The attack's actual body: the supplied claw image, rotated so its own
  // tip<->base axis lines up with `angle` (already tangent-corrected by the
  // caller — see ARC_CLAW_BASE_TIP_ANGLE in updateArcClawSlashes()).
  function drawArcClawImage(x, y, angle, mirrored, alpha) {
    if (!arcClawImgReady) return;
    const drawW = arcClawImg.naturalWidth * ARC_CLAW_DRAW_SCALE;
    const drawH = arcClawImg.naturalHeight * ARC_CLAW_DRAW_SCALE;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    if (mirrored) ctx.scale(-1, 1);
    ctx.drawImage(arcClawImg, -ARC_CLAW_TIP_LOCAL.x * ARC_CLAW_DRAW_SCALE, -ARC_CLAW_TIP_LOCAL.y * ARC_CLAW_DRAW_SCALE, drawW, drawH);
    ctx.restore();
  }

  // Auxiliary slash-trail mark only (NOT the attack body) — a thin bowed
  // crescent, aligned to the pure travel direction (`tangentAngle`, not the
  // image's own rotation), left fading behind the real claw image. Two
  // bowed quadratic curves meeting at sharp points at the tip (forward,
  // local +X) and tail (backward, local -X); mirrored flips which side it
  // bows toward, matching the CW/CCW swing direction.
  function drawArcClawCrescentTrail(x, y, tangentAngle, mirrored, alpha) {
    const half = ARC_CLAW_DRAW_LENGTH / 2;
    const bow = mirrored ? -ARC_CLAW_CRESCENT_BOW : ARC_CLAW_CRESCENT_BOW;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(tangentAngle);
    const grad = ctx.createLinearGradient(-half, 0, half, 0);
    grad.addColorStop(0, 'rgba(150,155,165,0.15)');
    grad.addColorStop(0.55, 'rgba(215,220,228,0.75)');
    grad.addColorStop(1, 'rgba(255,255,255,0.98)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(half, 0);
    ctx.quadraticCurveTo(0, bow, -half, 0);
    ctx.quadraticCurveTo(0, bow * 0.32, half, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,20,24,0.5)';
    ctx.lineWidth = 0.75;
    ctx.stroke();
    ctx.restore();
  }

  function drawArcClawSlash(s) {
    // STRAIGHT CLAW's ordinary (close-range-proximity-COUNTER, south
    // direction) use is still communicated entirely through GABRIEL's own
    // windup/release body sprite (see bossFrameName()) — unchanged. PART8
    // SECTION X: the DEFENSE-counter's own instance (piercesDashInvulnerability,
    // set only at that one trigger site) is the exception — it now ALSO
    // draws the existing claw image as a real flying projectile, reusing
    // the same drawArcClawImage()/crescent-trail art every other CLAW kind
    // already uses (no new art), so the counter is visibly a thrown claw,
    // not just a body-pose animation.
    if (s.kind === 'straightClaw' && !s.piercesDashInvulnerability) return;
    // A very thin, non-magical white/silver trail connecting the recent
    // positions — "air cut open", never a glowing/blue energy line.
    if (s.trail.length >= 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(235,238,242,0.35)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(s.trail[0].x, s.trail[0].y);
      for (let i = 1; i < s.trail.length; i++) ctx.lineTo(s.trail[i].x, s.trail[i].y);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.restore();
    }
    // Afterimages: each keeps ITS OWN position/rotation from when it was
    // the live frame, so the stack of afterimages itself traces the arc —
    // not the current pose copy-pasted backward. The faint crescent draws
    // first (auxiliary trail mark), the claw image draws on top of it
    // (the real attack body).
    const n = s.trail.length;
    for (let i = 0; i < n; i++) {
      const sample = s.trail[i];
      const a = i / Math.max(1, n);
      drawArcClawCrescentTrail(sample.x, sample.y, sample.tangentAngle, s.mirrored, 0.08 + 0.10 * a);
      drawArcClawImage(sample.x, sample.y, sample.angle, s.mirrored, 0.18 + 0.24 * a);
    }
    drawArcClawImage(s.x, s.y, s.angle, s.mirrored, 1);
  }

  // ---------- Game mode / PAUSE ----------
  // SECTION J: `screen` is the top-level boot/loading/opening/mainMenu/
  // gameplay state — deliberately separate from `mode` (BOSS/TRAINING,
  // meaningful only once screen==='gameplay') and from `paused` (only
  // meaningful during gameplay too). update()/draw() both early-return
  // unless screen==='gameplay' (see the game loop below), so nothing in
  // the gameplay world ever ticks in the background during OPENING/MAIN
  // MENU/LOADING — SECTION J's own requirement.
  const gameState = {
    // DARK OUT PART 3: 'bossBattle' added — STORY MODE's own 'boss' keeps
    // its EXACT existing meaning (never repurposed) and is untouched by the
    // new value; 'bossBattle' is BOSS BATTLE MODE's own, fully independent
    // context (see bossBattleState above).
    mode: 'boss', // 'boss' | 'training' | 'securityTraining' | 'bossBattle'
    paused: false, // game starts running in BOSS MODE, same as before PAUSE existed
    // DARK OUT PART 3: 'bossSelect' added (MAIN MENU's own BOSS BATTLE MODE entry).
    screen: 'boot', // 'boot' | 'loading' | 'opening' | 'mainMenu' | 'trainingSelect' | 'bossSelect' | 'gameplay' | 'result' | 'gameover'
  };

  // ---------- SECTION Q: RESULT stats ----------
  // Reset fresh every time STORY MODE actually starts (see startMode()) —
  // never during TRAINING MODE, which has no RESULT screen at all.
  let storyStartTime = 0;
  let storyPausedAccumMs = 0; // total real time spent paused, subtracted from PLAY TIME (Q-1)
  let pauseStartedAt = 0;
  let shotsFired = 0, shotsHit = 0; // Q-2: normal FIRE bullets only, never FLASH
  let totalDamageTaken = 0; // Q-3: accumulated in applyDamageToPlayerLife() regardless of the LIFE setting

  function setScreen(next) {
    gameState.screen = next;
    document.getElementById('loading-screen').hidden = next !== 'loading';
    // SECTION D: OPENING and MAIN MENU share the SAME #opening-screen
    // container (and its one persistent <video>) — only which overlay
    // shows on top of it differs. The video itself is never hidden/
    // recreated by this toggle.
    // PART 2 SECTION A: the TRAINING submenu (BASIC/SECURITY TRAINING) reuses
    // this exact same persistent-video #opening-screen container/pattern —
    // just one more overlay toggled by this same helper, no new screen host.
    // DARK OUT PART 3: BOSS SELECT reuses this exact same persistent-video
    // #opening-screen container/pattern too — one more overlay, no new
    // screen host.
    const showOpeningContainer = next === 'opening' || next === 'mainMenu' || next === 'trainingSelect' || next === 'bossSelect';
    document.getElementById('opening-screen').hidden = !showOpeningContainer;
    document.getElementById('opening-overlay').hidden = next !== 'opening';
    document.getElementById('main-menu-overlay').hidden = next !== 'mainMenu';
    document.getElementById('training-select-overlay').hidden = next !== 'trainingSelect';
    document.getElementById('boss-select-overlay').hidden = next !== 'bossSelect';
    document.getElementById('result-screen').hidden = next !== 'result';
    document.getElementById('game-over-screen').hidden = next !== 'gameover';
    // PLAY AREA / CONTROL AREA are only meaningful during actual gameplay —
    // hidden (not just covered) the rest of the time so no stray touch can
    // reach a control zone underneath LOADING/OPENING/MAIN MENU/RESULT/GAME OVER.
    document.getElementById('play-area').style.display = next === 'gameplay' ? '' : 'none';
    document.getElementById('control-area').style.display = next === 'gameplay' ? '' : 'none';
  }

  // ---------- SECTION T: game-wide BGM (Outbreak 1.1) ----------
  // Exactly ONE Audio instance for the entire session — created once here,
  // never recreated by any screen/mode/PAUSE transition below. PART8
  // SECTION AG-2: swapped from Outbreak 1.0 to the attached Outbreak 1.1
  // source file (byte-identical copy, no re-encoding), stored at
  // assets/audio/outbreak_1_1.mp3 — same repo naming convention as the file
  // it replaces (spaces/dots in "Outbreak 1.1" normalized to underscores
  // for URL-safety). Every control below (loop/volume/preload/pause-resume/
  // stage-transition/GAME OVER/RETRY-position/QUIT-reset/audio-unlock) is
  // completely unchanged — only the audio source itself moved.
  const bgmAudio = new Audio('assets/audio/outbreak_1_1.mp3');
  bgmAudio.loop = true; // T-5: loop forever
  bgmAudio.preload = 'auto';
  // T-10: no on/off toggle in SETTING this turn (always-on) — but kept as a
  // named, setting-shaped constant so a future volume control is a one-line
  // change rather than a new plumbing job.
  const BGM_VOLUME = 0.6;
  bgmAudio.volume = BGM_VOLUME;
  let bgmStarted = false;
  // T-2/T-3: iOS Safari (and other browsers) block audio-with-sound
  // autoplay before a user gesture — OPENING's video stays muted-autoplay
  // (silent either way, per the source file's own lack of an audio track —
  // see MANIFEST notes), and the FIRST "TAP TO START" tap is the gesture
  // that unlocks and starts this <audio> element. T-6: bgmStarted guards
  // against ever calling this a second time / creating a second instance.
  function startBgmOnce() {
    if (bgmStarted) return;
    bgmStarted = true;
    bgmAudio.play().catch(() => {
      // Extremely defensive only — if the browser still rejected this
      // direct-gesture play() call, allow exactly one more attempt on the
      // NEXT tap rather than leaving BGM silent for the rest of the session.
      bgmStarted = false;
    });
  }

  // PART 3 SECTION D: the ONE shared "return to OPENING/TOP MENU" path —
  // every existing route that lands back at MAIN MENU from gameplay/GAME
  // OVER/RESULT goes through this single function instead of a separate
  // copy-pasted reset in each button handler (D-4). Every OTHER screen
  // transition (AREA/STAGE change, PAUSE/RESUME, DARK PHASE, GAME CLEAR->
  // RESULT) calls setScreen() directly and never touches BGM at all, so
  // those all keep the existing continuous-playback behavior (D-3).
  function returnToTopMenu() {
    bgmAudio.currentTime = 0; // D-1/D-2: OPENING/TOP always restarts the BGM from the top
    bgmAudio.play().catch(() => {}); // defensive only — bgmAudio is already playing in every real route that reaches here
    setScreen('mainMenu');
  }

  // ---------- SECTION G: LOADING screen ----------
  // Genuine asset-driven progress — every target below reflects real
  // load/readiness state already tracked elsewhere in this file (spritesReady/
  // spritesTotal, bossSpritesReady/BOSS_FRAME_FILES, STAGES[i].ready, plus
  // polling .complete on the handful of images that don't have their own
  // ready-counter) or the browser's own readyState for the OPENING video/
  // BGM audio — polled on an interval rather than time-based, and never
  // reports 100% until every one of them is actually true.
  // Safety ceiling only — real completion is still what normally ends
  // LOADING (see tick() below). Guards against an indefinite hang if a
  // single asset's readiness event never fires for reasons outside this
  // code's control (e.g. a flaky connection, or a browser/OS media-codec
  // gap on the device itself) — never a substitute for genuine progress
  // tracking, which is why it's set generously high and only ever matters
  // in a genuine worst case.
  const LOADING_MAX_WAIT_MS = 12000;
  const LOADING_FADE_OUT_MS = 250; // SECTION H-6: matches #loading-screen's own CSS transition duration

  function initLoadingSequence() {
    setScreen('loading');
    const loadingScreenEl = document.getElementById('loading-screen');
    const loadingBarFill = document.getElementById('loading-bar-fill');
    const openingVideoEl = document.getElementById('opening-video');
    const loadingStartedAt = performance.now();
    function computeProgress() {
      const targets = [
        spritesReady >= spritesTotal, // player AIM/FIRE sprite grid
        dashSprites.right.complete && dashSprites.left.complete && dashSprites.up.complete && dashSprites.down.complete,
        relaxedSprite.down.complete,
        Object.values(walkSprites).every((set) => set.every((img) => img.complete)),
        STAGES[0].ready, // initial stage background
        bossSpritesReady >= Object.keys(BOSS_FRAME_FILES).length, // primary STORY-MODE-start boss art
        cinematicPoseImg.complete && cinematicPoseBackImg.complete,
        // HAVE_METADATA+, OR the browser has already reported a decode
        // error for it (readyState can never advance further at that
        // point — waiting any longer would just hang LOADING forever) —
        // T-9: metadata/playable state counts as loaded, full download
        // not required.
        openingVideoEl.readyState >= 1 || !!openingVideoEl.error,
        bgmAudio.readyState >= 1 || !!bgmAudio.error, // T-9: same rule for the BGM file
      ];
      return { loaded: targets.filter(Boolean).length, total: targets.length };
    }
    function tick() {
      const { loaded, total } = computeProgress();
      // SECTION G: no text, no percent number — a plain bar-width fill only.
      loadingBarFill.style.width = `${Math.floor((loaded / total) * 100)}%`;
      if (loaded >= total || performance.now() - loadingStartedAt > LOADING_MAX_WAIT_MS) {
        // SECTION H-6: fade out, THEN swap to OPENING — never an instant cut.
        loadingScreenEl.classList.add('loading-fade-out');
        setTimeout(() => setScreen('opening'), LOADING_FADE_OUT_MS);
        return;
      }
      setTimeout(tick, 100);
    }
    tick();
  }

  // ---------- SECTION H: OPENING (tap-to-start) ----------
  const openingOverlayEl = document.getElementById('opening-overlay');
  function onOpeningTap(e) {
    e.preventDefault();
    if (gameState.screen !== 'opening') return; // guards against a stray double-fire (touchstart + mousedown) doing this twice
    startBgmOnce(); // T-3: this exact tap is the user-gesture unlock
    setScreen('mainMenu');
  }
  openingOverlayEl.addEventListener('touchstart', onOpeningTap, { passive: false });
  openingOverlayEl.addEventListener('mousedown', onOpeningTap);

  // ---------- SECTION I: MAIN MENU ----------
  // STORY MODE / TRAINING MODE route through the EXACT SAME startMode()
  // PAUSE MENU's own BOSS MODE/TRAINING MODE buttons already use — no
  // duplicate gameplay wiring. SETTING is wired earlier, alongside PAUSE
  // MENU's own SETTING button (openSettingPanel('mainMenu')).
  document.getElementById('main-menu-story-btn').addEventListener('click', () => startMode('boss'));
  // PART 2 SECTION A: TRAINING now opens a BASIC/SECURITY submenu instead of
  // jumping straight into BASIC TRAINING — both submenu choices still route
  // through the exact same startMode() everything else already uses.
  document.getElementById('main-menu-training-btn').addEventListener('click', () => setScreen('trainingSelect'));
  document.getElementById('training-select-basic-btn').addEventListener('click', () => startMode('training'));
  document.getElementById('training-select-security-btn').addEventListener('click', () => startMode('securityTraining'));
  document.getElementById('training-select-back-btn').addEventListener('click', () => setScreen('mainMenu'));

  // DARK OUT PART 3 SECTION 2/3: BOSS BATTLE MODE — pressing it goes
  // straight to BOSS SELECT (no intermediate menu), same reasoning as
  // TRAINING's own submenu above (one more overlay on the SAME persistent-
  // video container, no new screen host).
  document.getElementById('main-menu-bossbattle-btn').addEventListener('click', () => {
    if (bossBattleState.active) exitBossBattle(); // defensive only — never active from MAIN MENU in any reachable flow
    setScreen('bossSelect');
  });
  document.getElementById('boss-select-roid1-btn').addEventListener('click', () => startBossBattle('roid1'));
  document.getElementById('boss-select-roid2-btn').addEventListener('click', () => startBossBattle('roid2'));
  document.getElementById('boss-select-gabriel-btn').addEventListener('click', () => startBossBattle('gabriel'));
  document.getElementById('boss-select-adam-btn').addEventListener('click', () => startBossBattle('adam'));
  document.getElementById('boss-select-back-btn').addEventListener('click', () => {
    if (bossBattleState.active) exitBossBattle(); // defensive only — see above
    setScreen('mainMenu');
  });

  // ---------- Stage world / camera / EXIT (PART 21-29) ----------
  // Before the boss is fully defeated (state 'dead', not merely HP<=0 and
  // still mid-dissolve), the playable area is pixel-identical to the
  // original single-screen layout — cameraY stays 0 and clampPlayerToScreen
  // behaves exactly as it always did, so nothing about the fight itself
  // changes. Only once worldScrollUnlocked() flips true does extra walkable
  // space open up ABOVE the original screen (negative world Y), with a
  // vertical camera following the player up toward a locked-until-now EXIT
  // at the very top — reaching it is always a deliberate walk, never
  // automatic on boss death. TRAINING MODE (and landscape) never unlocks
  // this at all, same as the stage background itself.
  const EXIT_ZONE_W = 150, EXIT_ZONE_H = 90;
  // SECTION C: the old single-boss-death win condition is now "both AREA 1
  // AND AREA 2 have been cleared" — area2Cleared already implies area1
  // Cleared (AREA 2 can't even be reached otherwise), so checking it alone
  // is sufficient. Everything downstream (the EXIT zone, the fade-to-next-
  // stage transition) is otherwise completely unchanged from before.
  function worldScrollUnlocked() {
    // SECTION 15-18: no longer restricted to portrait (H >= W) — see the
    // matching note above the currentArea/area1Cleared block in update().
    // SECTION E (this turn, supersedes the previous "never kill-gated"
    // design): a DRONE-type STORY STAGE now requires every DRONE in BOTH
    // AREA1+AREA2 destroyed (isDroneStageCleared()) before the bonus
    // EXIT-hunting band opens — until then this returns false, which
    // clampPlayerToScreen() already uses to physically keep the player out
    // of that band (E-1/E-2/E-5), so the EXIT itself is simply unreachable
    // rather than reachable-but-inert. AREA1<->AREA2 crossing itself is
    // completely unaffected (E-4) — only this bonus band beyond AREA2.
    if (isStoryDroneStage()) return gameState.mode === 'boss' && !stageTransition.active && isDroneStageCleared();
    return gameState.mode === 'boss' && area2Cleared && !stageTransition.active;
  }

  // SECTION E-9: every DRONE currently populated for this STAGE (both
  // AREAs, securityRobots is always the combined AREA1+AREA2 population —
  // see populateSecurityDroneAreas()) must be at hp<=0. Vacuously true if
  // securityRobots is empty (never the case for an actual DRONE-type
  // STAGE, but kept safe rather than special-cased).
  function isDroneStageCleared() {
    return securityRobots.every((r) => r.hp <= 0);
  }
  // PART 4 SECTION K/L: TRAINING's own equivalent of worldScrollUnlocked()
  // — but NEVER gated behind a "clear" flag (J-2: SECURITY TRAINING is
  // explicitly not a kill-everything stage), so the bonus EXIT space above
  // AREA2 is open from the moment a TRAINING session begins, for both
  // BASIC TRAINING and SECURITY TRAINING (K-1).
  function trainingWorldScrollUnlocked() {
    return (gameState.mode === 'training' || gameState.mode === 'securityTraining') && !stageTransition.active;
  }
  function exitWorldPos() {
    // Anchored an extra H further north than before this batch, since AREA
    // 2's own full-screen band now sits between the original screen and
    // this bonus space.
    return { x: W / 2, y: -H - worldExtraAbove + EXIT_ZONE_H / 2 + 20 };
  }

  // Short, simple fade sequence (never a long loading-style one): fade to
  // black -> swap to a genuinely different random stage + fresh full-HP
  // boss (with its full existing intro cinematic) + reposition the player
  // -> fade back in.
  const STAGE_FADE_MS = 260;
  const stageTransition = { active: false, phase: null, startedAt: 0 }; // phase: 'out' | 'in'
  function beginStageTransition(now) {
    if (stageTransition.active) return;
    stageTransition.active = true;
    stageTransition.phase = 'out';
    stageTransition.startedAt = now;
  }
  // PART 4 SECTION M/N/O: TRAINING's own AREA2-EXIT stage advance — never
  // spawns GABRIEL, never triggers GAME CLEAR/RESULT (L-2), just a fresh
  // randomized background + a fully reset AREA1 start. Shared by BOTH
  // BASIC TRAINING and SECURITY TRAINING (K-1/O-1); the SECURITY-only
  // block at the end is skipped entirely for BASIC TRAINING (O-2 — DRONEs
  // never appear there).
  function advanceTrainingStage(now) {
    // SECTION M: a fresh random background, excluding the one just used
    // when the pool has more than one candidate (M-3) — AREA1/AREA2 within
    // the new STAGE then both read this same index via currentStage(), so
    // they automatically match (M-1).
    const pool = TRAINING_BACKGROUNDS;
    if (pool.length > 1) {
      const prevIndex = gameState.mode === 'securityTraining' ? securityTrainingBgIndex : basicTrainingBgIndex;
      let nextIndex = prevIndex;
      while (nextIndex === prevIndex) nextIndex = Math.floor(Math.random() * pool.length);
      if (gameState.mode === 'securityTraining') securityTrainingBgIndex = nextIndex;
      else basicTrainingBgIndex = nextIndex;
    }
    cameraY = 0;
    currentArea = 1; // N: new STAGE always starts back at AREA1
    area1Cleared = false;
    area2Cleared = false;
    resetPlayerToBattlePose(); // N-1/N-2: same STORY BOSS battle pose, north-facing
    bullets.length = 0; arcClawSlashes.length = 0; explosions.length = 0;
    barrelLandings.length = 0;
    barrelRestockPending = false;
    barrelRestockRemainingMs = 0;
    // SECTION G/N: SECURITY TRAINING keeps its 0-barrel stage; BASIC
    // TRAINING keeps the existing BARREL_COUNT.
    spawnBarrels(gameState.mode === 'securityTraining' ? 0 : BARREL_COUNT);
    if (gameState.mode === 'securityTraining') {
      // N: fresh 3+3 DRONEs — full HP, patrol/scan re-randomized, every
      // attack/laser/cooldown state reset — spawnSecurityRobots() always
      // builds entirely new robot objects from scratch (same as a fresh
      // session/RESTART), so nothing carries over from the previous STAGE.
      spawnSecurityRobots();
    }
    // N-3: nothing here touches player.stunned or the idle watchdog clock
    // — STUN is already fully disabled for both TRAINING modes (SECTION A).
  }

  // PART 5 SECTION S: picks a fresh STORY DRONE-stage background, avoiding
  // an exact repeat of the immediately-preceding one when the pool allows
  // it (S-3) — the same pattern advanceTrainingStage() already uses above,
  // kept as its own small helper here since STORY's own index
  // (storyDroneBgIndex) is entirely independent of TRAINING's.
  function pickFreshStoryDroneBackground() {
    const pool = TRAINING_BACKGROUNDS;
    if (pool.length <= 1) return;
    const prevIndex = storyDroneBgIndex;
    let nextIndex = prevIndex;
    while (nextIndex === prevIndex) nextIndex = Math.floor(Math.random() * pool.length);
    storyDroneBgIndex = nextIndex;
  }

  // PART 5 SECTION T: the ONE place that enters whatever STORY_STAGE_PLAN
  // [currentStageIndex] describes, fully fresh — used by BOTH a brand-new
  // STORY run (resetModeState()) and every stage-transition advance
  // (updateStageTransition() above), so there is exactly one
  // implementation of "what does entering STORY STAGE N actually do"
  // (never scattered if/else — SECTION T's own explicit requirement).
  function enterStoryStage(now) {
    const plan = STORY_STAGE_PLAN[currentStageIndex];
    bullets.length = 0; arcClawSlashes.length = 0; explosions.length = 0;
    barrels.length = 0;
    barrelLandings.length = 0;
    barrelRestockPending = false;
    barrelRestockRemainingMs = 0;
    spawnHealItem(); // PART7 SECTION W: fresh, unconsumed item every STAGE entry (drone-type and boss-type alike, since both open the SAME worldExtraAbove bonus band)
    if (plan.type === 'drone') {
      // SECTION F-6/F-8/X-1: no GABRIEL, no BOSS INTRO, zero barrels.
      boss.spawned = false;
      boss.state = 'inactive';
      spawnBarrels(0);
      pickFreshStoryDroneBackground(); // SECTION S-1
      populateSecurityDroneAreas(securityRobots, plan.speedMult, plan.fixedCount, true); // SECTION F-1/F-2/F-3/J/L: per-AREA 3/5/7 (or STAGE1/2/3's own fixed count — SECTION B), this STAGE's own speed multiplier baked in; new-turn SECTION 1: `true` guarantees at least one FAST_PATROL DRONE (every STAGE routed through this drone-type branch — 1/2/3/5/6/8/9 — needs one, per this turn's instructions)
      securityAttackSlotsInUse = 0;
    } else { // 'boss': a GABRIEL ENCOUNTER
      bossEncounterIndex = plan.encounterIndex; // SECTION Q: the ONLY place this is ever set
      spawnBarrels(BOSS_ENCOUNTER_BARREL_COUNTS[bossEncounterIndex]); // SECTION K/X
      if (plan.final) {
        spawnBoss(now); // SECTION M: GABRIEL must exist before N-3's "avoid GABRIEL's own body" placement check can read boss.x/y
        spawnFinalStageDrones(now); // PART8 SECTION H: 3+3 DRONEs (one full wave1 per Area) alongside GABRIEL, all FAST_PATROL; wave 1 (initial spawn) never drops in — instant appear
        finalDroneRespawnedByArea = { 1: false, 2: false }; // PART8 SECTION AH: every (re-)entry into the FINAL STAGE — including RETRY — starts fresh at "wave 1, 2nd wave not yet spawned" for BOTH Areas independently
      } else {
        securityRobots.length = 0;
        securityAttackSlotsInUse = 0;
        spawnBoss(now);
      }
    }
  }

  function updateStageTransition(now) {
    if (!stageTransition.active) return;
    const elapsed = now - stageTransition.startedAt;
    if (stageTransition.phase === 'out') {
      if (elapsed < STAGE_FADE_MS) return;
      if (gameState.mode === 'training' || gameState.mode === 'securityTraining') {
        advanceTrainingStage(now);
      } else {
        // PART 5 SECTION T/U: STORY MODE now advances through the fixed,
        // data-driven STORY_STAGE_PLAN (10 STAGES) — this is reached from a
        // DRONE-type STAGE's own EXIT (SECTION G) just as often as from a
        // non-FINAL GABRIEL ENCOUNTER's defeat (SECTION U-3); the FINAL
        // ENCOUNTER's own defeat triggers GAME CLEAR directly instead (see
        // updateBossDying()/isFinalStoryStage()), so currentStageIndex + 1
        // is always in range here.
        currentStageIndex += 1;
        cameraY = 0;
        // SECTION C: the next stage always starts back at AREA 1, fully
        // closed up again — same two-area structure repeats fresh each time.
        currentArea = 1;
        area1Cleared = false;
        area2Cleared = false;
        resetPlayerToBattlePose(); // SECTION H: same fixed intro pose spawnBoss() itself uses
        enterStoryStage(now);
      }
      stageTransition.phase = 'in';
      stageTransition.startedAt = now;
    } else if (stageTransition.phase === 'in') {
      if (elapsed < STAGE_FADE_MS) return;
      stageTransition.active = false;
      stageTransition.phase = null;
    }
  }
  function getStageTransitionOverlayAlpha(now) {
    if (!stageTransition.active) return 0;
    const t = Math.min(1, (now - stageTransition.startedAt) / STAGE_FADE_MS);
    return stageTransition.phase === 'out' ? t : (1 - t);
  }

  // Stage lighting: brightness drifts gently up and down over time (mimics
  // unstable industrial power) instead of sitting at one fixed darkness.
  // Two incommensurate low-frequency sines combined (a single one reads too
  // mechanical/regular) — amplitude is deliberately small and clamped so it
  // can NEVER go fully black, blow out to white, or make the player/boss
  // hard to see; and it's applied as its own screen-space overlay (see
  // draw()), entirely independent of the boss-intro FLASH effect, so the
  // two never visually interfere.
  function getAmbientDarkenAlpha(now) {
    const t = now / 1000;
    const w1 = Math.sin(t * (2 * Math.PI / 23));
    const w2 = Math.sin(t * (2 * Math.PI / 37) + 1.7);
    const combined = w1 * 0.6 + w2 * 0.4; // roughly within [-1, 1]
    const alpha = 0.22 + combined * 0.08; // drifts around the old fixed 0.22
    return Math.max(0.12, Math.min(0.32, alpha));
  }

  // DARK PHASE screen darken: a smooth dt-driven fade (never an instant cut)
  // toward DARKPHASE_OVERLAY_ALPHA while boss.state==='darkphase', and back
  // to 0 the instant it isn't (covers the flashdown transition that ends
  // it). Takes over from — never stacks or competes with — the ambient
  // stage-lighting drift above; see draw()'s if/else between the two.
  // dt-driven (not an absolute deadline), so it automatically freezes
  // exactly on PAUSE like every other timer in this file, and resumes
  // exactly where it left off on RESUME.
  let darkPhaseOverlayAlpha = 0;
  function updateDarkPhaseOverlay(dt) {
    const target = (boss.state === 'darkphase') ? DARKPHASE_OVERLAY_ALPHA : 0;
    const rate = DARKPHASE_OVERLAY_ALPHA / (DARKPHASE_FADE_MS / 1000);
    if (darkPhaseOverlayAlpha < target) {
      darkPhaseOverlayAlpha = Math.min(target, darkPhaseOverlayAlpha + rate * dt);
    } else if (darkPhaseOverlayAlpha > target) {
      darkPhaseOverlayAlpha = Math.max(target, darkPhaseOverlayAlpha - rate * dt);
    }
  }

  // Intentionally draws nothing at all now — the EXIT hit-test zone itself
  // (exitWorldPos()/EXIT_ZONE_W/H, checked every frame in update() once
  // worldScrollUnlocked()) is completely unchanged and still ends the
  // encounter exactly the same way; only the visible marker/label is gone,
  // so reaching it is never telegraphed on-screen.
  function drawExitZone(now) {}

  // ---------- Explosive barrels ----------
  // Stage prop / destructible object, not an enemy: shoot one and it
  // explodes, damaging the boss if it's caught in the blast — a tactical
  // option alongside straight gunfire, and (in TRAINING MODE) just a
  // target to practice aim/AUTO AIM/DASH against.
  const barrels = [];

  function isNearUIZone(x, y) {
    // Conservative rectangles around the bottom-left (ACTION STICK) and
    // bottom-right (AIM STICK/FIRE/DASH) control clusters, sized generously
    // since exact control geometry varies by orientation/viewport.
    const bottomBand = Math.max(180, H * 0.32);
    if (y < H - bottomBand) return false;
    return x < Math.min(240, W * 0.42) || x > W - Math.min(260, W * 0.46);
  }

  // ---------- Healing item (PART7 SECTIONS R-W) ----------
  // A SINGLE item (never 5 separate ones — SECTION S) whose drawn sprite
  // cycles through HEAL_ITEM_IMAGES in strict 1->2->3->4->5->1 order at a
  // fixed cadence, driven from the same dt-based per-frame update every
  // other timer in this file uses (so it also freezes correctly during
  // PAUSE, matching Q's freeze requirement for the unrelated RELOAD gauge).
  const HEAL_ITEM_FRAME_MS = 220; // SECTION S: fast enough to read as a naturally-turning box, slow enough that each frame still registers
  const HEAL_ITEM_DRAW_W = SPRITE_DRAW_H * 0.34; // SECTION R: small, stage-prop-sized — comparable footprint to BARREL_DRAW_H
  const HEAL_ITEM_HIT_RADIUS = 22;
  const HEAL_ITEM_HEAL_FRAC = 0.30; // SECTION U: life = min(maxLife, life + maxLife*0.30)

  const healItem = {
    x: 0, y: 0,
    active: false, // SECTION U/W: false once SHOT-destroyed; only spawnHealItem() (fresh STAGE/RETRY) turns it true again
    frameIndex: 0,
    frameElapsedMs: 0,
  };

  // SECTION T: placed in the game's own REAL "3rd region" — the
  // worldExtraAbove bonus band beyond AREA2 that worldScrollUnlocked()/
  // trainingWorldScrollUnlocked() already open up once a STAGE's own clear
  // condition is met (see exitWorldPos()) — never a fabricated new Area3.
  // Sits in the lower-middle of that band: comfortably below the EXIT zone
  // pinned at the band's very top (never on/over the EXIT), and comfortably
  // above the AREA2<->bonus-band boundary door's own ±AREA_BOUNDARY_DOOR_
  // BAND collision band (never straddling an Area-transition boundary).
  // This private band never hosts a DRONE spawn (spawnFinalStageDrones()/
  // populateSecurityDroneAreas() only ever place DRONEs within AREA1/AREA2
  // themselves), so there is inherently no DRONE-overlap to additionally
  // guard against here.
  function getHealItemSpawnPos() {
    const bandTop = -H - worldExtraAbove;
    const bandBottom = -H;
    const y = bandBottom - (bandBottom - bandTop) * 0.5;
    const floor = getFloorXRangeWorld(); // Y-independent — see getFloorXRangeWorld()'s own comment
    const x = floor ? (floor.left + floor.right) / 2 : W / 2;
    return { x, y };
  }

  // SECTION W: called from enterStoryStage() — every fresh STAGE entry
  // (including a STAGE-preserving RETRY, since RETRY re-runs enterStoryStage
  // via resetModeState(true)) restores exactly one fresh, unconsumed item;
  // walking back and forth between AREAs within the SAME STAGE attempt never
  // calls this again, so an already-consumed item stays consumed.
  function spawnHealItem() {
    const pos = getHealItemSpawnPos();
    healItem.x = pos.x;
    healItem.y = pos.y;
    healItem.active = true;
    healItem.frameIndex = 0;
    healItem.frameElapsedMs = 0;
  }

  function updateHealItem(dt) {
    if (!healItem.active) return;
    healItem.frameElapsedMs += dt * 1000;
    while (healItem.frameElapsedMs >= HEAL_ITEM_FRAME_MS) {
      healItem.frameElapsedMs -= HEAL_ITEM_FRAME_MS;
      healItem.frameIndex = (healItem.frameIndex + 1) % HEAL_ITEM_IMAGES.length; // SECTION S: strict 1->2->3->4->5->1 order, never shuffled
    }
  }

  // PART8 SECTION V: frame 1 (heal_box_1) only, drawn ~3% larger than the
  // other 4 frames — a pure display-time scale on the SAME unmodified image
  // file, never a generative edit of the asset itself, and never touching
  // HEAL_ITEM_DRAW_W (every other frame's base size is untouched).
  const HEAL_ITEM_FRAME1_SCALE = 1.03;
  // PART8 SECTION W: a small, self-contained floating-text array (same
  // draw-time-prune pattern barrelLandings already uses) — the ONE new
  // floating-text mechanism in this file, reused verbatim rather than
  // invented per-caller if any future text needs the same treatment.
  const HEAL_PICKUP_TEXT_MS = 1000; // within the requested 800-1200ms band
  const healPickupTexts = [];
  function spawnHealPickupText(x, y, now) {
    healPickupTexts.push({ x, y, startedAt: now });
  }
  function drawHealPickupTexts(now) {
    for (let i = healPickupTexts.length - 1; i >= 0; i--) {
      const t = healPickupTexts[i];
      const elapsed = now - t.startedAt;
      if (elapsed >= HEAL_PICKUP_TEXT_MS) { healPickupTexts.splice(i, 1); continue; }
      const u = elapsed / HEAL_PICKUP_TEXT_MS;
      ctx.save();
      ctx.globalAlpha = 1 - u; // fades out over the full duration
      ctx.font = 'bold 14px sans-serif';
      ctx.fillStyle = '#3ddc5a'; // green, per SECTION W
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('HP+30%！', t.x, t.y - u * 24); // drifts upward while it fades
      ctx.restore();
    }
  }

  function drawHealItem() {
    if (!healItem.active) return;
    const img = HEAL_ITEM_IMAGES[healItem.frameIndex];
    if (!img.complete || img.naturalWidth === 0) return;
    const scale = healItem.frameIndex === 0 ? HEAL_ITEM_FRAME1_SCALE : 1;
    const w = HEAL_ITEM_DRAW_W * scale;
    const h = w * (img.naturalHeight / img.naturalWidth);
    ctx.drawImage(img, healItem.x - w / 2, healItem.y - h / 2, w, h);
  }

  function pickBarrelSpot() {
    // SECTION C: margins/fallback are relative to the CURRENT area's own
    // screen-sized band (areaTopY(currentArea)..+H), so barrels spawned
    // while fighting in AREA 2 land within AREA 2's own visible band, not
    // back in AREA 1's world-Y range.
    const areaTop = areaTopY(currentArea);
    const marginX = BARREL_DRAW_H * 1.5;
    const marginTop = areaTop + H * 0.22; // stay clear of the boss's spawn band up top
    const marginBottom = H * 0.30;
    // Live player/boss positions (not just their initial spawn points) —
    // matters for the ceiling restock, which can fire mid-fight with both
    // anywhere on the field, not only at mode-start.
    const playerX = player.x, playerY = player.y;
    const bossX = boss.spawned ? boss.x : W / 2;
    const bossY = boss.spawned ? boss.y : areaTop + Math.max(BOSS_DRAW_H * 0.55, H * 0.16);
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = marginX + Math.random() * (W - marginX * 2);
      const y = marginTop + Math.random() * (H - H * 0.22 - marginBottom);
      if (isNearUIZone(x, y - areaTop)) continue; // isNearUIZone reads screen-space UI zones — offset back to a 0-based band first
      if (Math.hypot(x - playerX, y - playerY) < 90) continue; // clear of the player
      if (Math.hypot(x - bossX, y - bossY) < 110) continue; // clear of the boss
      let tooClose = false;
      for (const b of barrels) {
        if ((b.alive || b.falling) && Math.hypot(x - b.x, y - b.y) < BARREL_DRAW_H * 3) { tooClose = true; break; }
      }
      if (tooClose) continue;
      return { x, y };
    }
    // Fallback if 30 attempts all collided with something (very small screens)
    return { x: W / 2 + (Math.random() - 0.5) * W * 0.5, y: areaTop + H * 0.5 };
  }

  // WEAK-POINT-SPAM teleport (PART 7): reuses pickBarrelSpot()'s own
  // safe-coordinate method (stage margins, isNearUIZone, barrel clearance)
  // so GABRIEL's teleport destination is validated exactly the same way a
  // barrel's spawn point already is — inside the stage, never inside a
  // wall/UI margin, never overlapping a barrel — plus its own larger
  // player-clearance distance so the reappear point is never point-blank.
  function pickTeleportDestination() {
    const marginX = BOSS_DRAW_W * 0.6;
    const marginTop = H * 0.22;
    const marginBottom = H * 0.30;
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = marginX + Math.random() * (W - marginX * 2);
      const y = marginTop + Math.random() * (H - marginTop - marginBottom);
      if (isNearUIZone(x, y)) continue;
      if (Math.hypot(x - player.x, y - player.y) < TELEPORT_MIN_DIST_FROM_PLAYER) continue;
      let tooCloseToBarrel = false;
      for (const b of barrels) {
        if ((b.alive || b.falling) && Math.hypot(x - b.x, y - b.y) < BARREL_DRAW_H * 2) { tooCloseToBarrel = true; break; }
      }
      if (tooCloseToBarrel) continue;
      return { x, y };
    }
    // Fallback (all attempts collided, e.g. a very small screen): straight
    // away from the player at the minimum safe distance, clamped on-stage.
    const angle = Math.atan2(boss.y - player.y, boss.x - player.x) || -Math.PI / 2;
    return {
      x: Math.max(marginX, Math.min(W - marginX, player.x + Math.cos(angle) * TELEPORT_MIN_DIST_FROM_PLAYER)),
      y: Math.max(marginTop, Math.min(H - marginBottom, player.y + Math.sin(angle) * TELEPORT_MIN_DIST_FROM_PLAYER)),
    };
  }

  function spawnBarrels(count) {
    barrels.length = 0;
    for (let i = 0; i < count; i++) {
      const spot = pickBarrelSpot();
      barrels.push({ x: spot.x, y: spot.y, alive: true, respawnAt: 0, falling: false });
    }
    barrelRestockPending = false; // a fresh explicit spawn (mode start/RESTART) supersedes any pending restock
  }

  // Drops `count` new barrels in from above, at safe random spots, landing
  // over BARREL_FALL_MS each — see updateBarrels()/drawBarrel() for the
  // fall animation itself. Used by the all-destroyed restock only; the
  // initial per-mode spawn always uses spawnBarrels() (barrels already in
  // place at mode start, no drop-in).
  function spawnFallingBarrels(count, now) {
    for (let i = 0; i < count; i++) {
      const spot = pickBarrelSpot();
      barrels.push({
        x: spot.x, y: spot.y, alive: false, respawnAt: 0,
        falling: true, fallElapsedMs: 0, landX: spot.x, landY: spot.y,
      });
    }
  }

  const explosions = [];
  const EXPLOSION_DURATION_MS = 600; // 0-100 flash, 100-300 fireball, 300-600 sparks/debris/smoke decay
  const BARREL_DAMAGE = BULLET_DAMAGE * 15; // ~15 normal shots worth, per spec's 10-20x range — unchanged
  // SECTION C (this turn): BOSS's own explosion damage — investigation
  // found the boss's blast-damage reach check reused BARREL_EXPLOSION_RADIUS
  // (300px, defined below), the SAME wide radius used for BOTH player and
  // boss knockback, making the boss take damage from barrels that were
  // arguably too far away. Per spec: PLAYER's own radius/damage/knockback
  // and the BOSS's own knockback must all stay byte-for-byte unchanged —
  // only the boss's DAMAGE reach narrows (to ~82%, within the requested
  // 80-85% band) and the boss's damage AMOUNT halves. Both are separate,
  // boss-damage-only constants so nothing else here needs to change.
  const BARREL_DAMAGE_BOSS_MULTIPLIER = 0.5;
  const BARREL_DAMAGE_BOSS = BARREL_DAMAGE * BARREL_DAMAGE_BOSS_MULTIPLIER;
  // New-turn SECTION 4: FINAL-STAGE DRONE-explosion-to-GABRIEL damage only,
  // halved from BARREL_DAMAGE_BOSS — BARREL_DAMAGE_BOSS itself (still used
  // by actual barrel explosions, including in the FINAL STAGE if any were
  // ever present) is left completely untouched, as is every other damage
  // source (normal SHOT, weak point, AUTO AIM, COUNTER, etc.).
  // PART7 SECTION J: halved AGAIN this turn (0.5 -> 0.25 of BARREL_DAMAGE_BOSS
  // overall) — i.e. 50% of last turn's already-halved value. Scope is
  // unchanged: ONLY this DRONE-explosion-vs-GABRIEL path in the FINAL
  // STAGE; BARREL_DAMAGE_BOSS itself (barrels' own damage to GABRIEL, every
  // other stage/source) is never touched.
  const FINAL_STAGE_DRONE_EXPLOSION_BOSS_DAMAGE_MULTIPLIER = 0.25;
  const FINAL_STAGE_DRONE_EXPLOSION_BOSS_DAMAGE = BARREL_DAMAGE_BOSS * FINAL_STAGE_DRONE_EXPLOSION_BOSS_DAMAGE_MULTIPLIER;
  // Restock state: fires whenever every barrel is gone (none alive, none
  // currently falling in) — a single unified path for BOTH BOSS MODE and
  // TRAINING MODE, replacing the old TRAINING-only per-barrel respawnAt
  // timer so the two mechanisms can never both fire and double-spawn.
  let barrelRestockPending = false;
  let barrelRestockRemainingMs = 0;
  const barrelLandings = []; // small non-fiery "just landed" dust puffs — see drawBarrelLanding()

  // Brief, small camera shake on a barrel detonation — canvas-only, applied
  // as a temporary draw()-time translate (see getScreenShakeOffset()) that
  // never touches actual world coordinates, so it can't desync hit tests.
  let screenShakeUntil = 0;
  let screenShakeStartAt = 0;
  let screenShakeDurationMs = 0;
  let screenShakeMag = 0;
  function triggerScreenShake(now, mag, durationMs) {
    screenShakeUntil = now + durationMs;
    screenShakeStartAt = now;
    screenShakeDurationMs = durationMs;
    screenShakeMag = mag;
  }
  function getScreenShakeOffset(now) {
    if (now >= screenShakeUntil) return { x: 0, y: 0 };
    const t = (screenShakeUntil - now) / screenShakeDurationMs; // 1 -> 0
    const mag = screenShakeMag * t;
    return { x: (Math.random() * 2 - 1) * mag, y: (Math.random() * 2 - 1) * mag };
  }

  // PART 4 SECTION F-5: the pure VISUAL half of a barrel explosion (sparks/
  // debris/smoke particles + the screen shake), factored out so any other
  // caller can reuse the exact same effect without a damage/knockback
  // payload attached — DRONE death (see applyDamageToSecurityDrone()) is
  // the first such caller, per F-4's explicit "visual-only" requirement.
  // Never copy-pasted: explodeBarrel() below calls this too, so the two
  // can never visually drift apart.
  function spawnExplosionVisual(x, y, now, options) {
    const opts = options || {};
    // A handful of sparks (fast, bright, short-lived), a few chunky metal
    // debris pieces (slower, tumbling, longer-lived), and some soft smoke
    // puffs (slow drift, fades in late, lingers longest) — generated once
    // here and just aged/positioned by elapsed time in drawExplosion(),
    // canvas-only, no image assets.
    const particles = [];
    for (let i = 0; i < 14; i++) {
      particles.push({ type: 'spark', angle: Math.random() * Math.PI * 2, speed: 220 + Math.random() * 190, size: 1.4 + Math.random() * 1.6 });
    }
    for (let i = 0; i < 8; i++) {
      particles.push({ type: 'debris', angle: Math.random() * Math.PI * 2, speed: 90 + Math.random() * 150, size: 3 + Math.random() * 3.5, spin: (Math.random() - 0.5) * 12 });
    }
    for (let i = 0; i < 5; i++) {
      particles.push({ type: 'smoke', angle: Math.random() * Math.PI * 2, speed: 16 + Math.random() * 34, size: 13 + Math.random() * 11 });
    }
    explosions.push({ x, y, startAt: now, particles });
    if (opts.shake !== false) triggerScreenShake(now, 6, 180);
  }

  function explodeBarrel(barrel, now) {
    barrel.alive = false;
    spawnExplosionVisual(barrel.x, barrel.y, now);
    // Explosion damage bypasses DEFENSE entirely — a stage gimmick that
    // works regardless of the boss's current state, unlike gunfire. The
    // reach check adds BOSS_HURT_RADIUS so it's the boss's hurtbox CIRCLE
    // (not just its exact center point) that has to be within blast range.
    if (boss.spawned && boss.state !== 'dead' &&
        Math.hypot(barrel.x - boss.x, barrel.y - boss.y) <= BARREL_EXPLOSION_DAMAGE_RADIUS_BOSS + BOSS_HURT_RADIUS) {
      applyExplosionDamageToBoss(BARREL_DAMAGE_BOSS, now);
    }
    // SECTION F: knockback is entirely separate from damage above — it
    // applies to the player AND the boss purely by blast-radius proximity,
    // never gated on defense/invulnerability the way damage is (or isn't).
    // Reuses the existing player-knockback primitive; the boss has no
    // pre-existing one, so it's pushed directly (the per-frame CHASE-state
    // clamp elsewhere already keeps boss.x/y on-stage the very next frame).
    const distToPlayer = Math.hypot(player.x - barrel.x, player.y - barrel.y);
    if (distToPlayer <= BARREL_EXPLOSION_RADIUS) {
      const strength = 1 - distToPlayer / BARREL_EXPLOSION_RADIUS;
      const angle = Math.atan2(player.y - barrel.y, player.x - barrel.x) || -Math.PI / 2;
      applyPlayerKnockbackAlongAngle(angle, BARREL_EXPLOSION_KNOCKBACK_DISTANCE * strength, BARREL_EXPLOSION_KNOCKBACK_SUPPRESS_MS, now);
    }
    if (boss.spawned && !bossIsInCinematic() && boss.state !== 'darkphase' && boss.state !== 'teleport' && boss.state !== 'straightclaw') {
      const distToBoss = Math.hypot(boss.x - barrel.x, boss.y - barrel.y);
      if (distToBoss <= BARREL_EXPLOSION_RADIUS) {
        const strength = 1 - distToBoss / BARREL_EXPLOSION_RADIUS;
        const angle = Math.atan2(boss.y - barrel.y, boss.x - barrel.x) || -Math.PI / 2;
        boss.x += Math.cos(angle) * BARREL_EXPLOSION_KNOCKBACK_DISTANCE * strength;
        boss.y += Math.sin(angle) * BARREL_EXPLOSION_KNOCKBACK_DISTANCE * strength;
      }
    }
    // No more per-barrel respawn timer here (old TRAINING-only behavior) —
    // restocking is now unified for both modes in updateBarrels() below,
    // triggered once every barrel is gone, so the two paths can never
    // double-spawn.
  }

  // dt-driven (not absolute-deadline) countdowns so restock waiting and the
  // fall animation genuinely stop advancing while PAUSE is active — update()
  // as a whole returns early during PAUSE, so dt simply never arrives here.
  function updateBarrels(dt, now) {
    // PART 4 SECTION G: SECURITY TRAINING never has any barrels at all
    // (G-1) — without this guard, spawning 0 barrels there would read as
    // "all barrels destroyed" below and schedule an auto-restock of a
    // fresh BARREL_COUNT batch, directly contradicting G-3's "何回移動して
    // もbarrelが復活・生成されないこと". PART 5 SECTION F-8/X-1/M-4: the same
    // applies to every DRONE-only STORY STAGE and to the FINAL STAGE (0
    // barrels there too, replaced by 3 DRONEs). GABRIEL-type STORY STAGEs
    // and BASIC TRAINING are both unaffected (G-2).
    if (gameState.mode === 'securityTraining' || isStoryDroneStage() || isFinalStoryStage()) return;
    let pendingCount = 0;
    for (const b of barrels) {
      if (b.falling) {
        b.fallElapsedMs = (b.fallElapsedMs || 0) + dt * 1000;
        if (b.fallElapsedMs >= BARREL_FALL_MS) {
          b.falling = false;
          b.alive = true;
          b.x = b.landX; b.y = b.landY;
          barrelLandings.push({ x: b.landX, y: b.landY, startAt: now });
          triggerScreenShake(now, 2.5, 90); // small impact — nowhere near explosion-sized
        }
        pendingCount++;
      } else if (b.alive) {
        pendingCount++;
      }
    }
    if (pendingCount === 0 && !barrelRestockPending) {
      barrelRestockPending = true;
      barrelRestockRemainingMs = BARREL_RESTOCK_DELAY_MIN_MS + Math.random() * (BARREL_RESTOCK_DELAY_MAX_MS - BARREL_RESTOCK_DELAY_MIN_MS);
    }
    if (barrelRestockPending) {
      barrelRestockRemainingMs -= dt * 1000;
      if (barrelRestockRemainingMs <= 0) {
        barrelRestockPending = false;
        spawnFallingBarrels(BARREL_COUNT, now); // SECTION E-1: restock is always a fresh, freshly-randomized set of 5
      }
    }
  }

  // ================= PART 2/3: SECURITY ROBOT (DRONE) placement/state/attack =================

  // PART 4 SECTION B: Y is no longer randomized — each AREA's usable
  // vertical band (same top/bottom margins pickBarrelSpot()/the old
  // pickSecurityRobotSpot() already used) is divided into
  // (count+1) equal segments, and this row sits at the indexInArea-th
  // internal division point (never touching the top/bottom edges — B-4).
  // With 3 robots per AREA that's the 1/4, 2/4, 3/4 points of the usable
  // band, giving a clearly-spaced, regular vertical layout instead of a
  // random scatter.
  function securityDroneRowY(area, indexInArea, countInArea) {
    const areaTop = areaTopY(area);
    const usableTop = areaTop + H * 0.22;
    const usableBottom = areaTop + H - H * 0.22;
    return usableTop + (usableBottom - usableTop) * ((indexInArea + 1) / (countInArea + 1));
  }

  // SECTION B-5/C-4: X (the patrol CENTER) keeps the same safe-random-
  // placement pattern (margins padded by the max patrol range so a
  // robot's own swing can't reach the world edge, isNearUIZone, minimum
  // spacing against every already-placed robot this STAGE, 30-attempt
  // retry) — only Y is now regular; X keeps its randomness (B-5's own
  // explicit "X座標については...多少randomizeして構いません").
  // PART2-turn SECTION D/E/I: the safe X-range for placing a DRONE's own
  // patrol CENTER, given how far its own margin (patrol swing + body) needs
  // to clear on each side — clamped inside the CURRENT background's actual
  // visible floor (getFloorXRangeWorld()), never the full screen width, so
  // a DRONE's spawn point (and its later patrol swing) can never land any
  // part of itself inside wall texture (SECTION I's actual root cause: the
  // old margin was screen-width-only and never consulted the floor at all).
  // Falls back to the full screen width (minus the same margin) only if the
  // current background's own floor bounds aren't available yet (e.g. image
  // still loading) — collapses to a single centered point rather than
  // producing an inverted/invalid range if the corridor is narrower than
  // the requested margin.
  function getDronePlacementRangeX(marginX) {
    const floor = getFloorXRangeWorld();
    let lo = marginX, hi = W - marginX;
    if (floor) {
      lo = Math.max(lo, floor.left + marginX);
      hi = Math.min(hi, floor.right - marginX);
    }
    if (lo > hi) { const mid = (lo + hi) / 2; lo = hi = mid; }
    return { lo, hi };
  }

  // PART8 SECTION E/L: root-cause fix for the "全DRONEが同じX" collapse —
  // on a narrow-floor background (e.g. this game's own STAGE1 pool, whose
  // measured floor can be ~160px wide), the OLD placement margin (body
  // clearance + the ENTIRE max patrol swing, SECURITY_PATROL_RANGE_MAX)
  // could easily exceed the corridor's own width, forcing
  // getDronePlacementRangeX() to collapse its returned range to a single
  // point — meaning EVERY drone in EVERY area landed at the exact same X,
  // not just a visually-similar one. This margin only needs to keep a
  // DRONE'S OWN BODY off the wall texture at spawn; buildSecurityDrone()'s
  // own separate, already-existing patrolRange clamp (keyed off the actual
  // chosen x, not this margin) independently shrinks each robot's patrol
  // swing to whatever room is really left, so a much smaller placement
  // margin here is safe and gives real X variety back even on narrow floors.
  const DRONE_PLACEMENT_BODY_MARGIN = SECURITY_ROBOT_DRAW_D * 1.5;

  function pickSecurityDroneCenterX(existingRobots, area, y) {
    const marginX = SECURITY_ROBOT_DRAW_D * 3 + SECURITY_PATROL_RANGE_MAX;
    const range = getDronePlacementRangeX(marginX);
    const areaTop = areaTopY(area);
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = range.lo + Math.random() * (range.hi - range.lo);
      if (isNearUIZone(x, y - areaTop)) continue; // isNearUIZone reads screen-space UI zones — offset back to a 0-based band first
      if (Math.hypot(x - player.x, y - player.y) < SECURITY_ROBOT_MIN_SPACING * 1.2) continue; // clear of the player's initial spot
      let tooClose = false;
      for (const r of existingRobots) {
        if (Math.hypot(x - r.patrolCenterX, y - r.y) < SECURITY_ROBOT_MIN_SPACING) { tooClose = true; break; }
      }
      if (tooClose) continue;
      return x;
    }
    // Fallback if 30 attempts all collided (very small/narrow floors):
    // centered within the actual floor range, with a small deterministic
    // per-index offset (capped to a quarter of the available range) so
    // same-row fallbacks still don't all stack on the exact same X.
    const mid = (range.lo + range.hi) / 2;
    const offset = Math.min(W * 0.12, (range.hi - range.lo) / 4);
    return mid + (existingRobots.length % 2 === 0 ? -1 : 1) * offset;
  }

  // PART8 SECTION E: root cause of the "縦一列" (single vertical column)
  // look — securityDroneRowY() placed Y at fixed, perfectly-even (count+1)
  // division points every DRONE STAGE, while only X was ever randomized;
  // on the narrower floor-plate backgrounds the safe X range is much
  // narrower than the full vertical usable band, so the regular Y rows
  // visually dominated and every DRONE read as one vertical line. Replaced
  // with a genuine 2D random pick (both X and Y) within the SAME
  // floor-aware X range and the SAME usable Y band securityDroneRowY() used,
  // with UI-zone, player/extra-avoid-point, and DRONE-DRONE spacing checks —
  // never placing any part of a DRONE (or its patrol swing, via marginX)
  // inside wall texture. `avoidPoints` (optional) is used by the FINAL
  // STAGE's own placement to additionally clear GABRIEL's body.
  function pickSecurityDroneSpot(existingRobots, area, marginX, avoidPoints) {
    const range = getDronePlacementRangeX(marginX);
    const areaTop = areaTopY(area);
    const usableTop = areaTop + H * 0.22;
    const usableBottom = areaTop + H - H * 0.22;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = range.lo + Math.random() * (range.hi - range.lo);
      const y = usableTop + Math.random() * (usableBottom - usableTop);
      if (isNearUIZone(x, y - areaTop)) continue;
      if (Math.hypot(x - player.x, y - player.y) < SECURITY_ROBOT_MIN_SPACING * 1.2) continue;
      let tooClose = false;
      for (const r of existingRobots) {
        if (Math.hypot(x - r.patrolCenterX, y - r.y) < SECURITY_ROBOT_MIN_SPACING) { tooClose = true; break; }
      }
      if (tooClose) continue;
      if (avoidPoints) {
        for (const p of avoidPoints) {
          if (Math.hypot(x - p.x, y - p.y) < (p.r || SECURITY_ROBOT_MIN_SPACING * 1.2)) { tooClose = true; break; }
        }
        if (tooClose) continue;
      }
      return { x, y };
    }
    // Fallback (very narrow floor/band): deterministic per-index spread
    // across both axes so even the fallback never stacks every DRONE onto
    // one point.
    const midX = (range.lo + range.hi) / 2;
    const midY = (usableTop + usableBottom) / 2;
    const offX = Math.min(W * 0.12, (range.hi - range.lo) / 4);
    const offY = Math.min(H * 0.08, (usableBottom - usableTop) / 4);
    const n = existingRobots.length;
    return {
      x: midX + (n % 2 === 0 ? -1 : 1) * offX,
      y: midY + (Math.floor(n / 2) % 2 === 0 ? -1 : 1) * offY,
    };
  }

  const SECURITY_SCAN_AXES = ['horizontal', 'vertical'];

  // PART 5 SECTION A-2: picks one behavior TYPE per DRONE in a batch of
  // `count`, guaranteeing the batch is never all-identical (A-2's own
  // explicit "動きが速いDRONE・SEARCHだけ速いDRONE・通常DRONE・中央停止scanner
  // が混在するように") whenever count >= 2 — a single-DRONE batch has no
  // "mixed" concept to satisfy, so it's left alone.
  function pickSecurityBehaviorTypes(count) {
    const types = [];
    for (let i = 0; i < count; i++) {
      types.push(SECURITY_BEHAVIOR_TYPES[Math.floor(Math.random() * SECURITY_BEHAVIOR_TYPES.length)]);
    }
    if (count >= 2 && types.every((t) => t === types[0])) {
      let alt = types[0];
      while (alt === types[0]) alt = SECURITY_BEHAVIOR_TYPES[Math.floor(Math.random() * SECURITY_BEHAVIOR_TYPES.length)];
      types[Math.floor(Math.random() * count)] = alt;
    }
    return types;
  }

  // SECTION A-3/J-3/L-3: builds one fresh DRONE object — behaviorType's own
  // TYPE multiplier and the current STORY STAGE's own speedMult (1.0 for
  // SECURITY TRAINING and every non-STORY caller) are both baked directly
  // into patrolSpeed/scanSpeed ONCE here (never re-looked-up per frame), and
  // compose multiplicatively exactly as specified (base random × TYPE ×
  // STAGE). scanSpeed keeps meaning "this robot's own normal SEARCH speed"
  // for its whole life — CENTER SCANNER's own slow centerScan sweep
  // (SECTION B) derives its speed from this same field at read-time
  // (× CENTER_SCAN_SLOW_FACTOR), so the STAGE multiplier is automatically
  // folded into its slow speed too (J-4/L-4) without being stored twice.
  function buildSecurityDrone(x, y, behaviorType, speedMult) {
    const mult = SECURITY_BEHAVIOR_MULTIPLIERS[behaviorType];
    const patrolDir = Math.random() < 0.5 ? 1 : -1;
    const basePatrolSpeed = SECURITY_PATROL_SPEED_MIN + Math.random() * (SECURITY_PATROL_SPEED_MAX - SECURITY_PATROL_SPEED_MIN);
    const baseScanSpeed = SECURITY_SCAN_SPEED_MIN + Math.random() * (SECURITY_SCAN_SPEED_MAX - SECURITY_SCAN_SPEED_MIN);
    let patrolRange = SECURITY_PATROL_RANGE_MIN + Math.random() * (SECURITY_PATROL_RANGE_MAX - SECURITY_PATROL_RANGE_MIN);
    // PART2-turn SECTION I: a final safety clamp (on top of
    // getDronePlacementRangeX()'s own placement-time margin) so that
    // whatever x this drone actually landed at, its own patrol SWING can
    // never reach past the visible floor into wall texture — covers every
    // caller, including spawnFinalStageDrones()'s own separate placement
    // scheme (SECTION F), not just pickSecurityDroneCenterX().
    const floor = getFloorXRangeWorld();
    if (floor) {
      const maxRangeBySpace = Math.min(x - floor.left, floor.right - x) - SECURITY_ROBOT_DRAW_D * 0.5;
      patrolRange = Math.max(0, Math.min(patrolRange, maxRangeBySpace));
    }
    return {
      x, y, // y is this robot's fixed row — only x ever changes (F: left/right only)
      patrolCenterX: x,
      patrolRange,
      patrolSpeed: basePatrolSpeed * mult.patrol * speedMult,
      patrolDir,
      dir: patrolDir > 0 ? 'east' : 'west', // F-6
      hp: SECURITY_DRONE_HP,
      hitFlashStartAt: -Infinity, // SECTION E: independent per-robot damage-blink state
      behaviorType, // PART 5 SECTION A: fixed for life, chosen once here
      // SECTION I: fixed for this robot's whole lifetime, chosen once here.
      scanAxis: SECURITY_SCAN_AXES[Math.floor(Math.random() * SECURITY_SCAN_AXES.length)],
      // SECTION K-1: the scan's own origin is bound to the PATROL CENTER
      // (never the drone's live, constantly-moving x) so the SHADOW can
      // never be left behind in an unrelated spot as the drone patrols.
      scanCenterX: x,
      scanCenterY: y,
      scanRange: SECURITY_SCAN_RANGE_MIN + Math.random() * (SECURITY_SCAN_RANGE_MAX - SECURITY_SCAN_RANGE_MIN),
      scanSpeed: baseScanSpeed * mult.scan * speedMult,
      scanOffset: (Math.random() * 2 - 1) * SECURITY_SCAN_RANGE_MIN, // J-4: desynced starting phase
      scanDir: Math.random() < 0.5 ? 1 : -1,
      state: 'watching',
      telegraphElapsedMs: 0,
      cooldownRemainingMs: 0,
      lockedTargetX: 0, lockedTargetY: 0,
      laserOriginX: 0, laserOriginY: 0, laserEndX: 0, laserEndY: 0,
      laserRemainingMs: 0,
      // PART 5 SECTION B: CENTER SCANNER's own center-stop state machine —
      // null/inert for every other TYPE (their movement branch below never
      // reads these fields at all).
      moveState: behaviorType === 'CENTER_SCANNER' ? 'patrol' : null,
      centerScanCooldownRemainingMs: behaviorType === 'CENTER_SCANNER'
        ? (CENTER_SCAN_COOLDOWN_MIN_MS + Math.random() * (CENTER_SCAN_COOLDOWN_MAX_MS - CENTER_SCAN_COOLDOWN_MIN_MS))
        : 0,
      centerScanDurationMs: 0,
      centerScanRemainingMs: 0,
      // PART7 SECTION H: 'active' for every normal DRONE (including wave 1's
      // initial FINAL-STAGE spawn — instant appear, unchanged); only
      // spawnFinalStageDrones(dropIn=true)'s wave-2 respawn overwrites these
      // to 'dropping'/now right after construction.
      dropState: 'active',
      dropStartAt: -Infinity,
    };
  }

  // PART 5 SECTION C: each AREA independently rolls its own DRONE count from
  // exactly {3,5,7} (C-1) — securityDroneRowY()'s existing (count+1)-segment
  // formula already generalizes to any of these with no changes needed
  // (C-3).
  function pickSecurityDroneCount() {
    return SECURITY_DRONE_COUNT_CHOICES[Math.floor(Math.random() * SECURITY_DRONE_COUNT_CHOICES.length)];
  }

  // Shared by SECURITY TRAINING and every STORY DRONE-type STAGE: builds a
  // full fresh 2-AREA population into `into` (mutated in place, mirroring
  // spawnBarrels()'s own reset-then-repopulate pattern) — each AREA's own
  // count and behavior-TYPE mix are rolled independently (C-1/C-2/A-2).
  // SECTION B (this turn): `fixedCount`, when given, is used for BOTH AREAs
  // instead of the usual {3,5,7} random roll — STAGE 1/2/3's own STORY_
  // STAGE_PLAN entries pass their fixed 3/5/7 through here; every other
  // caller (SECURITY TRAINING, STAGE 5/6/8/9) omits it and keeps the
  // existing random-per-AREA behavior unchanged.
  // New-turn SECTION 1: `ensureFastDrone`, when true, guarantees at least one
  // FAST_PATROL DRONE somewhere in this STAGE's combined population — reuses
  // the existing FAST_PATROL profile verbatim (no new speed system) rather
  // than inventing a separate "fast" concept. Only enterStoryStage()'s own
  // DRONE-type branch (STAGE 1/2/3/5/6/8/9) passes true; SECURITY TRAINING's
  // spawnSecurityRobots() omits it and keeps its existing fully-random mix.
  function populateSecurityDroneAreas(into, speedMult, fixedCount, ensureFastDrone) {
    into.length = 0;
    const marginX = DRONE_PLACEMENT_BODY_MARGIN;
    for (const area of [1, 2]) {
      const count = fixedCount || pickSecurityDroneCount();
      const types = pickSecurityBehaviorTypes(count);
      for (let i = 0; i < count; i++) {
        const spot = pickSecurityDroneSpot(into, area, marginX); // PART8 SECTION E: true 2D scatter, not fixed rows
        into.push(buildSecurityDrone(spot.x, spot.y, types[i], speedMult));
      }
    }
    if (ensureFastDrone && !into.some((r) => r.behaviorType === 'FAST_PATROL')) {
      const r0 = into[0];
      into[0] = buildSecurityDrone(r0.x, r0.y, 'FAST_PATROL', speedMult);
    }
  }

  // SECTION D: SECURITY TRAINING's own spawn/re-roll entry point — called
  // fresh from resetModeState() on every session start AND every RESTART,
  // and again from advanceTrainingStage() on every AREA2 EXIT (D-2: count,
  // behavior profile, patrol/scan speed, and scanAxis are ALL re-rolled,
  // never carried over), so every robot's full state is always brand new.
  // SECURITY TRAINING's own speedMult is always 1.0 (D-3: no STORY STAGE
  // multiplier applies here).
  function spawnSecurityRobots() {
    populateSecurityDroneAreas(securityRobots, 1.0);
    securityAttackSlotsInUse = 0;
  }

  // PART 5 SECTION M/N: the FINAL STAGE's own distinct 3-DRONE placement —
  // fixed count (N-1, never the 3/5/7 pool), genuinely random (x,y) within
  // AREA1's own band (N-2, not the regular Y-even-spacing rows every other
  // DRONE stage uses), avoiding the player's spawn point, GABRIEL's own
  // body, UI zones, and DRONE-DRONE overlap (N-3). TYPE is randomly chosen
  // per-DRONE from all 4 existing types (N-5); speedMult is the FINAL
  // STAGE's own dedicated constant, never STAGE 8/9's 1.5x (N-6).
  // PART7 SECTION E/F: rewritten this turn — the old version (a) hardcoded
  // areaTopY(1), so every FINAL-STAGE DRONE ever landed in AREA1 only,
  // leaving AREA2 with zero DRONE combat, and (b) used a floor-UNAWARE
  // marginX (screen-width based, no getFloorXRangeWorld() lookup), so a
  // roll near either edge of a narrow-floor background (e.g. cargo_lift/
  // fortress-style assets) could place a DRONE's own patrol swing inside
  // wall texture, which is the confirmed root cause of SECTION E/I's
  // "spawns wall-adjacent then looks frozen" reports (a degenerate
  // patrolRange near 0, clamped by buildSecurityDrone()'s own safety net).
  // Both are fixed here by reusing the SAME getDronePlacementRangeX()/
  // getFloorXRangeWorld() machinery pickSecurityDroneCenterX() already
  // uses, and by splitting the fixed 3-DRONE count across BOTH AREA1 and
  // AREA2 (F: real combat in both, never an inflated total count).
  // `dropIn` (SECTION H/K): when true (a wave-2 respawn only — wave 1's
  // initial spawn always passes false), each new DRONE starts in a
  // 'dropping' state and falls in from above using the same shadow-reveal +
  // ease-in-fall technique GABRIEL's own BOSS INTRO uses (see
  // drawBossIntro()'s SILENCE_END..SHADOW_END phase) — no new art, normal
  // AI does not run until landing (see updateSecurityRobots()).
  //
  // PART8 SECTION H/I/J/K: rewritten to spawn ONE Area's worth at a time
  // (FINAL_DRONES_PER_AREA, never a shared "3 total" count — that was the
  // confirmed root cause of the old 2/1 split) and to APPEND rather than
  // reset the whole securityRobots array, so spawning Area2's wave2 can
  // never wipe out Area1's still-alive drones (and vice versa) — the two
  // Areas' populations must be able to coexist and be manipulated
  // independently. Placement uses the SAME true 2D scatter
  // (pickSecurityDroneSpot()) every other DRONE STAGE now uses (PART8
  // SECTION E), with GABRIEL/player as extra avoid-points in AREA1 only.
  function spawnFinalStageDronesForArea(area, dropIn, now) {
    const marginX = DRONE_PLACEMENT_BODY_MARGIN; // PART8 SECTION E/L: body-clearance only — see DRONE_PLACEMENT_BODY_MARGIN's own comment for why the old full-patrol-swing margin collapsed every DRONE onto one X on narrow floors; buildSecurityDrone()'s own patrolRange clamp still independently protects the swing
    const avoidPoints = area === 1 // GABRIEL and the player only ever occupy AREA1 in the FINAL STAGE
      ? [{ x: player.x, y: player.y }, { x: boss.x, y: boss.y }]
      : null;
    for (let i = 0; i < FINAL_DRONES_PER_AREA; i++) {
      const spot = pickSecurityDroneSpot(securityRobots, area, marginX, avoidPoints);
      // New-turn SECTION 2 / PART8 SECTION G: every FINAL-STAGE DRONE is
      // FAST_PATROL — FAST_PATROL only scales `patrol` (movement speed),
      // leaving `scan` at its neutral 1.0x, so SEARCH/LASER/targeting
      // behavior is untouched exactly as required.
      const drone = buildSecurityDrone(spot.x, spot.y, 'FAST_PATROL', FINAL_STAGE_DRONE_SPEED_MULTIPLIER);
      if (dropIn) {
        drone.dropState = 'dropping';
        drone.dropStartAt = now;
      }
      securityRobots.push(drone);
    }
  }

  // Initial FINAL STAGE spawn (called once from enterStoryStage()) — a
  // fresh wave1 in BOTH Areas, never dropping in (instant appear, same as
  // every other DRONE STAGE's initial population).
  function spawnFinalStageDrones(now) {
    securityRobots.length = 0;
    securityAttackSlotsInUse = 0;
    spawnFinalStageDronesForArea(1, false, now);
    spawnFinalStageDronesForArea(2, false, now);
  }

  // SECTION H/I/K: the ONE shared function computing the searchlight
  // SHADOW's current center — used by BOTH its drawn ellipse
  // (drawSecurityShadow()) AND its detection hitbox
  // (isPlayerInSecurityShadow()), so the two can never drift apart (L-1).
  // scanOffset is a simple back-and-forth (ping-pong) displacement along
  // whichever ONE axis this robot was fixed to at spawn (I-3/I-5) —
  // entirely independent of the robot's own separate left/right patrol.
  function getSecurityShadowCenter(robot) {
    if (robot.scanAxis === 'horizontal') {
      return { x: robot.scanCenterX + robot.scanOffset, y: robot.scanCenterY };
    }
    return { x: robot.scanCenterX, y: robot.scanCenterY + robot.scanOffset }; // vertical
  }

  // SECTION D (this turn): the PLAYER's own foot/ground-contact world
  // position — the SAME footFrac math drawPlayer() itself already uses to
  // land the sprite's drawn foot row exactly on player.y at normal scale
  // (see the dy calculation further below in draw()), reused here verbatim
  // rather than approximated separately, so "detected" can only ever mean
  // "the player's own feet, as actually drawn on screen, are here" (D-3).
  function getPlayerFootWorldPosition() {
    const footFrac = PLAYER_FOOT_Y / PLAYER_CANVAS_H;
    return { x: player.x, y: player.y - SPRITE_DRAW_H / 2 + SPRITE_DRAW_H * footFrac };
  }

  // SECTION D-6: a small foot-sized tolerance — NOT the full-body
  // PLAYER_HIT_RADIUS (22px) the previous version added on both axes,
  // which made the invisible detection ellipse noticeably larger than the
  // visible white SEARCH ellipse and fired before the player's own sprite
  // visually touched it (the reported false-detection bug).
  const SECURITY_FOOT_DETECT_RADIUS = 4;

  // SECTION H/L/D (this turn): a wide, short, soft-edged OVAL detection
  // area (never the old thin directional rectangle — SECTION G), tested
  // against the player's own FOOT point (D-2/D-3) with only a small
  // foot-sized tolerance (D-6) — never the player's full body/sprite
  // center. Uses the exact same centerX/centerY/radiusX/radiusY
  // (getSecurityShadowCenter()/SECURITY_SHADOW_RADIUS_X/Y) the visible
  // white ellipse itself is drawn with (drawSecurityShadow()), so visual
  // and hitbox can never disagree (D-9/SECTION F-1's "one shared
  // coordinate function" requirement, extended here to the foot check).
  function isPlayerInSecurityShadow(robot) {
    const c = getSecurityShadowCenter(robot);
    const foot = getPlayerFootWorldPosition();
    const rx = SECURITY_SHADOW_RADIUS_X + SECURITY_FOOT_DETECT_RADIUS;
    const ry = SECURITY_SHADOW_RADIUS_Y + SECURITY_FOOT_DETECT_RADIUS;
    const nx = (foot.x - c.x) / rx;
    const ny = (foot.y - c.y) / ry;
    return (nx * nx + ny * ny) <= 1;
  }

  // SECTION K: per-direction "visual center-bottom" muzzle point, derived
  // from the SAME measured opaque-pixel-bbox fractions used to scale the
  // sprite itself — never a hand-tuned separate offset that could drift
  // from the actual art as directions change.
  function getSecurityRobotMuzzlePos(robot) {
    const m = SECURITY_ROBOT_METRICS[robot.dir];
    const drawX = robot.x - m.drawW / 2;
    const drawY = robot.y - m.drawH / 2;
    return { x: drawX + m.drawW * m.muzzleFracX, y: drawY + m.drawH * m.muzzleFracY };
  }

  // Point-to-segment distance — no existing helper of this shape was found
  // elsewhere in the codebase (ARC CLAW/CLAW STING use a rotated-local-frame
  // check instead, not applicable to a simple straight muzzle->target shot).
  function distanceToSegment(px, py, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - x0) * dx + (py - y0) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = x0 + t * dx, cy = y0 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  // SECTION L/M: fires ONCE at the exact instant telegraph ends, from the
  // muzzle to the already-locked target — the laser's VISUAL endpoints
  // (robot.laserOriginX/Y -> laserEndX/Y, drawn by drawSecurityLaserBeam())
  // and its damage hitbox (the distanceToSegment check right below) are
  // computed from these exact same two points, so they can never disagree.
  // No re-tracking happens after this call — the player's position at THIS
  // instant is what's checked, once.
  function fireSecurityLaser(robot, now) {
    const muzzle = getSecurityRobotMuzzlePos(robot);
    robot.laserOriginX = muzzle.x;
    robot.laserOriginY = muzzle.y;
    robot.laserEndX = robot.lockedTargetX;
    robot.laserEndY = robot.lockedTargetY;
    robot.laserRemainingMs = SECURITY_LASER_VISUAL_MS;
    // SECTION L (dodgeability, this fix): the target is locked from the
    // player's position AT THIS EXACT INSTANT, so hit-testing right here
    // would always read as a guaranteed hit (distance ~0) and the beam
    // could never actually be dodged — contradicting L-2's own "the player
    // can see the shot coming and move before the beam actually resolves".
    // Damage is instead resolved once the beam's short travel window
    // finishes (see updateSecurityRobots()'s 'attack' case below), checking
    // the player's position AT THAT LATER MOMENT against this SAME fixed
    // muzzle->lockedTarget segment — giving a real window to step off the
    // line after the shot is visibly telegraphed and fired.
  }

  // SECTION L/M: resolves a fired laser's damage once its brief travel
  // window elapses — checks the player's position AT RESOLVE TIME against
  // the fixed muzzle->lockedTarget segment set at fire-time (never
  // re-aimed), so the player can dodge by moving off that line before this
  // fires, while a player who stays on it (or wanders back onto it) still
  // gets hit.
  function resolveSecurityLaserHit(robot, now) {
    // PART8 SECTION S: an Area-boundary WALL between the DRONE and the
    // player's position AT RESOLVE TIME blocks the beam entirely — a laser
    // is a ray/line-damage attack, not a travelling projectile, so there is
    // nothing to "vanish"; the hit simply never resolves.
    if (segmentCrossesAreaWall(robot.laserOriginX, robot.laserOriginY, player.x, player.y)) return;
    const dist = distanceToSegment(player.x, player.y, robot.laserOriginX, robot.laserOriginY, robot.laserEndX, robot.laserEndY);
    if (dist <= PLAYER_HIT_RADIUS) {
      // SECTION M: routes through the SAME shared damage choke-point and
      // the SAME existing normal-attack damage constant used elsewhere —
      // never a bypassing `player.life -=` or an invented damage number.
      applyDamageToPlayerLife(now, BULLET_DAMAGE);
    }
  }

  // SECTION E-4/N: applies FIRE damage to one DRONE — the ONE place its HP
  // ever decreases. On death: cancels any in-flight attack commitment
  // (releasing its attack slot if one was held — N/SECTION O's max-2 cap
  // must never leak a permanently-stuck slot), snaps its state to 'dead'
  // (every update/draw path below early-returns on hp<=0 or state==='dead'),
  // and spawns a lightweight canvas-only death burst (E-5 — no new image
  // assets, nothing borrowed from GABRIEL's own much larger dissolve system).
  function applyDamageToSecurityDrone(robot, now) {
    if (robot.hp <= 0) return;
    robot.hp = Math.max(0, robot.hp - BULLET_DAMAGE);
    if (robot.hp <= 0) {
      if (robot.state === 'attack') {
        // N-1: a laser already in flight when its DRONE dies never resolves
        // (its 'attack'-only draw/resolve checks below stop matching the
        // instant state flips to 'dead') — the shot is cancelled outright,
        // but the attack slot it was holding is still explicitly released
        // here so SECTION O's max-2 cap can never silently leak a slot.
        securityAttackSlotsInUse = Math.max(0, securityAttackSlotsInUse - 1);
      }
      robot.state = 'dead';
      // PART 4 SECTION E-5/F: death effect takes over instantly — no
      // hitFlashStartAt is set on this final hit, so there is no
      // damage-blink vs. death-visual race (drawSecurityRobot() also
      // early-returns on hp<=0 before ever reading hitFlashStartAt anyway).
      // SECTION F: reuses the SAME barrel-explosion VISUAL (via the shared
      // spawnExplosionVisual() both this and explodeBarrel() call) — never
      // the old bespoke spark burst. F-3: no options passed that would
      // apply damage/knockback to anything — spawnExplosionVisual() itself
      // only ever pushes cosmetic particles and (optionally) a screen
      // shake; it has no damage/knockback code path to opt out of.
      spawnExplosionVisual(robot.x, robot.y, now);
      // PART 5 SECTION O / PART 6 SECTION D: ONLY in the FINAL STAGE, this
      // same death-explosion also damages GABRIEL if it's within the
      // EXISTING boss-facing barrel-explosion radius — reusing
      // BARREL_DAMAGE_BOSS/BARREL_EXPLOSION_DAMAGE_RADIUS_BOSS verbatim
      // (O-2/O-3, never an invented value) and routing through the SAME
      // applyExplosionDamageToBoss() choke-point the barrel path already
      // uses (O-9: never a bypassing `boss.hp -=`) — which already fully
      // respects DEFENSE-bypass-but-DARK-PHASE/teleport/straightclaw/
      // cinematic-immunity exactly like barrels do (O-8, PART 6 D-2/D-3),
      // and never touches position/velocity, so there is inherently no
      // GABRIEL knockback (O-5), no player damage/knockback (O-6), and no
      // effect whatsoever on any OTHER drone (O-7/no chain-explosion).
      if (isFinalStoryStage() && boss.spawned &&
          Math.hypot(robot.x - boss.x, robot.y - boss.y) <= BARREL_EXPLOSION_DAMAGE_RADIUS_BOSS + BOSS_HURT_RADIUS) {
        // New-turn SECTION 4: FINAL-STAGE-only, halved from BARREL_DAMAGE_BOSS
        // (never that constant itself, which barrels still use unchanged).
        applyExplosionDamageToBoss(FINAL_STAGE_DRONE_EXPLOSION_BOSS_DAMAGE, now);
      }
      // PART8 SECTION H/I/J: the FINAL STAGE's own one-time 2nd wave, now
      // managed PER AREA — the instant every DRONE belonging to THIS SAME
      // Area (this one included, already hp<=0 above) is dead, and only
      // once per Area per STAGE attempt (finalDroneRespawnedByArea[area]),
      // spawn a fresh set of FINAL_DRONES_PER_AREA into that SAME Area only
      // (spawnFinalStageDronesForArea() appends, never touching the other
      // Area's own population/wave state). Guarded on GABRIEL not already
      // being dead/dying so a kill-GABRIEL-first run never spawns a
      // pointless extra wave after its own WIN condition has already fired.
      if (isFinalStoryStage() && boss.state !== 'dead' && boss.state !== 'dying') {
        const droneArea = robot.y < 0 ? 2 : 1; // areas never overlap in Y and a DRONE's row never changes area, so this is a stable, cheap area lookup
        if (!finalDroneRespawnedByArea[droneArea]) {
          const areaDrones = securityRobots.filter((r) => (r.y < 0 ? 2 : 1) === droneArea);
          if (areaDrones.length > 0 && areaDrones.every((r) => r.hp <= 0)) {
            finalDroneRespawnedByArea[droneArea] = true; // set synchronously before spawning below — guards against any same-frame re-entry ever double-spawning this Area's wave2
            spawnFinalStageDronesForArea(droneArea, true, now); // PART7 SECTION H/PART8 SECTION K: wave 2 falls in from above, reusing GABRIEL's own intro shadow+fall technique, landing in the SAME Area that was just cleared
          }
        }
      }
    } else {
      // SECTION E: a non-lethal hit starts this DRONE's own independent
      // blink — see drawSecurityRobot()'s use of hitFlashStartAt below.
      robot.hitFlashStartAt = now;
    }
  }

  // SECTION I: per-robot state machine — watching (patrols left/right,
  // shadow scans independently, checks shadow overlap) -> detected
  // (one-tick bookkeeping state, moves on to telegraph on the NEXT tick,
  // never the same frame, so it's independently observable) -> telegraph
  // (windup; locks the target exactly once at the end) -> attack (holds the
  // beam visually; damage resolves once the beam's travel window elapses,
  // not at fire-time — see resolveSecurityLaserHit()) -> cooldown
  // (per-robot, before returning to watching). Once a robot leaves
  // 'watching' it stops re-checking the shadow entirely until it returns to
  // 'watching' — this is what keeps standing in the same shadow every frame
  // from spamming infinite attack-requests (I-2, unchanged from PART 2).
  // PART 5 SECTION B: CENTER SCANNER's own center-stop movement branch —
  // patrol (normal left/right + scan ping-pong, identical to every other
  // TYPE) -> returningToCenter (walks back toward patrolCenterX) ->
  // centerScan (B-3: fully stationary, SOUTH sprite, B-4: scanSpeed slowed
  // ×CENTER_SCAN_SLOW_FACTOR, B-5: same shadow size/dimensions, untouched)
  // -> patrol (B-7: resumes facing WEST/EAST). Only ever called while NOT
  // lockedOn (see updateSecurityRobots() below) — a threat-state interrupt
  // simply freezes whatever moveState this robot was in, exactly like every
  // other TYPE's patrol already freezes on detection (B-8: the shadow/
  // detection/telegraph/laser state machine itself is entirely unaffected
  // by moveState and keeps running as normal in every branch below).
  function updateCenterScannerMovement(robot, dt) {
    switch (robot.moveState) {
      case 'returningToCenter': {
        const dx = robot.patrolCenterX - robot.x;
        const step = CENTER_SCAN_RETURN_SPEED * dt;
        if (Math.abs(dx) <= step) {
          robot.x = robot.patrolCenterX;
          robot.moveState = 'centerScan';
          robot.centerScanDurationMs = CENTER_SCAN_DURATION_MIN_MS + Math.random() * (CENTER_SCAN_DURATION_MAX_MS - CENTER_SCAN_DURATION_MIN_MS); // B-6: randomized, desynced per robot
          robot.centerScanRemainingMs = robot.centerScanDurationMs;
          robot.dir = 'south'; // B-3
        } else {
          robot.x += Math.sign(dx) * step;
          robot.dir = dx > 0 ? 'east' : 'west';
          robot.scanOffset += robot.scanDir * robot.scanSpeed * dt;
          if (robot.scanOffset >= robot.scanRange) { robot.scanOffset = robot.scanRange; robot.scanDir = -1; }
          else if (robot.scanOffset <= -robot.scanRange) { robot.scanOffset = -robot.scanRange; robot.scanDir = 1; }
        }
        break;
      }
      case 'centerScan': {
        robot.dir = 'south'; // B-3: fully stationary, SOUTH sprite
        const slowSpeed = robot.scanSpeed * CENTER_SCAN_SLOW_FACTOR; // B-4 (STAGE multiplier already folded into scanSpeed itself — J-4/L-4)
        robot.scanOffset += robot.scanDir * slowSpeed * dt; // B-5: scanRange/radii untouched — only the sweep speed slows
        if (robot.scanOffset >= robot.scanRange) { robot.scanOffset = robot.scanRange; robot.scanDir = -1; }
        else if (robot.scanOffset <= -robot.scanRange) { robot.scanOffset = -robot.scanRange; robot.scanDir = 1; }
        robot.centerScanRemainingMs -= dt * 1000;
        if (robot.centerScanRemainingMs <= 0) {
          robot.moveState = 'patrol'; // B-7
          robot.patrolDir = Math.random() < 0.5 ? 1 : -1;
          robot.dir = robot.patrolDir > 0 ? 'east' : 'west';
          robot.centerScanCooldownRemainingMs = CENTER_SCAN_COOLDOWN_MIN_MS + Math.random() * (CENTER_SCAN_COOLDOWN_MAX_MS - CENTER_SCAN_COOLDOWN_MIN_MS);
        }
        break;
      }
      default: { // 'patrol' — identical left/right + scan ping-pong as every other TYPE
        robot.x += robot.patrolDir * robot.patrolSpeed * dt;
        if (robot.x >= robot.patrolCenterX + robot.patrolRange) { robot.x = robot.patrolCenterX + robot.patrolRange; robot.patrolDir = -1; }
        else if (robot.x <= robot.patrolCenterX - robot.patrolRange) { robot.x = robot.patrolCenterX - robot.patrolRange; robot.patrolDir = 1; }
        robot.x = Math.max(SECURITY_ROBOT_DRAW_D, Math.min(W - SECURITY_ROBOT_DRAW_D, robot.x));
        robot.dir = robot.patrolDir > 0 ? 'east' : 'west';
        robot.scanOffset += robot.scanDir * robot.scanSpeed * dt;
        if (robot.scanOffset >= robot.scanRange) { robot.scanOffset = robot.scanRange; robot.scanDir = -1; }
        else if (robot.scanOffset <= -robot.scanRange) { robot.scanOffset = -robot.scanRange; robot.scanDir = 1; }
        robot.centerScanCooldownRemainingMs -= dt * 1000;
        if (robot.centerScanCooldownRemainingMs <= 0) robot.moveState = 'returningToCenter';
        break;
      }
    }
  }

  function updateSecurityRobots(dt, now) {
    if (!isSecurityDroneSystemActive()) return;
    for (const robot of securityRobots) {
      if (robot.hp <= 0) continue; // SECTION E-4: a dead DRONE does nothing at all — no movement, scan, detection, telegraph, or laser
      // PART7 SECTION H: while a wave-2 DRONE is still falling, none of its
      // normal AI (patrol/search/telegraph/laser) runs at all — it only
      // resolves the drop timer and, once elapsed, flips to 'active' so the
      // very next tick begins normal AI from a clean 'watching' state.
      if (robot.dropState === 'dropping') {
        if (now - robot.dropStartAt >= FINAL_DRONE_DROP_MS) {
          robot.dropState = 'active';
        }
        continue;
      }
      // SECTION F/M-4: the DRONE "locks on" and stops its own left/right
      // patrol the instant it notices the player (detected/telegraph/
      // attack), facing SOUTH toward them (F-7) — patrol (and its own
      // east/west sprite) resumes once it's back to watching/cooldown. The
      // SHADOW's independent scan (SECTION I-3) pauses the same way, so the
      // whole scene visibly "holds" on the moment of detection rather than
      // continuing to drift underneath it.
      const lockedOn = robot.state === 'detected' || robot.state === 'telegraph' || robot.state === 'attack';
      if (!lockedOn && robot.behaviorType === 'CENTER_SCANNER') {
        updateCenterScannerMovement(robot, dt);
      } else if (!lockedOn) {
        robot.x += robot.patrolDir * robot.patrolSpeed * dt;
        if (robot.x >= robot.patrolCenterX + robot.patrolRange) {
          robot.x = robot.patrolCenterX + robot.patrolRange;
          robot.patrolDir = -1;
        } else if (robot.x <= robot.patrolCenterX - robot.patrolRange) {
          robot.x = robot.patrolCenterX - robot.patrolRange;
          robot.patrolDir = 1;
        }
        robot.x = Math.max(SECURITY_ROBOT_DRAW_D, Math.min(W - SECURITY_ROBOT_DRAW_D, robot.x)); // F-5: hard world-bounds clamp, independent of patrolRange tuning
        robot.dir = robot.patrolDir > 0 ? 'east' : 'west'; // F-6

        robot.scanOffset += robot.scanDir * robot.scanSpeed * dt;
        if (robot.scanOffset >= robot.scanRange) { robot.scanOffset = robot.scanRange; robot.scanDir = -1; }
        else if (robot.scanOffset <= -robot.scanRange) { robot.scanOffset = -robot.scanRange; robot.scanDir = 1; }
      } else {
        robot.dir = 'south'; // F-7
      }
      switch (robot.state) {
        case 'watching': {
          if (isPlayerInSecurityShadow(robot)) {
            robot.state = 'detected';
          }
          break;
        }
        case 'detected': {
          robot.telegraphElapsedMs = 0;
          robot.state = 'telegraph';
          break;
        }
        case 'telegraph': {
          robot.telegraphElapsedMs += dt * 1000;
          if (robot.telegraphElapsedMs >= SECURITY_TELEGRAPH_MS) {
            robot.lockedTargetX = player.x; // SECTION J: locked ONCE, exactly at telegraph-end
            robot.lockedTargetY = player.y;
            if (securityAttackSlotsInUse < SECURITY_MAX_SIMULTANEOUS_ATTACKS) {
              securityAttackSlotsInUse++;
              robot.state = 'attack';
              fireSecurityLaser(robot, now);
            } else {
              // SECTION O: no free attack slot — fail safe back to watching
              // rather than queuing (never spam infinite attack-requests).
              robot.state = 'watching';
            }
          }
          break;
        }
        case 'attack': {
          robot.laserRemainingMs -= dt * 1000;
          if (robot.laserRemainingMs <= 0) {
            resolveSecurityLaserHit(robot, now); // SECTION M: hit-tested here, at beam-resolve time, not at fire-time — see resolveSecurityLaserHit()'s own comment
            securityAttackSlotsInUse = Math.max(0, securityAttackSlotsInUse - 1);
            robot.state = 'cooldown';
            robot.cooldownRemainingMs = SECURITY_LASER_COOLDOWN_MIN_MS + Math.random() * (SECURITY_LASER_COOLDOWN_MAX_MS - SECURITY_LASER_COOLDOWN_MIN_MS);
          }
          break;
        }
        case 'cooldown': {
          robot.cooldownRemainingMs -= dt * 1000;
          if (robot.cooldownRemainingMs <= 0) {
            robot.state = 'watching';
          }
          break;
        }
      }
    }
  }

  // SECTION H/L: the new searchlight SHADOW — a wide, short, soft-edged
  // oval/capsule (retiring PART 2's thin directional rectangle — SECTION G)
  // drawn from the SAME getSecurityShadowCenter()/radii the hitbox above
  // uses, so visual and hitbox can never disagree (L-1). PART 6 SECTION E:
  // recolored from dark/black to a translucent WHITE searchlight — shape/
  // size/blur are all otherwise completely unchanged (E-2/E-5); applies
  // identically to every DRONE in every mode/STAGE, including CENTER
  // SCANNER's own centerScan sweep (SECTION G — never a separate color for
  // that TYPE).
  function drawSecurityShadow(robot) {
    if (robot.hp <= 0) return; // E-4: dead DRONEs cast no shadow
    if (robot.dropState === 'dropping') return; // PART7 SECTION H: no searchlight while still falling — matches no AI running yet
    const c = getSecurityShadowCenter(robot);
    ctx.save();
    ctx.filter = 'blur(3px)';
    ctx.globalAlpha = (robot.state === 'detected' || robot.state === 'telegraph' || robot.state === 'attack') ? 0.75 : 0.6;
    ctx.fillStyle = 'rgba(255,255,255,1)'; // PART 6 SECTION E-3/E-4: white base tone, translucency via globalAlpha (~0.6-0.75, within the suggested 0.55-0.70 band at rest)
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, SECURITY_SHADOW_RADIUS_X, SECURITY_SHADOW_RADIUS_Y, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSecurityRobot(robot, now) {
    if (robot.hp <= 0) return; // E-4/E-5: dead DRONEs stop drawing entirely — the death explosion (spawnExplosionVisual()) takes over instead, so there is no blink-vs-death competition
    const img = securityRobotImgs[robot.dir];
    const m = SECURITY_ROBOT_METRICS[robot.dir];
    if (!img.complete || img.naturalWidth === 0) return;
    // PART7 SECTION H: wave-2 drop-in — same growing/darkening ground-shadow
    // + ease-in fall (fallT = t*t) technique as drawBossIntro()'s own
    // SILENCE_END..SHADOW_END phase, applied to this one DRONE's existing
    // sprite/metrics (no new image, no separate cinematic state machine).
    if (robot.dropState === 'dropping') {
      const t = Math.max(0, Math.min(1, (now - robot.dropStartAt) / FINAL_DRONE_DROP_MS));
      const shadowT = Math.min(1, t * 1.15);
      ctx.save();
      ctx.globalAlpha = 0.4 * shadowT;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(robot.x, robot.y, m.drawW * 0.32 * shadowT, m.drawW * 0.32 * shadowT * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      const fallT = t * t;
      const restDrawY = robot.y - m.drawH / 2;
      const startDrawY = restDrawY - H * 0.5 - m.drawH;
      const drawY = startDrawY + (restDrawY - startDrawY) * fallT;
      ctx.drawImage(img, robot.x - m.drawW / 2, drawY, m.drawW, m.drawH);
      return;
    }
    const dx = robot.x - m.drawW / 2, dy = robot.y - m.drawH / 2;
    // PART 4 SECTION E: independent per-DRONE damage-blink — same on/off-
    // segment pattern as GABRIEL's own damage blink, reusing the exact
    // same generic drawBossWithHitTint() compositing helper (E-1/E-2).
    const blinkElapsed = now - robot.hitFlashStartAt;
    if (blinkElapsed >= 0 && blinkElapsed < SECURITY_DRONE_HIT_BLINK_TOTAL_MS) {
      const segment = Math.floor(blinkElapsed / SECURITY_DRONE_HIT_TINT_MS);
      if (segment % 2 === 0) {
        const tWithinHalf = 1 - (blinkElapsed % SECURITY_DRONE_HIT_TINT_MS) / SECURITY_DRONE_HIT_TINT_MS;
        drawBossWithHitTint(img, dx, dy, m.drawW, m.drawH, tWithinHalf);
      } else {
        ctx.drawImage(img, dx, dy, m.drawW, m.drawH);
      }
    } else {
      ctx.drawImage(img, dx, dy, m.drawW, m.drawH);
    }
    // SECTION J: telegraph-only core emphasis — a canvas-drawn radial glow
    // layered on top of the untouched source image, never a regenerated/
    // re-edited asset.
    if (robot.state === 'telegraph') {
      ctx.save();
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 60);
      ctx.globalAlpha = 0.35 + 0.25 * pulse;
      const grad = ctx.createRadialGradient(robot.x, robot.y, 0, robot.x, robot.y, m.drawW * 0.45);
      grad.addColorStop(0, 'rgba(255,70,50,0.9)');
      grad.addColorStop(1, 'rgba(255,70,50,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(robot.x, robot.y, m.drawW * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // SECTION M: straight-line beam from the exact muzzle origin to the exact
  // locked target — the SAME two points fireSecurityLaser() already used
  // for the damage hitbox, so visual and hitbox can never disagree. Fades
  // out over its short cosmetic display window rather than cutting off.
  function drawSecurityLaserBeam(robot) {
    if (robot.hp <= 0 || robot.state !== 'attack') return; // N: a DRONE killed mid-attack stops drawing its own in-flight beam immediately
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, robot.laserRemainingMs / SECURITY_LASER_VISUAL_MS));
    ctx.strokeStyle = 'rgba(255,60,50,0.9)';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(255,60,50,0.6)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(robot.laserOriginX, robot.laserOriginY);
    ctx.lineTo(robot.laserEndX, robot.laserEndY);
    ctx.stroke();
    ctx.restore();
  }

  // ================= END PART 2 SECURITY ROBOT logic =================

  function drawBarrel(b) {
    if (!barrelImg.complete || barrelImg.naturalWidth === 0) return;
    const aspect = barrelImg.naturalWidth / barrelImg.naturalHeight;
    const h = BARREL_DRAW_H, w = h * aspect;
    if (b.falling) {
      const t = Math.min(1, (b.fallElapsedMs || 0) / BARREL_FALL_MS);
      const et = t * t; // accelerating, gravity-like
      const dropY = -(1 - et) * BARREL_FALL_HEIGHT;
      const shadowT = et; // shadow grows/darkens as it nears the ground
      ctx.save();
      ctx.globalAlpha = 0.35 * shadowT;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(b.landX, b.landY + h * 0.42, w * 0.32 * shadowT, w * 0.32 * shadowT * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.drawImage(barrelImg, b.x - w / 2, b.y + dropY - h / 2, w, h);
      return;
    }
    ctx.drawImage(barrelImg, b.x - w / 2, b.y - h / 2, w, h);
  }

  // Small, brief dust puff at a freshly-landed barrel's feet — deliberately
  // much smaller/quieter than drawExplosion()'s fireball, per spec ("not as
  // flashy as an explosion").
  const BARREL_LANDING_MS = 260;
  function drawBarrelLanding(l, now) {
    const t = (now - l.startAt) / BARREL_LANDING_MS;
    if (t >= 1) return;
    ctx.save();
    ctx.globalAlpha = 0.5 * (1 - t);
    ctx.fillStyle = 'rgba(210,205,195,0.8)';
    const r = BARREL_DRAW_H * (0.25 + t * 0.35);
    ctx.beginPath();
    ctx.ellipse(l.x, l.y + BARREL_DRAW_H * 0.3, r, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Three overlapping phases, all canvas-drawn (no image assets): a sharp
  // white/yellow flash (0-100ms), a growing orange/red fireball built from
  // several offset irregular blobs rather than one perfect circle
  // (~80-340ms), and sparks/debris/smoke that fly outward and decay
  // (through ~600ms). The damage radius (BARREL_EXPLOSION_RADIUS, 300px) is
  // intentionally much larger than anything drawn here — this is a stage
  // effect sized to read as "big", not a literal hitbox outline.
  function drawExplosion(e, now) {
    const t = Math.max(0, now - e.startAt); // guards a rare same-frame startAt>now race from ever producing a negative gradient radius below
    if (t >= EXPLOSION_DURATION_MS) return;
    ctx.save();
    ctx.translate(e.x, e.y);

    // Phase 1: strong white-yellow flash, sharp and brief.
    if (t < 100) {
      const ft = t / 100;
      const r = 16 + ft * 78;
      const alpha = 1 - ft * 0.25;
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      grad.addColorStop(0, `rgba(255,255,245,${alpha})`);
      grad.addColorStop(0.5, `rgba(255,238,150,${alpha * 0.9})`);
      grad.addColorStop(1, `rgba(255,200,80,0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Phase 2: orange/red fireball — a main blob plus a few smaller offset
    // blobs (fixed angles, so no per-frame jitter) for an irregular silhouette.
    if (t > 60 && t < 340) {
      const ft = Math.min(1, (t - 60) / 280);
      const baseR = 22 + ft * 74;
      const alpha = 1 - ft * 0.85;
      const mainGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, baseR);
      mainGrad.addColorStop(0, `rgba(255,230,150,${alpha})`);
      mainGrad.addColorStop(0.4, `rgba(255,140,40,${alpha * 0.85})`);
      mainGrad.addColorStop(1, `rgba(180,30,10,0)`);
      ctx.fillStyle = mainGrad;
      ctx.beginPath();
      ctx.arc(0, 0, baseR, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.4;
        const dist = baseR * 0.4;
        const bx = Math.cos(a) * dist, by = Math.sin(a) * dist;
        const br = baseR * 0.5;
        const grad2 = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        grad2.addColorStop(0, `rgba(255,175,85,${alpha * 0.8})`);
        grad2.addColorStop(1, `rgba(200,60,20,0)`);
        ctx.fillStyle = grad2;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Phase 3: sparks (fast/bright/short), metal debris (tumbling squares),
    // smoke (slow soft puffs, fades in late and lingers to the very end).
    const tSec = t / 1000;
    for (const p of e.particles) {
      const dx = Math.cos(p.angle) * p.speed * tSec;
      const dy = Math.sin(p.angle) * p.speed * tSec;
      if (p.type === 'spark') {
        if (t > 260) continue;
        const alpha = Math.max(0, 1 - t / 260);
        ctx.fillStyle = `rgba(255,235,180,${alpha})`;
        ctx.beginPath();
        ctx.arc(dx, dy, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === 'debris') {
        if (t < 40 || t > 480) continue;
        const lt = (t - 40) / 440;
        const alpha = Math.max(0, 1 - lt);
        ctx.save();
        ctx.translate(dx, dy);
        ctx.rotate(p.spin * lt);
        ctx.fillStyle = `rgba(90,90,96,${alpha})`;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      } else {
        if (t < 150) continue;
        const lt = Math.min(1, (t - 150) / 450);
        const alpha = (1 - lt) * 0.35;
        const r = p.size * (0.6 + lt * 1.2);
        ctx.fillStyle = `rgba(70,70,74,${alpha})`;
        ctx.beginPath();
        ctx.arc(dx, dy - lt * 18, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // Deliberately still checks neither DEFENSE nor the (now-legacy)
  // boss.invulnerableUntil — barrel explosions have always bypassed DEFENSE
  // outright. DARK PHASE is the one exception: total invulnerability, no
  // damage source bypasses it, per spec.
  function applyExplosionDamageToBoss(amount, now) {
    if (!boss.spawned || bossIsInCinematic() || boss.state === 'darkphase' || boss.state === 'teleport' || boss.state === 'straightclaw') return;
    if (boss.hp <= 0) return; // already at 0 — no further reduction possible, so no flash either
    boss.hp = Math.max(0, boss.hp - amount);
    // PART 6: barrel explosions are an HP-reducing source too — the unified
    // hit-flash must cover them exactly like every other damage path above.
    bossDamageBlinkStartAt = now;
    checkBossHpMilestones(now);
  }

  // ---------- AUTO AIM ----------
  // Manual AIM STICK aiming is always available; when the reticle (driven
  // by the raw stick angle) comes within AUTO_AIM_RADIUS of a targetable
  // object's target point, the effective aim is pulled a fraction of the
  // way toward that point each frame (a gentle, releasable magnet, not a
  // hard lock), and only while the player is actively holding the AIM
  // STICK near it — never automatically without stick input. PART 9: the
  // pull is a free 360deg blend now (shortest angular path), no longer
  // clamped into any wedge around baseDir.
  const AUTO_AIM_RADIUS = 46; // screen px, around the reticle tip
  const AUTO_AIM_SNAP_STRENGTH = 0.35; // fraction of remaining angle closed per frame
  let autoAimActive = false;
  let autoAimTargetIsBoss = false; // true when the current snap target is the boss (weak point or body), not a barrel

  function getAutoAimTargetPoint() {
    // No lock-on target at all during any cinematic (intro/threshold/dying)
    // or once truly dead — bossIsInCinematic() covers all four. TELEPORT
    // (PART 7) is the same: GABRIEL isn't visually present, so there's
    // nothing for AUTO AIM to snap onto until it reappears. SECTION I:
    // 'straightclaw' (COUNTER) is now allowed to fall through to the
    // ordinary body-target branch below — this is the FLASH-cancel target,
    // and I-2 explicitly asks for the same AUTO LOCK assist there too, not
    // just DEFENSE/DARK PHASE. isAimingAtBoss()'s own raw-ray check for
    // this state is unaffected either way — the magnet only makes it
    // easier to line up, never bypasses that check.
    if (boss.spawned && (bossIsInCinematic() || boss.state === 'teleport')) return { primary: null, secondary: null };
    // DEFENSE: the forehead weak point takes priority over the body — only
    // fall back to the body center if the weak point itself isn't in range
    // (or doesn't exist at all for the current defenseDir, e.g. NORTH).
    if (boss.spawned && boss.state === 'defense') {
      const wp = getWeakPointScreenPos(boss.defenseDir);
      return { primary: wp, secondary: { x: boss.x, y: boss.y } };
    }
    // PART 18: DARK PHASE's AUTO AIM magnet now pulls toward the SAME
    // getDarkPhaseHeadScreenPos() anchor everything else (drawing, the
    // FLASH hit-test) already shares — previously this fell through to the
    // boss.x/boss.y branch below, a different point entirely (GABRIEL's own
    // body position, not the head, which is why the magnet used to visibly
    // pull the reticle toward the wrong spot during DARK PHASE).
    if (boss.spawned && boss.state === 'darkphase') {
      // SECTION C: no magnet target at all while fully hidden.
      if (isDarkPhaseHidden()) return { primary: null, secondary: null };
      return { primary: getDarkPhaseHeadScreenPos(), secondary: null };
    }
    if (boss.spawned && boss.state !== 'dead') {
      return { primary: { x: boss.x, y: boss.y }, secondary: null };
    }
    return { primary: null, secondary: null };
  }

  function updateAutoAim(now) {
    if (now < aimDoubleTapLockUntil) {
      // A double-tap nearest-target snap is locked in — keep showing the
      // snapped angle (and its red-reticle feedback) exactly as set,
      // rather than recomputing anything from the (possibly released) stick.
      autoAimActive = true;
      autoAimTargetIsBoss = aimDoubleTapTargetIsBoss;
      autoAimLockedPoint = aimDoubleTapTargetPoint; // captured once, at the moment of the double-tap — see performNearestAutoAimSnap()
      return;
    }
    autoAimActive = false;
    autoAimTargetIsBoss = false;
    autoAimLockedPoint = null;
    if (!aimStickActive) {
      player.aimOffset = player.aimOffsetRaw;
      return;
    }

    const rawAngle = player.aimOffsetRaw; // absolute — see the player.aimOffsetRaw field comment
    const mx = player.x + Math.cos(rawAngle) * MUZZLE_DIST;
    const my = player.y + Math.sin(rawAngle) * MUZZLE_DIST;
    const tipX = mx + Math.cos(rawAngle) * AIM_LINE_LEN;
    const tipY = my + Math.sin(rawAngle) * AIM_LINE_LEN;

    let best = null, bestDist = AUTO_AIM_RADIUS, bestIsBoss = false;
    const bossTargets = getAutoAimTargetPoint();
    // Strict priority: try the weak point (primary) first; only fall back to
    // the body (secondary) if primary doesn't win — either because it's out
    // of range, or because it doesn't exist at all for the current
    // defenseDir (e.g. NORTH), in which case primary is null and this
    // fallback is the ONLY way DEFENSE can be AUTO-AIM-targeted at all.
    // PART8 SECTION Q: an Area-boundary WALL between the player and a
    // candidate blocks AUTO AIM from ever snapping onto it — checked from
    // the player's own position (not the reticle tip), matching the spec's
    // "playerとenemyの間にArea境界wallが存在する場合".
    if (bossTargets.primary && !segmentCrossesAreaWall(player.x, player.y, bossTargets.primary.x, bossTargets.primary.y)) {
      const d = Math.hypot(tipX - bossTargets.primary.x, tipY - bossTargets.primary.y);
      if (d < bestDist) { bestDist = d; best = bossTargets.primary; bestIsBoss = true; }
    }
    if (!best && bossTargets.secondary && !segmentCrossesAreaWall(player.x, player.y, bossTargets.secondary.x, bossTargets.secondary.y)) {
      const d = Math.hypot(tipX - bossTargets.secondary.x, tipY - bossTargets.secondary.y);
      if (d < bestDist) { bestDist = d; best = bossTargets.secondary; bestIsBoss = true; }
    }
    for (const b of barrels) {
      if (!b.alive) continue;
      if (segmentCrossesAreaWall(player.x, player.y, b.x, b.y)) continue;
      const d = Math.hypot(tipX - b.x, tipY - b.y);
      if (d < bestDist) { bestDist = d; best = { x: b.x, y: b.y }; bestIsBoss = false; }
    }

    if (best) {
      const desiredAngle = Math.atan2(best.y - my, best.x - mx);
      // Shortest angular path from the current effective aim to the
      // target's true bearing — no wedge clamp anymore (PART 9).
      const TWO_PI = Math.PI * 2;
      let diff = desiredAngle - player.aimOffset;
      diff = ((diff + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
      player.aimOffset += diff * AUTO_AIM_SNAP_STRENGTH;
      autoAimActive = true;
      autoAimTargetIsBoss = bestIsBoss;
      autoAimLockedPoint = best;
    } else {
      player.aimOffset = player.aimOffsetRaw;
    }
  }

  // ---------- Mode select / PAUSE ----------
  // Resets everything that belongs to "a run" — nothing from the previous
  // mode (bullets, claw projectiles, explosions, boss state/HP, barrels,
  // DASH state) is allowed to survive into the next one.
  // SECTION J (this turn): `preserveStoryProgress` — when true, skips the
  // currentStageIndex/bossEncounterIndex reset below so GAME OVER's own
  // RETRY (see retryCurrentRun()) re-initializes the SAME STORY STAGE the
  // player just died on, rather than jumping back to STAGE 1 the way a
  // genuine RESTART/mode-switch (which always passes no argument, i.e.
  // false) still correctly does. Every other reset below (LIFE/position/
  // camera/AREA/DRONE-or-GABRIEL re-init/BARREL/projectile/STUN/control-
  // recovery) is identical either way — RETRY's own J-3 requirement list is
  // just this same existing reset, unconditionally.
  function resetModeState(preserveStoryProgress) {
    resetPlayerToBattlePose(); // SECTION H: BOSS mode starts directly at the intro pose; TRAINING mode keeps the screen-center default
    player.dashing = false;
    player.knockbackUntil = 0;
    player.lastActivityAt = performance.now();
    player.relaxed = false;
    player.ammo = FIRE_MAG_SIZE;
    player.ammoCooldownRemainingMs = 0;
    player.reloadType = null; // PART8 SECTION AI: no stale reload type left over across GAME OVER/RETRY/stage-start/mode-reset/TOP
    healItem.active = false; // PART7 SECTION W: cleared unconditionally here — the 'boss' branch below re-arms it fresh via enterStoryStage()'s own spawnHealItem() call; TRAINING/BASIC modes simply never re-arm it, so no leftover STORY item can ever show up there

    bullets.length = 0;
    arcClawSlashes.length = 0;
    explosions.length = 0;

    boss.spawned = false;
    boss.state = 'inactive';
    boss.hp = BOSS_HP_MAX;
    boss.attackType = 'blade';
    boss.lastAttackType = 'blade';
    boss.darkPhaseAttackTimer = 0;
    boss.darkPhaseSubState = 'attacking'; // matches the object literal's own default placeholder
    boss.darkPhaseClawsFiredCount = 0;
    darkPhaseOverlayAlpha = 0; // RESTART snaps the dark overlay off instantly — no lingering fade
    boss.closeRangeInvulnUntil = 0;
    boss.teleportElapsed = 0;
    boss.teleportDest = null;
    teleportBlackoutAlpha = 0; // RESTART snaps the WEAK-POINT-SPAM teleport blackout off instantly too
    encounter3StunFlashRemainingMs = 0; // SECTION J: RESTART/mode switch snaps this off instantly too
    boss.lastKnownPlayerX = 0;
    boss.lastKnownPlayerY = 0;
    boss.revealedShotX = null;
    boss.revealedShotY = null;
    boss.consecutiveGuardedShots = 0; // STRAIGHT CLAW guard counter — explicit RESTART reset (A-4)
    boss.straightClawHitSpawned = false;
    boss.counterDir = 'south';
    boss.counterAttackKind = 'arcClaw';
    boss.isDefenseCounter = false; // New-turn SECTION 17: explicit RESTART/RETRY reset — boss.state is already forced away from 'straightclaw' just above/below, so this has no observable effect on its own, but is reset explicitly per this turn's spec rather than relying only on the next real 'straightclaw' entry's own bossEnterState() reset
    player.lastCounterDamage = 0;
    player.life = playerMaxLife; // SECTION E/I: applied at game start, per spec — reads the SAME setting SETTING/PAUSE MENU both write
    player.stunned = false; // SECTION C: RESTART/mode switch always starts un-stunned
    lastPlayerInputAt = performance.now(); // SECTION B: fresh grace period for the watchdog on every new run
    resetStealth(); // RESTART/mode switch ends STEALTH and its cooldown outright — the only two things allowed to (PART 21)

    // Stage world/camera/EXIT (PART 21-29) — a RESTART or mode switch always
    // returns to the first/default stage with the world fully closed back up;
    // RETRY (preserveStoryProgress===true) is the one exception (SECTION J).
    if (!preserveStoryProgress) {
      currentStageIndex = 0;
      bossEncounterIndex = 0; // PART 5 SECTION Q: fresh per STORY run, same as currentStageIndex
    }
    cameraY = 0;
    stageTransition.active = false;
    stageTransition.phase = null;
    // SECTION C: RESTART/mode switch always returns to AREA 1, fully closed
    // back up (C-28).
    currentArea = 1;
    area1Cleared = false;
    area2Cleared = false;

    barrelLandings.length = 0;
    barrelRestockPending = false;
    barrelRestockRemainingMs = 0;
    resetFlashGrenade();

    // SECTION B/D/Q (PART 2)/PART 5 SECTION T: SECURITY TRAINING picks a
    // fresh background and fully re-spawns its robots (positions/
    // directions/state/behavior profiles/cooldowns) on every session start
    // AND every RESTART — never carried over from a previous run. STORY
    // MODE always restarts at STORY_STAGE_PLAN[0] (always a DRONE-type
    // STAGE under the fixed plan) via the SAME plan-aware enterStoryStage()
    // the stage-transition advance uses (SECTION T's own "one central
    // implementation" requirement) — it handles its own barrels/DRONEs/
    // GABRIEL spawn. BASIC TRAINING keeps the existing BARREL_COUNT (5) and
    // never touches securityRobots at all (G-1/G-2/PART3 SECTION S).
    if (gameState.mode === 'securityTraining') {
      securityTrainingBgIndex = Math.floor(Math.random() * TRAINING_BACKGROUNDS.length);
      spawnBarrels(0);
      spawnSecurityRobots();
    } else if (gameState.mode === 'boss') {
      securityRobots.length = 0;
      securityAttackSlotsInUse = 0;
      enterStoryStage(performance.now());
    } else if (gameState.mode === 'bossBattle') {
      // DARK OUT PART 3: a dedicated branch, NOT a reuse of the 'boss'
      // branch above — enterStoryStage() reads/writes STORY-only state
      // (currentStageIndex/bossEncounterIndex/STORY_STAGE_PLAN), which this
      // mode must never touch (section 19). enterBossBattleStage() below
      // spawns GABRIEL directly, keyed only by bossBattleState.stageId.
      securityRobots.length = 0;
      securityAttackSlotsInUse = 0;
      enterBossBattleStage();
    } else {
      spawnBarrels(BARREL_COUNT);
      securityRobots.length = 0;
      securityAttackSlotsInUse = 0;
    }
  }

  // DARK OUT PART 3: the 'bossBattle' equivalent of enterStoryStage() above
  // — deliberately separate (never a shared function with an added `if`)
  // since the two must stay independent: this one NEVER reads/writes
  // currentStageIndex/bossEncounterIndex/STORY_STAGE_PLAN, and always spawns
  // whichever BOSS_BATTLE_TARGETS entry bossBattleState.target names (today,
  // only GABRIEL is playable — see section 10-14). Barrels are intentionally
  // 0 here (spec left this unspecified for BOSS BATTLE MODE; zero is the
  // simplest, safest choice, documented in the completion report) — never
  // BOSS_ENCOUNTER_BARREL_COUNTS, which is bossEncounterIndex-indexed STORY
  // data this mode must not read.
  function enterBossBattleStage() {
    bullets.length = 0; arcClawSlashes.length = 0; explosions.length = 0;
    spawnBarrels(0);
    bossBattleState.defeatHandled = false;
    if (bossBattleState.target === 'gabriel') {
      spawnBoss(performance.now());
    }
  }

  function startMode(mode) {
    gameState.mode = mode;
    // DARK OUT PART 3 SECTION 19: BOSS BATTLE MODE must never reset (or, via
    // RESTART re-entering here with mode==='bossBattle', ever touch) STORY's
    // own currentStageIndex/bossEncounterIndex — passing true reuses the
    // EXACT SAME "leave STORY position alone" branch RETRY already relies on
    // (see retryCurrentRun()), rather than a second implementation. This is
    // a no-op for every existing mode: 'boss'/'training'/'securityTraining'
    // are never 'bossBattle', so they still get preserveStoryProgress=false
    // (identical to the previous no-argument call) and behave byte-for-byte
    // as before.
    resetModeState(mode === 'bossBattle');
    gameState.paused = false;
    hideModeMenu();
    setScreen('gameplay'); // SECTION I/J: MAIN MENU's STORY/TRAINING buttons both route through here — a no-op change if already in gameplay (PAUSE's own mode-switch/RESTART)
    if (mode === 'boss') {
      // SECTION Q: fresh RESULT stats for every genuinely new STORY run —
      // RESTART counts as a new attempt too, so it resets these the same
      // way. TRAINING MODE has no RESULT screen and never touches these.
      storyStartTime = performance.now();
      storyPausedAccumMs = 0;
      shotsFired = 0; shotsHit = 0; totalDamageTaken = 0;
    }
  }

  // DARK OUT PART 3 SECTION 2/7/10: entry point for BOSS SELECT's own
  // target buttons. Locked targets (playable:false) do nothing at all —
  // section 4/28's own explicit "never start an unfinished battle, never
  // crash, never fall through to some other mode" requirement — never a
  // paywall/purchase check (section 5: no monetization this PART).
  function startBossBattle(targetKey) {
    const target = BOSS_BATTLE_TARGETS[targetKey];
    if (!target || !target.playable) return;
    bossBattleState.target = targetKey;
    bossBattleState.stageId = target.stageId;
    bossBattleState.active = true;
    startMode('bossBattle'); // reuses the SAME resetModeState()/setScreen('gameplay') path STORY/TRAINING already use; sets gameState.mode itself
  }

  // DARK OUT PART 3 SECTION 15/20: the ONE place a BOSS BATTLE MODE fight
  // ever ends — called on the post-defeat timer (triggerBossBattleDefeat()
  // below), PAUSE MENU QUIT, and GAME OVER QUIT, so cleanup is identical
  // regardless of which of the three ways the player leaves. Never touches
  // STORY's own currentStageIndex/bossEncounterIndex/scenario/item state —
  // this function doesn't reference any of them.
  function exitBossBattle() {
    bossBattleState.active = false;
    bossBattleState.target = null;
    bossBattleState.stageId = null;
    bossBattleState.defeatHandled = false;
    bossBattleDefeatRemainingMs = 0;
    boss.spawned = false;
    boss.state = 'inactive';
    bullets.length = 0;
    arcClawSlashes.length = 0;
    explosions.length = 0;
    securityRobots.length = 0;
    securityAttackSlotsInUse = 0;
    healItem.active = false;
    resetFlashGrenade();
    resetStealth();
    cameraY = 0;
    currentArea = 1;
    area1Cleared = false;
    area2Cleared = false;
    stageTransition.active = false;
    stageTransition.phase = null;
    player.stunned = false;
    recoverControlState();
    updateStunVisuals();
  }

  // DARK OUT PART 3 SECTION 16: GABRIEL's defeat inside BOSS BATTLE MODE
  // never reuses triggerGameClear()/enterResultScreen() (STORY-only — wrong
  // "THANK YOU FOR PLAYING"/ARTIST PAGE copy, wrong BACK destination, and
  // keyed off storyStartTime/shotsFired stats this mode never resets) — the
  // spec's own documented fallback is a brief "BOSS DEFEATED" hold (drawn
  // near the existing "GAME CLEAR!!" overlay) then straight back to BOSS
  // SELECT. Guarded by bossBattleState.defeatHandled so this can only ever
  // fire once per fight.
  function triggerBossBattleDefeat(now) {
    bossBattleState.defeatHandled = true;
    bossBattleDefeatRemainingMs = BOSS_BATTLE_DEFEAT_DISPLAY_MS;
  }

  function releaseAllHeldInputs() {
    // So nothing stays "stuck held" across a pause and fires the instant
    // the game resumes.
    fireHeld = false;
    fireButton.classList.remove('active');
    dashButton.classList.remove('active');
    actionStickReset();
    aimStickReset();
  }

  // SECTION B/I: a low-level input-state normalizer, DELIBERATELY separate
  // from the STUN game mechanic itself — this function NEVER reads or
  // writes player.stunned. It's called from two independent places: (1)
  // the CONTROL WATCHDOG below, right before it hands off to triggerStun()
  // when it either times out on player silence or catches an actual
  // internal-state contradiction, and (2) the PAUSE MENU's own "Reboot The
  // Control Pannel" click handler. Per SECTION I's own explicit
  // requirement, merely calling this must never by itself clear STUN —
  // only the two triggerStun()/reboot call sites ever touch player.stunned.
  function recoverControlState() {
    actionStickReset(); // B-4: MOVE stick neutral + movement vector zero
    aimDoubleTapLockUntil = 0; // force aimStickReset() below to take its "not locked" branch, so AIM truly goes neutral regardless of a live double-tap lock
    aimStickReset(); // B-4: AIM stick neutral, aimStickActive false, RANGE guide hidden
    fireHeld = false; // B-4: FIRE held state cleared
    fireButton.classList.remove('active');
    keys.fire = false; // keyboard test-fallback FIRE, same reasoning
    dashButton.classList.remove('active'); // B-4: DASH buffered/pressed visual state cleared
    // FLASH/STEALTH have no persistent "held" flag to clear (both are
    // momentary presses gated purely by their own cooldown timers, which
    // already re-evaluate every frame — B-4's "control disabled状態の
    // 再評価" is naturally satisfied by that existing per-frame tick, e.g.
    // updateFireHud()/the FLASH+STEALTH ring updates elsewhere in draw()).
  }

  // SECTION B-2/C-3 item 2: a cheap, defensive invariant check — NOT a fix
  // for any bug actually reproduced during this turn's investigation (see
  // SECTION A's own findings), but a guard against a genuinely corrupted
  // internal state (e.g. a future regression) that recoverControlState()
  // above can safely normalize. Each condition below checks for a
  // combination that can never legitimately occur through normal input.
  function detectControlStateCorruption() {
    // A nonzero MOVE STICK vector can only ever come from an actual held
    // touch/mouse-down on it (see handleActionStickMove()) — never
    // legitimate with no owning touch identifier.
    if ((actionStickVec.x !== 0 || actionStickVec.y !== 0) && actionStickTouchId === null) return true;
    // aimStickActive can only legitimately be true while an actual
    // touch/mouse is down on the AIM STICK, or while a double-tap snap is
    // still locked in (aimStickReset()'s own carve-out) — anything else is
    // a stuck flag.
    if (aimStickActive && aimStickTouchId === null && !aimStickMouseDown && performance.now() >= aimDoubleTapLockUntil) return true;
    return false;
  }

  // SECTION C/I: the ONLY function that ever sets player.stunned = true —
  // called from the CONTROL WATCHDOG (idle timeout or detected corruption)
  // and from the ENCOUNTER 3 DARK-PHASE-entry forced trigger (SECTION J).
  // Always normalizes the raw input state first (recoverControlState()) so
  // STUN always begins from a clean slate, regardless of what triggered it.
  function triggerStun(now) {
    recoverControlState();
    player.stunned = true;
    updateStunVisuals();
  }

  const pauseButtonEl = document.getElementById('pause-button');
  const controlBlackoutOverlay = document.getElementById('control-blackout-overlay');
  // SECTION E/F: reflects player.stunned into the DOM — called every frame
  // from update() (so it stays live during normal gameplay) and also
  // explicitly right after every place player.stunned changes outside of
  // update()'s own tick (triggerStun() above, and the REBOOT handler below,
  // which fires while gameState.paused is true and update() isn't running
  // at all).
  function updateStunVisuals() {
    controlBlackoutOverlay.hidden = !player.stunned; // E-1: never removed from the DOM, just hidden/shown
    pauseButtonEl.classList.toggle('stunned', player.stunned); // SECTION F
  }

  const modeMenu = document.getElementById('mode-menu');
  const modeRebootBtn = document.getElementById('mode-reboot-btn');
  function showModeMenu() {
    modeMenu.classList.add('open');
    // SECTION G-3: hidden whenever NOT currently stunned — only ever shown
    // (bottom-most, per G-2's markup order) while player.stunned is true.
    modeRebootBtn.hidden = !player.stunned;
  }
  function hideModeMenu() {
    modeMenu.classList.remove('open');
    closeSettingPanel(); // always resets back to the main PAUSE panel for next time it opens
  }

  function pausePress(e) {
    e.preventDefault();
    gameState.paused = true;
    pauseStartedAt = performance.now(); // SECTION Q-1: PLAY TIME excludes real time spent paused
    releaseAllHeldInputs();
    showModeMenu();
  }
  const pauseZone = document.getElementById('pause-zone');
  pauseZone.addEventListener('touchstart', pausePress, { passive: false });
  pauseZone.addEventListener('mousedown', pausePress);

  // SECTION A: auto-PAUSE on any app/tab/screen interruption — reuses the
  // EXACT same PAUSE state (gameState.paused/pauseStartedAt/showModeMenu())
  // pausePress() itself sets, never a parallel pause system. Gated to only
  // ever fire during genuine active gameplay (A-2): screen!=='gameplay'
  // already rules out LOADING/OPENING/MAIN MENU/SETTING/GAME OVER/RESULT
  // (each is its own distinct gameState.screen value); gameState.paused
  // rules out double-triggering while already paused; isLandscapeBlocked()
  // and gameClearRemainingMs>0 are checked explicitly since BOTH keep
  // gameState.screen === 'gameplay' (landscape-block freezes update()/
  // draw() via loop()'s own guard without changing screen; GAME CLEAR is a
  // canvas overlay drawn while screen is still 'gameplay', only becoming
  // 'result' once its own timer finishes — see triggerGameClear()).
  function autoPauseOnInterruption() {
    releaseAllHeldInputs(); // existing stuck-input safety net (PART 3) — always runs regardless of screen
    if (gameState.screen !== 'gameplay') return;
    if (gameState.paused) return;
    if (isLandscapeBlocked()) return;
    if (gameClearRemainingMs > 0) return;
    gameState.paused = true;
    pauseStartedAt = performance.now(); // SECTION Q-1, same as pausePress()
    showModeMenu();
  }
  // A-1: visibilitychange (backgrounding the tab/app, screen lock) and
  // window blur (switching to another app/Safari tab) are the two
  // minimum-required signals; both now route through the SAME auto-pause
  // check above instead of only the old stuck-input release. A-3: no
  // matching "visible again" / "focus" listener is added anywhere — RESUME
  // is only ever triggered by the player's own tap on the PAUSE MENU's
  // existing RESUME button, never automatically.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) autoPauseOnInterruption();
  });
  window.addEventListener('blur', autoPauseOnInterruption);

  // Restarts whichever mode is currently selected, from scratch — startMode()
  // already does a full resetModeState() (player/boss/HP/bullets/blade
  // projectiles/barrels/cinematic+milestone flags/DASH state/AUTO AIM/
  // explosions), so restarting is just re-entering the same mode.
  document.getElementById('mode-restart-btn').addEventListener('click', () => startMode(gameState.mode));
  document.getElementById('mode-resume-btn').addEventListener('click', () => {
    gameState.paused = false;
    storyPausedAccumMs += performance.now() - pauseStartedAt; // SECTION Q-1
    lastPlayerInputAt = performance.now(); // SECTION B/L: fresh grace period — real wall-clock time spent paused must never count toward the watchdog's idle timer
    hideModeMenu();
  });
  // SECTION T: QUIT ends the current STORY/TRAINING session and returns to
  // MAIN MENU — no page reload (BGM keeps playing uninterrupted, per T-1).
  // T-2: nothing needs to be explicitly wiped here — update()/draw() both
  // stop entirely the instant screen leaves 'gameplay' (SECTION J), and the
  // NEXT startMode() call (whenever STORY/TRAINING is picked again from
  // MAIN MENU) already runs a full resetModeState() — currentStageIndex,
  // boss state, bullets, AREA, and every other run-scoped field are always
  // reset fresh there, so no STORY progress/encounter/stage/area/boss
  // state ever survives into the next run.
  document.getElementById('mode-quit-btn').addEventListener('click', () => {
    gameState.paused = false;
    hideModeMenu();
    // DARK OUT PART 3 SECTION 20: QUITting out of an active BOSS BATTLE
    // MODE fight must clean it up (boss/projectiles/effects/battle state) —
    // never leave it for the next mode to inherit. No-op when not active.
    if (bossBattleState.active) exitBossBattle();
    returnToTopMenu(); // PART 3 SECTION D: covers BOSS/TRAINING/SECURITY TRAINING QUIT alike (shared PAUSE MENU button)
  });

  // SECTION H: the ONLY place player.stunned is ever cleared — a distinct,
  // explicit user action, independent from recoverControlState() (see that
  // function's own comment / SECTION I). Exact H-1 order: normalize raw
  // input state, clear the flag, reset the watchdog's grace period, then
  // refresh the DOM-facing visuals (CONTROL PANEL blackout / PAUSE button
  // color) — LIFE HUD's own orange/pulse styling self-corrects on the next
  // canvas draw() call purely by reading player.stunned, no separate step
  // needed for it. H-2/H-3: deliberately touches NOTHING else — boss HP,
  // player LIFE, stage/encounter/AREA, and DARK PHASE state are all left
  // exactly as they were; this is not RESTART.
  modeRebootBtn.addEventListener('click', () => {
    recoverControlState();
    player.stunned = false;
    lastPlayerInputAt = performance.now();
    updateStunVisuals();
    modeRebootBtn.hidden = true;
  });

  // SECTION J (this turn): RETRY — see retryCurrentRun()'s own comment for
  // the full "why not startMode()" reasoning.
  document.getElementById('game-over-retry-btn').addEventListener('click', () => {
    retryCurrentRun();
  });

  // SECTION M-4: same QUIT semantics as mode-quit-btn above — no reload,
  // and the next startMode() call runs its own full resetModeState() so
  // nothing carries over. PART 3 SECTION D: now also resets BGM to the top
  // via the shared returnToTopMenu(), same as every other TOP-bound QUIT.
  document.getElementById('game-over-quit-btn').addEventListener('click', () => {
    // DARK OUT PART 3 SECTION 17/20: a PLAYER death inside BOSS BATTLE MODE
    // still needs this same cleanup before returning to MAIN MENU.
    if (bossBattleState.active) exitBossBattle();
    returnToTopMenu();
  });

  // ---------- SECTION Q/R: RESULT ----------
  // Every magic number lives HERE, not scattered across the scoring code —
  // Q-4's own explicit instruction. Each of the 3 metrics contributes an
  // equally-weighted 0-100 sub-score (never letting TIME alone decide the
  // rank): PLAY TIME scores linearly between timeGoodSec (full credit) and
  // timeBadSec (zero credit); DAMAGE TAKEN the same shape between
  // damageGoodTotal/damageBadTotal; ACCURACY is already a 0-100 percentage.
  // The mean of the 3 is bucketed by `composite`'s own descending
  // thresholds into S/A/B/C, falling through to D otherwise.
  const RESULT_RANK_THRESHOLDS = {
    timeGoodSec: 300, timeBadSec: 900,
    damageGoodTotal: 100, damageBadTotal: 1000,
    composite: { S: 90, A: 75, B: 55, C: 35 },
  };
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function computeResultRank(playTimeSec, accuracyFrac, damageTaken) {
    const t = RESULT_RANK_THRESHOLDS;
    const timeScore = clamp01(1 - (playTimeSec - t.timeGoodSec) / (t.timeBadSec - t.timeGoodSec)) * 100;
    const damageScore = clamp01(1 - (damageTaken - t.damageGoodTotal) / (t.damageBadTotal - t.damageGoodTotal)) * 100;
    const accuracyScore = accuracyFrac * 100;
    const composite = (timeScore + damageScore + accuracyScore) / 3;
    if (composite >= t.composite.S) return 'S';
    if (composite >= t.composite.A) return 'A';
    if (composite >= t.composite.B) return 'B';
    if (composite >= t.composite.C) return 'C';
    return 'D';
  }
  function formatPlayTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function enterResultScreen() {
    const playTimeSec = Math.max(0, (performance.now() - storyStartTime) - storyPausedAccumMs) / 1000; // Q-1: PAUSE time excluded
    const accuracyFrac = shotsFired > 0 ? shotsHit / shotsFired : 0; // Q-2
    const rank = computeResultRank(playTimeSec, accuracyFrac, totalDamageTaken);
    document.getElementById('result-play-time').textContent = formatPlayTime(playTimeSec);
    document.getElementById('result-accuracy').textContent = `${Math.round(accuracyFrac * 100)}%`;
    document.getElementById('result-damage-taken').textContent = Math.round(totalDamageTaken);
    document.getElementById('result-rank').textContent = rank;
    setScreen('result');
  }
  document.getElementById('result-back-btn').addEventListener('click', () => {
    returnToTopMenu(); // R-1: no reload; PART 3 SECTION D: BGM now resets to the top here too, same as every other TOP-bound route
  });
  // R-2: ARTIST PAGE stays a disabled placeholder — see index.html's own
  // comment and the completion report; button intentionally has no
  // click handler while no confirmed official URL exists.

  // ---------- SETTING (SECTION E/I) ----------
  // playerMaxLife is the ONE shared piece of settings data — PAUSE MENU's
  // own SETTING button and MAIN MENU's SETTING button both open this exact
  // same #setting-panel DOM and read/write this exact same variable, never
  // a separate copy each. settingOpenedFrom remembers which menu's own
  // panel to hide/restore around it, so BACK always returns to whichever
  // screen actually opened SETTING.
  let playerMaxLife = Infinity;
  const pauseMenuPanel = document.getElementById('mode-menu-panel');
  const mainMenuPanelEl = document.getElementById('main-menu-overlay');
  const settingPanel = document.getElementById('setting-panel');
  let settingOpenedFrom = 'pause'; // 'pause' | 'mainMenu'
  function openSettingPanel(from) {
    settingOpenedFrom = from || (gameState.screen === 'mainMenu' ? 'mainMenu' : 'pause');
    if (settingOpenedFrom === 'mainMenu') mainMenuPanelEl.hidden = true;
    else pauseMenuPanel.hidden = true;
    settingPanel.hidden = false;
    updateSettingLifeButtons();
  }
  function closeSettingPanel() {
    settingPanel.hidden = true;
    if (settingOpenedFrom === 'mainMenu') mainMenuPanelEl.hidden = false;
    else pauseMenuPanel.hidden = false;
  }
  function updateSettingLifeButtons() {
    document.querySelectorAll('.life-option-btn').forEach((btn) => {
      const v = btn.dataset.life === 'infinity' ? Infinity : Number(btn.dataset.life);
      btn.classList.toggle('selected', v === playerMaxLife);
    });
  }
  function applyMaxLifeSetting(value) {
    playerMaxLife = value;
    // Applied at game start (per spec) — also applied immediately to the
    // CURRENT run so choosing it mid-PAUSE isn't silently deferred, capped
    // to the new max the same way a real HP system would.
    player.life = playerMaxLife === Infinity ? Infinity : Math.min(player.life, playerMaxLife);
    updateSettingLifeButtons();
  }
  document.getElementById('mode-setting-btn').addEventListener('click', () => openSettingPanel('pause'));
  document.getElementById('main-menu-setting-btn').addEventListener('click', () => openSettingPanel('mainMenu'));
  document.getElementById('setting-back-btn').addEventListener('click', closeSettingPanel);
  document.querySelectorAll('.life-option-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.life === 'infinity' ? Infinity : Number(btn.dataset.life);
      applyMaxLifeSetting(v);
    });
  });

  // ---------- ACTION STICK (movement + base facing) ----------
  const actionStickZone = document.getElementById('action-stick-zone');
  const actionStickKnob = document.getElementById('action-stick-knob');
  let actionStickTouchId = null;
  let actionStickVec = { x: 0, y: 0 }; // normalized -1..1

  function actionStickReset() {
    actionStickTouchId = null;
    actionStickVec.x = 0;
    actionStickVec.y = 0;
    actionStickKnob.style.transform = 'translate(0px, 0px)';
  }

  function handleActionStickMove(clientX, clientY) {
    const rect = actionStickZone.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const maxR = rect.width / 2;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, maxR);
    const angle = Math.atan2(dy, dx);
    const nx = (dist === 0) ? 0 : (Math.cos(angle) * clamped) / maxR;
    const ny = (dist === 0) ? 0 : (Math.sin(angle) * clamped) / maxR;
    actionStickVec.x = nx;
    actionStickVec.y = ny;
    actionStickKnob.style.transform = `translate(${nx * maxR * 0.7}px, ${ny * maxR * 0.7}px)`;
  }

  // PART 16: the MOVE STICK double-tap DASH gesture has been removed
  // entirely — DASH is triggered exclusively by the dedicated DASH button
  // now (see dashButtonPress() below). Ordinary MOVE STICK input can never
  // accidentally trigger a DASH anymore.
  actionStickZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (actionStickTouchId !== null) return;
    const t = e.changedTouches[0];
    actionStickTouchId = t.identifier;
    handleActionStickMove(t.clientX, t.clientY);
  }, { passive: false });

  actionStickZone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === actionStickTouchId) {
        handleActionStickMove(t.clientX, t.clientY);
      }
    }
  }, { passive: false });

  function actionStickTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === actionStickTouchId) {
        actionStickReset();
      }
    }
  }
  actionStickZone.addEventListener('touchend', actionStickTouchEnd, { passive: false });
  actionStickZone.addEventListener('touchcancel', actionStickTouchEnd, { passive: false });

  // ---------- AIM STICK (aim angle only, does not move the character) ----------
  const aimStickZone = document.getElementById('aim-stick-zone');
  const aimStickKnob = document.getElementById('aim-stick-knob');
  const aimStickSector = document.getElementById('aim-stick-sector');

  // PART 9: AIM STICK reaches the full 360deg circle now — there is no
  // wedge restriction left to visualize, so this just paints the whole
  // circle as reachable (kept as a function, and still called wherever
  // baseDir changes, so nothing else needs to know the restriction is
  // gone).
  function updateAimSectorOverlay() {
    aimStickSector.style.background = 'rgba(120,190,255,0.12)';
  }
  updateAimSectorOverlay(); // initial paint

  let aimStickTouchId = null;
  let aimStickMouseDown = false;
  let aimStickActive = false; // whether to draw the dotted prediction line
  const AIM_DEADZONE_PX = 3; // reduced from 6 — just enough to ignore a resting thumb's tremor

  // Double-tap the AIM STICK's CENTER -> snap to the nearest valid AUTO AIM
  // target (by distance from the player, not screen position). The snap
  // survives the tap's own touchend (which would otherwise immediately
  // zero it back to center) for AIM_DOUBLE_TAP_LOCK_MS, so the player can
  // lift their finger and press FIRE separately and still fire along the
  // snapped angle — see aimStickReset() and updateAutoAim().
  const AIM_DOUBLE_TAP_WINDOW_MS = 350;
  const AIM_DOUBLE_TAP_CENTER_PX = 24;
  const AIM_DOUBLE_TAP_LOCK_MS = 1500;
  let lastAimTapAt = -Infinity;
  let lastAimTapWasCenter = false;
  let aimDoubleTapLockUntil = 0;
  let aimDoubleTapTargetIsBoss = false;
  let aimDoubleTapTargetPoint = null;

  function getNearestAutoAimCandidate() {
    // Same target universe as the existing drag-to-snap AUTO AIM: the boss
    // (its weak point takes priority while DEFENSE is active, same as
    // elsewhere), or any alive barrel — excluding a boss that's dead or
    // mid-cinematic. Distance is measured from the PLAYER, not the stick
    // or reticle, since this is a deliberate "snap to whatever is
    // actually closest to me" gesture, not a proximity-to-cursor magnet.
    const candidates = [];
    if (boss.spawned && !bossIsInCinematic() && boss.state !== 'teleport' && !isDarkPhaseHidden()) {
      if (boss.state === 'defense') {
        const wp = getWeakPointScreenPos(boss.defenseDir);
        candidates.push({ x: wp ? wp.x : boss.x, y: wp ? wp.y : boss.y, isBoss: true });
      } else {
        candidates.push({ x: boss.x, y: boss.y, isBoss: true });
      }
    }
    for (const b of barrels) {
      if (b.alive) candidates.push({ x: b.x, y: b.y, isBoss: false });
    }
    let best = null, bestDist = Infinity;
    for (const c of candidates) {
      if (segmentCrossesAreaWall(player.x, player.y, c.x, c.y)) continue; // PART8 SECTION Q/U: same wall/door rule as the drag-to-snap AUTO AIM
      const d = Math.hypot(c.x - player.x, c.y - player.y);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  function performNearestAutoAimSnap(now) {
    const target = getNearestAutoAimCandidate();
    if (!target) return;
    const angle = Math.atan2(target.y - player.y, target.x - player.x);
    player.aimOffsetRaw = angle; // absolute — PART 9, no wedge clamp
    player.aimOffset = angle;
    player.baseDir = angleToBucket(angle); // PART 10: facing follows the snap too
    aimDoubleTapLockUntil = now + AIM_DOUBLE_TAP_LOCK_MS;
    aimDoubleTapTargetIsBoss = target.isBoss;
    aimDoubleTapTargetPoint = { x: target.x, y: target.y };
    aimStickActive = true;
    const rect = aimStickZone.getBoundingClientRect();
    const maxR = rect.width / 2;
    aimStickKnob.style.transform = `translate(${Math.cos(angle) * maxR * 0.7}px, ${Math.sin(angle) * maxR * 0.7}px)`;
  }

  // Returns true if this press completed a double-tap (and already
  // performed the snap) — the caller should skip normal drag handling.
  function tryAimDoubleTap(now, distFromCenter) {
    const isCenter = distFromCenter <= AIM_DOUBLE_TAP_CENTER_PX;
    if (isCenter && lastAimTapWasCenter && (now - lastAimTapAt) <= AIM_DOUBLE_TAP_WINDOW_MS) {
      performNearestAutoAimSnap(now);
      lastAimTapAt = -Infinity;
      lastAimTapWasCenter = false;
      return true;
    }
    lastAimTapAt = now;
    lastAimTapWasCenter = isCenter;
    return false;
  }

  function aimStickReset() {
    aimStickTouchId = null;
    aimStickMouseDown = false;
    if (performance.now() < aimDoubleTapLockUntil) {
      // A double-tap snap is still locked in — keep the reticle/aim line
      // showing the snapped angle instead of zeroing it on release.
      aimStickActive = true;
      return;
    }
    aimStickActive = false;
    // getFinalAimAngle() stops reading aimOffset/aimOffsetRaw entirely the
    // instant aimStickActive goes false (falls back to BASE_ANGLE[baseDir]
    // instead) — an un-aimed shot can never fire along a stale angle. These
    // are reset to 0 purely as inert bookkeeping, not because 0 has any
    // special meaning while not aiming.
    player.aimOffsetRaw = 0;
    player.aimOffset = 0;
    aimStickKnob.style.transform = 'translate(0px, 0px)';
  }

  function handleAimStickMove(clientX, clientY) {
    // SECTION H: AIM STICK is now fully inert during the pre-battle/intro
    // lock window (isBossIntroLocked()) — no facing change, no dotted
    // trajectory, no target lock, no AUTO AIM display.
    // MOVE STICK is the only way to change facing before battle starts
    // (see its own handling in update()). Reverses the previous batch's
    // deliberate AIM-during-intro exception, per this batch's explicit
    // instruction.
    if (isBossIntroLocked() || player.stunned) return;
    const rect = aimStickZone.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const maxR = rect.width / 2;
    const dist = Math.hypot(dx, dy);
    aimStickActive = true;

    if (dist < AIM_DEADZONE_PX) {
      // Too close to center to have a reliable direction — keep the last
      // aim angle/facing and just show the knob near center.
      aimStickKnob.style.transform = `translate(${dx * 0.5}px, ${dy * 0.5}px)`;
      return;
    }

    // PART 9: the raw stick angle IS the aim angle now — full 360deg, no
    // wedge clamp relative to baseDir. PART 10: facing follows it directly.
    const rawAngle = Math.atan2(dy, dx);
    player.aimOffsetRaw = rawAngle;
    player.baseDir = angleToBucket(rawAngle);
    updateAimSectorOverlay();

    const clamped = Math.min(dist, maxR);
    const nx = (Math.cos(rawAngle) * clamped) / maxR;
    const ny = (Math.sin(rawAngle) * clamped) / maxR;
    aimStickKnob.style.transform = `translate(${nx * maxR * 0.7}px, ${ny * maxR * 0.7}px)`;
  }

  aimStickZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (aimStickTouchId !== null) return;
    if (isBossIntroLocked() || player.stunned) return; // SECTION H/C: AIM STICK fully inert pre-battle/during intro, and during STUN
    const t = e.changedTouches[0];
    aimStickTouchId = t.identifier;
    aimStickActive = true;
    const rect = aimStickZone.getBoundingClientRect();
    const distFromCenter = Math.hypot(t.clientX - (rect.left + rect.width / 2), t.clientY - (rect.top + rect.height / 2));
    if (tryAimDoubleTap(performance.now(), distFromCenter)) return; // snap already applied
    handleAimStickMove(t.clientX, t.clientY);
  }, { passive: false });

  aimStickZone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === aimStickTouchId) {
        handleAimStickMove(t.clientX, t.clientY);
      }
    }
  }, { passive: false });

  function aimStickTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === aimStickTouchId) {
        aimStickReset();
      }
    }
  }
  aimStickZone.addEventListener('touchend', aimStickTouchEnd, { passive: false });
  aimStickZone.addEventListener('touchcancel', aimStickTouchEnd, { passive: false });

  // Mouse equivalent for desktop/PC testing (drag within the same zone).
  aimStickZone.addEventListener('mousedown', (e) => {
    if (isBossIntroLocked() || player.stunned) return; // SECTION H/C: AIM STICK fully inert pre-battle/during intro, and during STUN
    aimStickMouseDown = true;
    aimStickActive = true;
    const rect = aimStickZone.getBoundingClientRect();
    const distFromCenter = Math.hypot(e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
    if (tryAimDoubleTap(performance.now(), distFromCenter)) return;
    handleAimStickMove(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', (e) => {
    if (aimStickMouseDown) handleAimStickMove(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', () => {
    if (aimStickMouseDown) aimStickReset();
  });

  // ---------- Keyboard (PC test) ----------
  const keys = { up: false, down: false, left: false, right: false, fire: false };

  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': keys.up = true; break;
      case 'KeyS': case 'ArrowDown': keys.down = true; break;
      case 'KeyA': case 'ArrowLeft': keys.left = true; break;
      case 'KeyD': case 'ArrowRight': keys.right = true; break;
      case 'Space': keys.fire = true; e.preventDefault(); break;
    }
  });
  window.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': keys.up = false; break;
      case 'KeyS': case 'ArrowDown': keys.down = false; break;
      case 'KeyA': case 'ArrowLeft': keys.left = false; break;
      case 'KeyD': case 'ArrowRight': keys.right = false; break;
      case 'Space': keys.fire = false; e.preventDefault(); break;
    }
  });

  function getKeyboardVec() {
    let x = 0, y = 0;
    if (keys.left) x -= 1;
    if (keys.right) x += 1;
    if (keys.up) y -= 1;
    if (keys.down) y += 1;
    const len = Math.hypot(x, y);
    if (len > 0) { x /= len; y /= len; }
    return { x, y };
  }

  // ---------- Fire button ----------
  const fireZone = document.getElementById('fire-zone');
  const fireButton = document.getElementById('fire-button');
  let fireHeld = false;

  // SECTION D: 30-shot magazine HUD — ammo count text + cooldown ring,
  // same visual language/mechanism as the STEALTH cooldown ring (an SVG
  // circle whose stroke-dashoffset is driven from JS every frame).
  const fireAmmoLabel = document.getElementById('fire-ammo-label');
  const fireRingProgress = document.getElementById('fire-ring-progress');
  const FIRE_RING_R = 44;
  const FIRE_RING_CIRCUMFERENCE = 2 * Math.PI * FIRE_RING_R;
  fireRingProgress.style.strokeDasharray = `${FIRE_RING_CIRCUMFERENCE}`;

  function updateFireHud() {
    fireAmmoLabel.textContent = `${player.ammo} / ∞`;
    // 0% right at depletion, 100% once fully recovered; sits at "full ring"
    // (ready) whenever the magazine isn't currently depleted/cooling down.
    // PART8 SECTION B/C: the denominator depends on WHICH reload is running
    // (player.reloadType) — MANUAL_RELOAD_MS for a manual reload, EMPTY_
    // RELOAD_MS for the auto-empty one — never one shared duration.
    const activeReloadMs = player.reloadType === 'manual' ? MANUAL_RELOAD_MS : EMPTY_RELOAD_MS;
    const readyFrac = player.ammoCooldownRemainingMs > 0
      ? 1 - player.ammoCooldownRemainingMs / activeReloadMs
      : 1;
    fireRingProgress.style.strokeDashoffset = `${FIRE_RING_CIRCUMFERENCE * (1 - readyFrac)}`;
    fireButton.classList.toggle('depleted', player.ammoCooldownRemainingMs > 0);
    // PART7 SECTION O: purely visual — reflects whether triggerManualReload()
    // would currently do anything (1-29 ammo, not already reloading).
    if (reloadButton) {
      reloadButton.classList.toggle('usable', player.ammo > 0 && player.ammo < FIRE_MAG_SIZE && player.ammoCooldownRemainingMs <= 0);
    }
  }

  // PART7 SECTION P / PART8 SECTION C-D: red "Reloading!" text following the
  // player in WORLD space (drawn from inside draw()'s own
  // ctx.translate(0,-cameraY) block, so it scrolls with the player exactly
  // like the player sprite itself — never a fixed HUD position). Shown for
  // both the auto (ammo hit 0) and manual triggers alike; hidden the
  // instant ammoCooldownRemainingMs reaches 0. PART8 SECTION D: now blinks
  // on/off using `now` (the same pause-aware game-time value every other
  // draw-time timer in this file already receives — never Date.now()), so
  // PAUSE freezes the blink phase for free exactly like it freezes the
  // reload countdown itself.
  const RELOADING_TEXT_BLINK_MS = 450;
  function drawReloadingText(now) {
    if (player.ammoCooldownRemainingMs <= 0) return;
    const activeReloadMs = player.reloadType === 'manual' ? MANUAL_RELOAD_MS : EMPTY_RELOAD_MS;
    const elapsed = activeReloadMs - player.ammoCooldownRemainingMs;
    if (Math.floor(elapsed / RELOADING_TEXT_BLINK_MS) % 2 === 1) return; // off-phase: draw nothing this tick
    ctx.save();
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#ff3b30';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Reloading!', player.x, player.y - SPRITE_DRAW_H / 2 - 10);
    ctx.restore();
  }

  function fireStart(e) {
    e.preventDefault();
    fireHeld = true;
    fireButton.classList.add('active');
  }
  function fireEnd(e) {
    if (e) e.preventDefault();
    fireHeld = false;
    fireButton.classList.remove('active');
  }
  // Listeners on the zone (full touch hit area), not the smaller visual
  // button — see PART 11: the visible circle shrinks but the tappable
  // region must not shrink by the same amount.
  fireZone.addEventListener('touchstart', fireStart, { passive: false });
  fireZone.addEventListener('touchend', fireEnd, { passive: false });
  fireZone.addEventListener('touchcancel', fireEnd, { passive: false });
  fireZone.addEventListener('mousedown', fireStart);
  window.addEventListener('mouseup', fireEnd);

  // ---------- RELOAD button (PART7 SECTION O) ----------
  // A dedicated manual trigger for the SAME ammoCooldownRemainingMs timer
  // the auto-reload-at-0 path already drives — never a second/parallel
  // timer. SECTION O: only usable while ammo is 1-29 (never at 0 — auto-
  // reload already owns that case — and never at a full 30 magazine);
  // pressing again while ammoCooldownRemainingMs > 0 is a no-op (never
  // resets/restarts the timer, since it's only set here, once, if it was
  // previously 0).
  const reloadZone = document.getElementById('reload-zone');
  const reloadButton = document.getElementById('reload-button');
  function triggerManualReload(e) {
    if (e) e.preventDefault();
    if (gameState.paused) return;
    if (player.ammo <= 0 || player.ammo >= FIRE_MAG_SIZE) return; // SECTION O: usable range is strictly 1-29
    if (player.ammoCooldownRemainingMs > 0) return; // already reloading (manual OR auto-empty) — never reset/restart/retype an in-progress reload; this is what stops the 5s auto reload from ever being shortened to 2s
    player.reloadType = 'manual';
    player.ammoCooldownRemainingMs = MANUAL_RELOAD_MS;
  }
  reloadZone.addEventListener('touchstart', triggerManualReload, { passive: false });
  reloadZone.addEventListener('mousedown', triggerManualReload);

  // ---------- DASH button (PART 17-21) ----------
  // A dedicated button — the MOVE STICK double-tap gesture is gone (PART
  // 16). Direction: the current MOVE STICK vector if one is held (allows
  // diagonals), else the player's current facing (PART 18). Re-triggerable
  // every DASH_RETRIGGER_INTERVAL_MS, even while a DASH from a previous
  // press is still travelling — each press just restarts the same single
  // dash displacement from wherever the player currently is (PART 19/20).
  // Never starts a NEW dash while FIRE is being held (PART 21) — an
  // already-in-progress dash is unaffected by FIRE, only a fresh trigger.
  const dashZone = document.getElementById('dash-zone');
  const dashButton = document.getElementById('dash-button');
  const DASH_RETRIGGER_INTERVAL_MS = 200;
  let lastDashTriggerAt = -Infinity;

  function dashButtonPress(e) {
    e.preventDefault();
    if (isBossIntroLocked() || player.stunned) return; // PART 8 / SECTION C
    lastPlayerInputAt = performance.now(); // SECTION B: DASH counts as combat input for the watchdog
    dashButton.classList.add('active');
    const now = performance.now();
    const knockbackLockedNow = now < player.knockbackUntil;
    const firingNow = !knockbackLockedNow && (fireHeld || keys.fire);
    if (firingNow) return; // PART 21
    if (now - lastDashTriggerAt < DASH_RETRIGGER_INTERVAL_MS) return; // PART 19/20
    lastDashTriggerAt = now;
    const kb = getKeyboardVec();
    const vx = actionStickVec.x + kb.x, vy = actionStickVec.y + kb.y;
    const mag = Math.hypot(vx, vy);
    const angle = (mag > ACTION_STICK_DEADZONE) ? Math.atan2(vy, vx) : BASE_ANGLE[player.baseDir];
    tryStartDash(now, angle);
  }
  function dashButtonRelease(e) {
    if (e) e.preventDefault();
    dashButton.classList.remove('active');
  }
  dashZone.addEventListener('touchstart', dashButtonPress, { passive: false });
  dashZone.addEventListener('touchend', dashButtonRelease, { passive: false });
  dashZone.addEventListener('touchcancel', dashButtonRelease, { passive: false });
  dashZone.addEventListener('mousedown', dashButtonPress);
  window.addEventListener('mouseup', dashButtonRelease);

  // ---------- FLASH GRENADE ----------
  // A short toss (Canvas-drawn arc object, no image asset) that, once it
  // detonates, briefly whites out the screen and drops GABRIEL into a fully
  // damageable DOWN state for FLASH_DOWN_MS — see startBossFlashDown()/
  // updateBossFlashDown() above. Every timer here is dt-driven (not an
  // absolute deadline), so PAUSE genuinely freezes them mid-count — see the
  // same reasoning already used for barrel restocking.
  const flashZone = document.getElementById('flash-zone');
  const flashButton = document.getElementById('flash-button');
  const flashRingProgress = document.getElementById('flash-ring-progress');
  const FLASH_RING_R = 44;
  const FLASH_RING_CIRCUMFERENCE = 2 * Math.PI * FLASH_RING_R;
  flashRingProgress.style.strokeDasharray = `${FLASH_RING_CIRCUMFERENCE}`;

  const FLASH_THROW_MS = 350; // toss travel time before it detonates
  const FLASH_SCREEN_FLASH_MS = 180; // within the requested 100-250ms band
  const FLASH_DOWN_MS = 5000;
  const FLASH_COOLDOWN_MS = 5000; // was 10000 — cooldown-gate check and the UI ring both derive from this single constant, so they can never drift apart
  // Within the requested "~2-3x player height" band (SPRITE_DRAW_H is the
  // player's own on-screen height).
  const FLASH_MIN_DISTANCE = SPRITE_DRAW_H * 2.5;

  let flashCooldownRemainingMs = 0; // 0 = ready to use
  let flashGrenade = null; // {startX, startY, endX, endY, elapsedMs} while in flight, else null
  let flashScreenFlashRemainingMs = 0;

  function flashDisabledByCinematic() {
    // Covers INTRO/milestone/DYING/DEAD (bossIsInCinematic()) and the stage
    // fade transition. Deliberately does NOT include FLASH DOWN itself:
    // FLASH_DOWN_MS and FLASH_COOLDOWN_MS are now the same 5000ms, but
    // flashdown only STARTS once the grenade actually detonates
    // (FLASH_THROW_MS later than when the cooldown itself starts at press
    // time) — so if flashdown also blocked a fresh press, there would be a
    // real (~FLASH_THROW_MS-wide) window right as the cooldown reaches 0
    // where FLASH would silently do nothing, breaking the "always reusable
    // exactly FLASH_COOLDOWN_MS after use" guarantee. A press succeeding
    // here just restarts the down window a little early — harmless, and
    // the cooldown gate above is still what actually throttles reuse.
    return bossIsInCinematic() || stageTransition.active;
  }

  function flashPress(e) {
    if (e) e.preventDefault();
    if (gameState.paused) return;
    if (player.stunned) return; // SECTION C: FLASH is one of the 6 controls STUN blocks — flashDisabledByCinematic() doesn't cover this on its own
    if (flashCooldownRemainingMs > 0) return; // cooldown active: nothing happens at all, not even feedback
    if (!boss.spawned || flashDisabledByCinematic()) return;
    lastPlayerInputAt = performance.now(); // SECTION B: FLASH counts as combat input for the watchdog
    // SECTION 11/19: COUNTER ATTACK (boss.state === 'straightclaw') and DARK
    // PHASE (boss.state === 'darkphase') are the two states where the
    // distance requirement is deliberately skipped. COUNTER must be
    // punishable from anywhere, not just FLASH_MIN_DISTANCE+ away; DARK
    // PHASE must be FLASH-able at any range once the mask is visible,
    // exactly like canFlashTarget()'s own darkphase branch
    // (isAimedAtDarkPhaseHead()) already never checks distance. Before this
    // fix, this early gate still applied to 'darkphase' (only 'straightclaw'
    // was exempted), so a press made while standing within FLASH_MIN_DISTANCE
    // of GABRIEL during DARK PHASE — a common case, since its CLAW attacks
    // are close-range — returned right here as "too close" and never reached
    // canFlashTarget()/targetHit at all, even though the reticle was
    // correctly showing red (drawAimLine() uses canFlashTarget(), which has
    // no such distance check for darkphase). That mismatch — red aim, silent
    // no-op press — was the reported bug; every other state keeps the
    // original "too close" rejection unchanged.
    const skipsDistanceGate = boss.state === 'straightclaw' || boss.state === 'darkphase';
    if (!skipsDistanceGate) {
      const dist = Math.hypot(boss.x - player.x, boss.y - player.y);
      if (dist < FLASH_MIN_DISTANCE) {
        // Too close: a clearly noticeable (but text-free) red-tinted
        // button pulse — no throw, no cooldown, no screen flash, no DOWN.
        // This is the common case right as cooldown clears (GABRIEL's own
        // chase during the preceding few seconds often closes back within
        // range), so the rejection needs to read as "rejected", not just
        // "nothing happened" — a too-brief/too-subtle cue was easy to miss
        // mid-combat and looked like a stuck/broken button.
        flashButton.classList.add('too-close');
        setTimeout(() => flashButton.classList.remove('too-close'), 380);
        return;
      }
    }
    // SECTION 9/10: captured ONCE, right now at throw time (the moment of
    // commitment — GABRIEL keeps moving during the grenade's short flight,
    // so re-checking at detonation would judge a different position/aim
    // than the one the player actually committed to), and BEFORE the
    // cooldown reset just below — canFlashTarget() itself checks the
    // cooldown, which by this point is guaranteed still 0 (the early-return
    // above already confirmed it). This is the SAME predicate the reticle's
    // red color uses (drawAimLine()), so "shown red" and "actually hits"
    // can never disagree again, in ANY boss state — including outside DARK
    // PHASE/COUNTER ATTACK, where a throw previously always succeeded
    // regardless of aim as long as the distance gate passed.
    const targetHit = canFlashTarget();
    flashCooldownRemainingMs = FLASH_COOLDOWN_MS; // starts the instant a valid throw is accepted — win or miss, see below
    flashGrenade = { startX: player.x, startY: player.y, endX: boss.x, endY: boss.y, elapsedMs: 0, targetHit };
  }
  flashZone.addEventListener('touchstart', flashPress, { passive: false });
  flashZone.addEventListener('mousedown', flashPress);
  // Pointer Events hardening (this batch): investigated the reported
  // "FLASH only fires while AIM STICK is held" real-device symptom
  // extensively — flashPress() itself has never had any AIM-state check,
  // and real-coordinate taps (elementFromPoint-verified hit-testing, both
  // orientations, AIM held/not held, MOVE held, DARK PHASE active) all
  // fire correctly in this environment; the only failures reproduced
  // traced to unrelated test-setup coordinates, not game logic. Adding a
  // `pointerdown` listener alongside touchstart/mousedown is defense in
  // depth against any real-hardware touch/pointer event-model quirk
  // synthetic testing can't fully replicate — safe to double-register
  // since flashPress() is idempotent (a second call just sees the
  // cooldown already started and returns immediately).
  flashZone.addEventListener('pointerdown', flashPress);

  // SECTION K/U-11: two more countdown-driven one-shot screen overlays,
  // ticked the same dt-driven way as FLASH GRENADE's own screen flash right
  // below (so both correctly freeze during PAUSE instead of continuing to
  // animate off a raw, ever-advancing timestamp) — drawn in draw().
  function updateScreenFlashes(dt) {
    if (counterFlashRemainingMs > 0) counterFlashRemainingMs = Math.max(0, counterFlashRemainingMs - dt * 1000);
    if (deathFlashRemainingMs > 0) deathFlashRemainingMs = Math.max(0, deathFlashRemainingMs - dt * 1000);
    if (introStartFlashRemainingMs > 0) introStartFlashRemainingMs = Math.max(0, introStartFlashRemainingMs - dt * 1000);
    if (landingRedFlashRemainingMs > 0) landingRedFlashRemainingMs = Math.max(0, landingRedFlashRemainingMs - dt * 1000);
    if (encounter3StunFlashRemainingMs > 0) encounter3StunFlashRemainingMs = Math.max(0, encounter3StunFlashRemainingMs - dt * 1000);
    if (playerHitBlinkRemainingMs > 0) playerHitBlinkRemainingMs = Math.max(0, playerHitBlinkRemainingMs - dt * 1000);
    if (gameClearRemainingMs > 0) {
      gameClearRemainingMs = Math.max(0, gameClearRemainingMs - dt * 1000);
      if (gameClearRemainingMs === 0) enterResultScreen();
    }
    // DARK OUT PART 3 SECTION 16: BOSS BATTLE MODE's own separate "BOSS
    // DEFEATED" hold — ticks alongside GAME CLEAR's above but never calls
    // enterResultScreen(); returns to BOSS SELECT instead (see exitBossBattle()).
    if (bossBattleDefeatRemainingMs > 0) {
      bossBattleDefeatRemainingMs = Math.max(0, bossBattleDefeatRemainingMs - dt * 1000);
      if (bossBattleDefeatRemainingMs === 0) {
        exitBossBattle();
        setScreen('bossSelect');
      }
    }
  }

  function updateFlashGrenade(dt, now) {
    if (flashCooldownRemainingMs > 0) {
      flashCooldownRemainingMs = Math.max(0, flashCooldownRemainingMs - dt * 1000);
    }
    if (flashScreenFlashRemainingMs > 0) {
      flashScreenFlashRemainingMs = Math.max(0, flashScreenFlashRemainingMs - dt * 1000);
    }
    if (flashGrenade) {
      flashGrenade.elapsedMs += dt * 1000;
      if (flashGrenade.elapsedMs >= FLASH_THROW_MS) {
        const targetHit = flashGrenade.targetHit;
        flashGrenade = null;
        flashScreenFlashRemainingMs = FLASH_SCREEN_FLASH_MS; // the grenade itself still detonates either way
        // SECTION 9/10: a throw that wasn't a valid target at commit time
        // (captured via canFlashTarget() in flashPress()) detonates but
        // does nothing to GABRIEL at all — no DOWN, no COUNTER cancel, no
        // DARK PHASE end. The cooldown above already started regardless,
        // so a miss is a genuinely wasted use, not a free retry. This now
        // applies uniformly to every boss state (previously only DARK
        // PHASE required aim at all — outside it, a throw always succeeded
        // as long as the distance gate passed, aim-independent).
        if (boss.spawned && !flashDisabledByCinematic() && targetHit) {
          // SECTION 12: interrupting COUNTER ATTACK (boss.state ===
          // 'straightclaw') via a successful FLASH is handled by this SAME
          // call — startBossFlashDown() already unconditionally clears
          // arcClawSlashes (invalidating any in-flight COUNTER hitbox
          // before it can land a late hit) and moves boss.state to
          // 'flashdown' in the same synchronous step, which is also
          // exactly when COUNTER's invulnerability lifts (every
          // invulnerability check tests boss.state === 'straightclaw'
          // directly) — no separate cancel path needed.
          startBossFlashDown(now);
        }
      }
    }
    // Cooldown ring: fills up (0 -> full circumference) as flashCooldownRemainingMs counts down to 0.
    const readyFrac = 1 - flashCooldownRemainingMs / FLASH_COOLDOWN_MS;
    flashRingProgress.style.strokeDashoffset = `${FLASH_RING_CIRCUMFERENCE * (1 - readyFrac)}`;
    flashButton.classList.toggle('ready', flashCooldownRemainingMs <= 0);
  }

  function resetFlashGrenade() {
    flashCooldownRemainingMs = 0;
    flashGrenade = null;
    flashScreenFlashRemainingMs = 0;
    flashButton.classList.remove('too-close');
  }

  // A small tossed object arcing from the player to GABRIEL — deliberately
  // plain (no image asset, no glow), just enough to read as "something was
  // thrown", per spec.
  function drawFlashGrenade() {
    if (!flashGrenade) return;
    const t = Math.min(1, flashGrenade.elapsedMs / FLASH_THROW_MS);
    const x = flashGrenade.startX + (flashGrenade.endX - flashGrenade.startX) * t;
    const groundY = flashGrenade.startY + (flashGrenade.endY - flashGrenade.startY) * t;
    const arcHeight = 90;
    const y = groundY - Math.sin(t * Math.PI) * arcHeight;
    ctx.save();
    ctx.globalAlpha = 0.3 * (1 - t * 0.3);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(x, groundY, 6, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = '#43483a';
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ---------- STEALTH (PART 13-21) ----------
  // A player-side status only (player.stealthUntil) — deliberately never a
  // boss.state value (see PART 21/22). Independent cooldown/timer from
  // FLASH, same dt-driven pattern (freezes correctly on PAUSE, resumes
  // exactly where it left off). Does not itself suppress or alter MOVE/AIM/
  // FIRE/AUTO AIM/RANGE/FLASH/DASH in any way — only GABRIEL's own targeting
  // (getBossTargetPos(), used throughout updateBoss()/DARK PHASE above)
  // changes while it's active.
  const stealthZone = document.getElementById('stealth-zone');
  const stealthButton = document.getElementById('stealth-button');
  const stealthRingProgress = document.getElementById('stealth-ring-progress');
  const STEALTH_RING_R = 44;
  const STEALTH_RING_CIRCUMFERENCE = 2 * Math.PI * STEALTH_RING_R;
  stealthRingProgress.style.strokeDasharray = `${STEALTH_RING_CIRCUMFERENCE}`;

  const STEALTH_DURATION_MS = 5000;
  const STEALTH_COOLDOWN_MS = 10000; // counted from activation, independent of FLASH's own cooldown
  let stealthCooldownRemainingMs = 0; // 0 = ready to use

  function stealthPress(e) {
    if (e) e.preventDefault();
    if (gameState.paused) return;
    if (isBossIntroLocked() || player.stunned) return; // PART 8 / SECTION C
    if (stealthCooldownRemainingMs > 0) return; // cooldown active: nothing happens at all, not even feedback
    if (performance.now() < player.stealthUntil) return; // already active
    const now = performance.now();
    lastPlayerInputAt = now; // SECTION B: STEALTH counts as combat input for the watchdog
    stealthCooldownRemainingMs = STEALTH_COOLDOWN_MS; // starts the instant activation is accepted, per spec
    player.stealthUntil = now + STEALTH_DURATION_MS;
    player.stealthStartedAt = now;
    // Captured ONCE here — see getBossTargetPos() — and never touched again
    // until the NEXT activation (a fresh reveal-slate every time STEALTH
    // starts, per PART 18's "次に発砲したら更新される" wording).
    boss.lastKnownPlayerX = player.x;
    boss.lastKnownPlayerY = player.y;
    boss.revealedShotX = null;
    boss.revealedShotY = null;
  }
  stealthZone.addEventListener('touchstart', stealthPress, { passive: false });
  stealthZone.addEventListener('mousedown', stealthPress);

  function updateStealth(dt, now) {
    if (stealthCooldownRemainingMs > 0) {
      stealthCooldownRemainingMs = Math.max(0, stealthCooldownRemainingMs - dt * 1000);
    }
    const readyFrac = 1 - stealthCooldownRemainingMs / STEALTH_COOLDOWN_MS;
    stealthRingProgress.style.strokeDashoffset = `${STEALTH_RING_CIRCUMFERENCE * (1 - readyFrac)}`;
    stealthButton.classList.toggle('ready', stealthCooldownRemainingMs <= 0);
    stealthButton.classList.toggle('active-effect', now < player.stealthUntil);
  }

  function resetStealth() {
    stealthCooldownRemainingMs = 0;
    player.stealthUntil = -Infinity;
    player.stealthStartedAt = -Infinity;
    boss.revealedShotX = null;
    boss.revealedShotY = null;
    stealthButton.classList.remove('active-effect');
  }

  // Fade-in-then-hold-then-fade-out alpha multiplier for the green-tint
  // compositing (see drawPlayer()'s STEALTH branch) — 0 = fully normal
  // rendering, 1 = fully at STEALTH_ALPHA. ~150ms fade at both ends (within
  // the requested 100-200ms band), per the addendum.
  const STEALTH_FADE_MS = 150;
  function getStealthEffectStrength(now) {
    if (now >= player.stealthUntil) return 0;
    const sinceStart = now - player.stealthStartedAt;
    if (sinceStart < STEALTH_FADE_MS) return Math.max(0, sinceStart / STEALTH_FADE_MS);
    const untilEnd = player.stealthUntil - now;
    if (untilEnd < STEALTH_FADE_MS) return Math.max(0, untilEnd / STEALTH_FADE_MS);
    return 1;
  }

  // UI relayout: the page itself is now allowed to scroll vertically when
  // PLAY AREA + CONTROL AREA don't both fit the viewport (see html/body's
  // touch-action:pan-y in style.css), so a blanket document-wide
  // touchmove-preventDefault would defeat that. Each individual stick/
  // button zone already calls preventDefault() in its own touchstart/
  // touchmove handler AND carries touch-action:none in CSS, which is
  // sufficient on its own to stop a drag on THAT control from also
  // panning the page — no global handler needed. Pinch-zoom is still
  // blocked (the viewport meta tag's user-scalable=no already prevents
  // it; this is just defense in depth for browsers that ignore that).
  document.addEventListener('gesturestart', (e) => { e.preventDefault(); });

  // ---------- Bullets ----------
  const bullets = [];
  const BULLET_SPEED = 620;
  const FIRE_INTERVAL = 170; // ms
  // SECTION D / PART7 SECTION N-Q / PART8 SECTION A: 30-shot magazine,
  // infinite reserve ammo. ammoCooldownRemainingMs IS the RELOAD timer (same
  // field, same countdown) — it starts automatically the instant ammo hits
  // 0 (below, using EMPTY_RELOAD_MS), OR manually via triggerManualReload()
  // while ammo is 1-29 (using MANUAL_RELOAD_MS). PART8 SECTION A: these two
  // durations are now DELIBERATELY separate constants — manual and auto-
  // empty reloads must never share one timer value again. dt-driven, so
  // PAUSE freezes it for free. player.reloadType ('manual'/'auto'/null)
  // records which duration is currently in effect, read by the SHOT ring
  // progress calc (updateFireHud()) and by triggerManualReload()'s own
  // "never shorten an in-progress auto reload" guard.
  const FIRE_MAG_SIZE = 30;
  const MANUAL_RELOAD_MS = 2000;
  const EMPTY_RELOAD_MS = 5000;
  const FIRE_COOLDOWN_MS = EMPTY_RELOAD_MS; // kept only for external/debug references to the old single-duration name; no internal logic reads this directly anymore
  const FIRE_POSE_DURATION = 80; // ms — how long the FIRE sprite shows per shot
  const MUZZLE_DIST = SPRITE_DRAW_H * 0.46; // same muzzle offset used previously
  const AIM_LINE_LEN = 240; // AUTO AIM's reticle-tip search distance — fixed (unchanged; keeps existing AUTO AIM target-detection behavior identical)
  // PART 12 SECTION 12: the RANGE gauge (a player-adjustable vertical slider
  // that controlled only the dotted aim-guide's drawn length, never bullet
  // travel distance) has been removed entirely, per spec — the guide now
  // simply always uses this one fixed length (12-3: "既存defaultまたは適切な
  // 固定値", matching the RANGE gauge's own former default exactly, so the
  // guide's everyday look/feel is unchanged). The dotted AIM guide itself
  // (12-2) is untouched.
  const AIM_GUIDE_LEN = AIM_LINE_LEN; // 240 — the RANGE gauge's own former default length
  let autoAimLockedPoint = null; // {x,y} of whatever AUTO AIM is currently snapped onto, or null — see updateAutoAim()/performNearestAutoAimSnap()

  // The replacement RIGHT/FIRE and LEFT/FIRE sprites each have their muzzle
  // flash at a fixed point on screen (measured directly from each asset,
  // individually — NOT a mirrored pair, see the differing DX/DY magnitudes
  // below), noticeably higher and further out than the generic radial
  // offset above. The sprite doesn't rotate with the aim angle at all (it's
  // a static image), so a fixed screen-space point is the correct match for
  // it, not a radial formula. Scoped to RIGHT+FIRE / LEFT+FIRE only — every
  // other direction/pose still uses the generic MUZZLE_DIST radial offset,
  // which — being angle-based — already tracks the aim guide correctly on
  // its own (see MUZZLE_OFFSETS.south/.north below).
  //
  // PART 9-13: getMuzzleWorldPosition() below is now the SINGLE place this
  // decision is made — spawnBullet() and drawAimLine() both call it with
  // the SAME finalAimAngle, so the bullet's spawn point and the dotted aim
  // guide's start point can never independently drift apart the way they
  // used to (drawAimLine() previously had its own separate, always-radial
  // calculation, which for RIGHT/LEFT — the only two with a non-radial,
  // fixed-point muzzle — did not match where the bullet actually came from).
  // SECTION I: re-measured directly against the CURRENTLY shipped
  // right_aim.png/left_aim.png (the sprite actually shown while the AIM
  // STICK is held without FIRE, which is most of the time this offset is
  // visible) — found the rightmost/leftmost opaque pixel (the gun's own
  // muzzle/suppressor tip) and converted through the exact same
  // draw-time transform drawPlayer() applies (drawH=SPRITE_DRAW_H,
  // scale=drawH/nativeH, drawW=nativeW*scale, center-anchored both axes).
  // The previous values read a few px further OUT than the visible barrel
  // tip (verified on-screen: the dashed guide started just past the
  // muzzle, in open air) — most likely tuned against right_fire.png's own
  // muzzle-FLASH graphic, which extends past the true muzzle opening,
  // rather than the plain barrel tip.
  const MUZZLE_OFFSETS = {
    right: { dx: SPRITE_DRAW_H * 0.459, dy: SPRITE_DRAW_H * -0.287 },
    left: { dx: SPRITE_DRAW_H * -0.450, dy: SPRITE_DRAW_H * -0.315 },
    // south/north (down/up): no dedicated fixed-muzzle art — the generic
    // MUZZLE_DIST radial offset (rotates with the live aim angle) is
    // already correct and already shared identically by both call sites.
  };
  function getMuzzleWorldPosition(angle) {
    const fixed = MUZZLE_OFFSETS[player.baseDir];
    if (fixed) return { x: player.x + fixed.dx, y: player.y + fixed.dy };
    return { x: player.x + Math.cos(angle) * MUZZLE_DIST, y: player.y + Math.sin(angle) * MUZZLE_DIST };
  }
  let lastFireTime = -Infinity;

  function spawnBullet() {
    const angle = getFinalAimAngle();
    const muzzle = getMuzzleWorldPosition(angle);
    const bx = muzzle.x, by = muzzle.y;
    bullets.push({
      x: bx,
      y: by,
      vx: Math.cos(angle) * BULLET_SPEED,
      vy: Math.sin(angle) * BULLET_SPEED,
      born: performance.now(),
      // Captured at fire time, not checked later: whether AUTO AIM was
      // actively locked onto the boss's own target (weak point or its body
      // fallback) for THIS shot — a barrel-locked or unassisted shot must
      // never count toward DEFENSE's GUARD BREAK counter even if it happens
      // to also land on the boss.
      autoAimedBoss: autoAimActive && autoAimTargetIsBoss,
    });
    shotsFired++; // SECTION Q-2: normal FIRE only — FLASH is a separate mechanic and must never be mixed into ACCURACY
    // No canvas muzzle-flash circle — the FIRE sprites already carry their
    // own baked-in flash art; an extra orange dot on top was redundant.
  }

  let playerHitFlashUntil = 0;

  // SECTION F: brief on/off blink of the PLAYER'S OWN SPRITE ONLY (never
  // the whole screen — that's the separate playerHitFlashUntil red tint
  // above, kept as-is) on any actual hit, even under infinite LIFE. Ticked
  // in updateScreenFlashes(dt) alongside the other countdown timers so it
  // freezes correctly during PAUSE; consumed in drawPlayer() by simply
  // skipping that frame's draw call during each cycle's "off" half.
  const PLAYER_HIT_BLINK_COUNT = 3;
  const PLAYER_HIT_BLINK_TOTAL_MS = 300; // within the requested ~200-350ms band
  const PLAYER_HIT_BLINK_CYCLE_MS = PLAYER_HIT_BLINK_TOTAL_MS / PLAYER_HIT_BLINK_COUNT;
  let playerHitBlinkRemainingMs = 0;

  // SECTION P/Q: GAME CLEAR — a brief screen-space canvas overlay drawn
  // over the frozen final gameplay frame (never a screen swap, so the last
  // moment of ENCOUNTER 3 stays visible underneath) after the existing
  // boss-defeat effect finishes, then RESULT (a real DOM screen, like MAIN
  // MENU) replaces it. See triggerGameClear() below and its call site in
  // updateBossDying().
  const GAME_CLEAR_DISPLAY_MS = 2500;
  let gameClearRemainingMs = 0;
  function triggerGameClear(now) {
    gameClearRemainingMs = GAME_CLEAR_DISPLAY_MS;
  }

  // SECTION E: the ONE place player LIFE is ever reduced. `amount` must
  // always be an EXISTING damage value already computed elsewhere in this
  // file (COUNTER_ATTACK_DAMAGE via player.lastCounterDamage for the
  // COUNTER family, BULLET_DAMAGE — the codebase's one other real "one hit
  // unit" constant — for every other player-damaging attack) — never a
  // newly-invented number. At player.life === Infinity (the default), the
  // subtraction below is a no-op by IEEE-754 arithmetic (Infinity - X stays
  // Infinity for any finite X), so this can be called unconditionally on
  // every hit without a separate isFinite() branch for the damage itself —
  // only the hit-feedback (blink + the pre-existing red screen tint +
  // whatever knockback the caller already applies) needs to keep firing
  // regardless of the LIFE setting, per spec.
  function applyDamageToPlayerLife(now, amount) {
    player.life = Math.max(0, player.life - amount);
    playerHitFlashUntil = now + 150;
    playerHitBlinkRemainingMs = PLAYER_HIT_BLINK_TOTAL_MS;
    totalDamageTaken += amount; // SECTION Q-3: accumulates the real damage VALUE regardless of the LIFE setting — never zeroed out just because player.life === Infinity
    // SECTION A/M (root-cause fix, this turn): LIFE reaching 0 on a finite
    // setting (Infinity can never satisfy this) used to leave the player
    // stuck in isBossIntroLocked()'s own silent permanent lock forever, with
    // no GAME OVER screen ever existing to move on from it — see
    // isBossIntroLocked()'s own comment for the full root-cause writeup.
    // Fixed by transitioning to a real terminal screen the instant it
    // happens, which also immediately halts update()/draw() entirely (see
    // loop()'s own screen==='gameplay' gate) — boss AI/projectiles/input
    // all stop in the same instant, satisfying M-2 for free.
    // SECTION M-4: SECURITY TRAINING's laser hit reuses this exact same
    // GAME OVER wiring — widened here rather than duplicated elsewhere, so
    // it inherits the identical instant halt-of-update/draw behavior.
    // DARK OUT PART 3 SECTION 17: BOSS BATTLE MODE reuses this exact same
    // GAME OVER wiring too — a PLAYER death mid-fight still needs a real
    // terminal screen (RETRY/QUIT), never a silent freeze.
    if (player.life <= 0 && (gameState.mode === 'boss' || gameState.mode === 'securityTraining' || gameState.mode === 'bossBattle') && gameState.screen === 'gameplay') {
      triggerGameOver(now);
    }
  }

  // SECTION M: a real DOM screen (like RESULT/MAIN MENU), NOT a canvas
  // overlay on the frozen frame the way GAME CLEAR is — GAME CLEAR needed
  // that overlay approach specifically so the last moment of victory stays
  // visible; GAME OVER has no such requirement and the spec calls for an
  // immediate, complete stop instead.
  function triggerGameOver(now) {
    setScreen('gameover');
  }

  // SECTION J (this turn): RETRY re-initializes the CURRENT run in place
  // (same gameState.mode — STORY re-enters the SAME currentStageIndex/
  // bossEncounterIndex the player just died on, never STAGE 1) rather than
  // routing through startMode() (which would reset STORY progress back to
  // STAGE 1 and isn't what J-2 asks for). Reuses resetModeState()'s own
  // full reset verbatim via preserveStoryProgress=true, so there is exactly
  // one implementation of "what does resetting a run actually do" — never a
  // second copy here. J-4: BGM is untouched by resetModeState() (only
  // returnToTopMenu() ever resets it), so RETRY naturally continues from
  // its current playback position instead of restarting at 0.
  function retryCurrentRun() {
    resetModeState(true);
    gameState.paused = false;
    setScreen('gameplay');
  }

  // Exposed for Playwright/manual verification only — not part of gameplay.
  window.__game = {
    player, boss, playerHitCount: 0,
    applyBodyHitToBoss, applyWeakPointHitToBoss, applyExplosionDamageToBoss, bossEnterState,
    getWeakPointScreenPos, arcClawSlashes, spawnArcClawSlash,
    gameState, barrels, explosions, bullets, spawnBarrels, startMode, explodeBarrel, // debug/verification only — SECTION F
    // Debug/verification only — SECTION G/H/I/J/T (LOADING/OPENING/MAIN MENU/BGM).
    setScreen, bgmAudio, startBgmOnce, BGM_VOLUME, returnToTopMenu, // returnToTopMenu debug/verification only — PART 3 SECTION D
    get autoAimActive() { return autoAimActive; },
    getAutoAimTargetPoint, // debug/verification only
    get autoAimTargetIsBoss() { return autoAimTargetIsBoss; },
    MUZZLE_DIST, AIM_LINE_LEN, AUTO_AIM_RADIUS,
    // Debug/verification only — boss cinematic sequences.
    bossIsInCinematic, isBossDamageImmune, checkBossHpMilestones, startBossThreshold, startBossDying,
    BOSS_PHASE_THRESHOLDS, INTRO_TOTAL_MS, THRESHOLD_CINEMATIC_MS, DYING_DURATION_MS,
    DEFENSE_GUARD_BREAK_HITS, BARREL_EXPLOSION_RADIUS, BOSS_HURT_RADIUS,
    BARREL_EXPLOSION_DAMAGE_RADIUS_BOSS, BARREL_DAMAGE, BARREL_DAMAGE_BOSS, BARREL_DAMAGE_BOSS_MULTIPLIER, // debug/verification only — SECTION C (this turn)
    EXPLOSION_DAMAGE_RADIUS_REDUCTION, // debug/verification only — PART8 SECTION AC
    BULLET_DAMAGE, // debug/verification only — PART 2: the reused normal-attack damage constant for SECURITY ROBOT's laser
    TRAINING_BACKGROUNDS, get currentStage() { return currentStage(); }, // debug/verification only — SECTION D (this turn)
    STAGE_REGISTRY, getStageRegistryEntry, // debug/verification only — DARK OUT PART 1
    ROID1_SPRITES, ROID2_SPRITES, ADAM_SPRITES, ADAM_SPHERE_SPRITES, ITEM_SPRITES,
    getAllNewCharacterItemFrames, computeBodyVisualScale, getAdamReferenceBodyHeightPx, getItemReferenceBodyHeightPx,
    ROID_BODY_TARGET_HEIGHT, ADAM_SPHERE_TARGET_DIAMETER, makeSpriteFrame, // debug/verification only — DARK OUT PART 2
    BOSS_BATTLE_TARGETS, bossBattleState, startBossBattle, exitBossBattle,
    get bossBattleDefeatRemainingMs() { return bossBattleDefeatRemainingMs; }, // debug/verification only — DARK OUT PART 3
    // Debug/verification only — stage world/camera/EXIT (PART 21-29).
    STAGES,
    get currentStageIndex() { return currentStageIndex; },
    set currentStageIndex(v) { currentStageIndex = v; }, // debug/verification only
    get cameraY() { return cameraY; },
    get worldExtraAbove() { return worldExtraAbove; },
    worldScrollUnlocked, trainingWorldScrollUnlocked, exitWorldPos, beginStageTransition, advanceTrainingStage,
    get basicTrainingBgIndex() { return basicTrainingBgIndex; },
    set basicTrainingBgIndex(v) { basicTrainingBgIndex = v; }, // debug/verification only
    get stageTransition() { return stageTransition; },
    getAmbientDarkenAlpha,
    requestDash, // debug/verification only — drives the DASH chain directly, bypassing touch-gesture detection
    HALF_RANGE, clampToHalfRange, BASE_ANGLE, keys, getFinalAimAngle,
    getAimAngle: getFinalAimAngle, // back-compat alias for existing verification scripts — same function, PART 12's new name is getFinalAimAngle
    getCinematicImageInfo, CINEMATIC_SCALE, CINEMATIC_BACK_SCALE, DIR_TO_BOSS_KEY, // debug/verification only
    get barrelRestockPending() { return barrelRestockPending; },
    get barrelRestockRemainingMs() { return barrelRestockRemainingMs; },
    barrelLandings, spawnFallingBarrels, BARREL_FALL_MS, // debug/verification only
    AIM_GUIDE_LEN, // debug/verification only — PART 12: fixed aim-guide length (RANGE gauge removed)
    get autoAimLockedPoint() { return autoAimLockedPoint; },
    get aimStickActive() { return aimStickActive; },
    set aimStickActive(v) { aimStickActive = v; }, // debug/verification only
    flashPress, startBossFlashDown, // debug/verification only
    get flashCooldownRemainingMs() { return flashCooldownRemainingMs; },
    FIRE_MAG_SIZE, FIRE_COOLDOWN_MS, // debug/verification only — SECTION D
    set flashCooldownRemainingMs(v) { flashCooldownRemainingMs = v; }, // debug/verification only
    get flashGrenade() { return flashGrenade; },
    get flashScreenFlashRemainingMs() { return flashScreenFlashRemainingMs; },
    FLASH_DOWN_MS, FLASH_COOLDOWN_MS, FLASH_MIN_DISTANCE, FLASH_THROW_MS,
    // Debug/verification only — STEALTH.
    stealthPress, resetStealth, getBossTargetPos, getStealthEffectStrength,
    STEALTH_DURATION_MS, STEALTH_COOLDOWN_MS,
    get stealthCooldownRemainingMs() { return stealthCooldownRemainingMs; },
    set stealthCooldownRemainingMs(v) { stealthCooldownRemainingMs = v; },
    // Debug/verification only — DARK PHASE (SECTION C rebuild).
    startBossDarkPhase, registerGlobalAutoAimHit, getDarkPhaseHeadScreenPos, isAimedAtDarkPhaseHead,
    isDarkPhaseHidden, pickDarkPhaseRelocatePosition,
    get darkPhaseOverlayAlpha() { return darkPhaseOverlayAlpha; },
    AUTO_AIM_INVULN_HITS, DARKPHASE_FADE_MS, DARKPHASE_OVERLAY_ALPHA,
    DARKPHASE_ATTACK_RANGE, DARKPHASE_HEAD_HIT_RADIUS,
    DARK_PHASE_HIDDEN_MS, DARK_PHASE_MASK_TELEGRAPH_MS, DARK_PHASE_CLAW_INTERVAL_MS,
    DARK_PHASE_MASK_SCALE_BOOST, DARK_PHASE_MIN_RELOCATE_DISTANCE,
    isDarkPhaseFlashLocked, // debug/verification only
    canFlashTarget, isAimingAtBoss, isAimedAtBossBody, // debug/verification only — SECTION 9/10/11
    // Debug/verification only — boss INTRO sequence (PART 1-8).
    spawnBoss, isBossIntroLocked,
    // Debug/verification only — SECTION E (LIFE) / SECTION F (hit-blink).
    applyDamageToPlayerLife,
    get playerMaxLife() { return playerMaxLife; },
    HUD_BAR_W, HUD_BAR_H, HUD_MARGIN_X, // debug/verification only — SECTION E/F/V
    applyMaxLifeSetting, openSettingPanel, closeSettingPanel,
    get playerHitBlinkRemainingMs() { return playerHitBlinkRemainingMs; },
    PLAYER_HIT_BLINK_COUNT, PLAYER_HIT_BLINK_TOTAL_MS,
    BOSS_INTRO_INITIAL_SHAKE_MS, BOSS_INTRO_SILENCE_MS, BOSS_INTRO_SHADOW_REVEAL_MS,
    BOSS_INTRO_LANDING_SHAKE_MS, BOSS_INTRO_POST_LANDING_PAUSE_MS, BOSS_INTRO_SOUTH_IDLE_MS,
    BOSS_INTRO_SOUTH_ATTACK_MS,
    BOSS_INTRO_SHAKE_END, BOSS_INTRO_SILENCE_END, BOSS_INTRO_SHADOW_END,
    BOSS_INTRO_LANDING_SHAKE_END, BOSS_INTRO_POST_PAUSE_END, BOSS_INTRO_SOUTH_IDLE_END,
    // Debug/verification only — SECTION R/S screen flash timings.
    BOSS_INTRO_START_FLASH_TOTAL_MS, BOSS_INTRO_START_FLASH_ALPHA_MAX,
    BOSS_LANDING_RED_FLASH_TOTAL_MS, BOSS_LANDING_RED_FLASH_ALPHA_MAX,
    get screenShakeMag() { return screenShakeMag; },
    get screenShakeUntil() { return screenShakeUntil; },
    // Debug/verification only — unified muzzle/aim (PART 9-14).
    getMuzzleWorldPosition, MUZZLE_OFFSETS,
    // Debug/verification only — GABRIEL damage blink (PART 35/36).
    get bossDamageBlinkStartAt() { return bossDamageBlinkStartAt; },
    BOSS_DAMAGE_BLINK_COUNT, BOSS_DAMAGE_BLINK_TOTAL_MS, BOSS_HIT_TINT_MS,
    BOSS_CHASE_SPEED, BOSS_SPEED,
    // Debug/verification only — GABRIEL defeat sequence (SECTION U rework).
    BOSS_DEFEAT_BLACKEN_MS, BOSS_DEFEAT_DISINTEGRATE_MS,
    BOSS_DEFEAT_BLACKEN_START, BOSS_DEFEAT_BLACKEN_END,
    get deathFlashRemainingMs() { return deathFlashRemainingMs; },
    get counterFlashRemainingMs() { return counterFlashRemainingMs; },
    get introStartFlashRemainingMs() { return introStartFlashRemainingMs; }, // debug/verification only — SECTION R
    get landingRedFlashRemainingMs() { return landingRedFlashRemainingMs; }, // debug/verification only — SECTION S
    get boss_counterAttackKind() { return boss.counterAttackKind; }, // debug/verification only — SECTION J
    // Debug/verification only — walk-cycle timing (north/south walk frame replacement batch).
    WALK_FRAME_PERIOD_MS, SOUTH_WALK_FRAME_PERIOD_MS,
    // Debug/verification only — STRAIGHT CLAW counterattack (SECTION A).
    STRAIGHT_CLAW_TRIGGER_GUARDS, STRAIGHT_CLAW_WINDUP_MS, STRAIGHT_CLAW_ATTACK_MS, STRAIGHT_CLAW_RECOVERY_MS,
    STRAIGHT_CLAW_KNOCKBACK_DISTANCE, STRAIGHT_CLAW_KNOCKBACK_LOCK_MS,
    // Debug/verification only — COUNTER ATTACK direction split (this batch).
    COUNTER_STING_SCALE, COUNTER_WINDUP_SCALE, COUNTER_ARC_CLAW_LIFETIME_MS, COUNTER_DAMAGE_MULTIPLIER, COUNTER_ATTACK_DAMAGE,
    BOSS_CLOSE_COUNTER_DISTANCE, CLOSE_RANGE_SHOT_THRESHOLD, // debug/verification only — SECTION I
    DARK_PHASE_GUARANTEE_HP_FRAC, // debug/verification only — SECTION J
    getBossDifficultyMultiplier, BOSS_DIFFICULTY_TABLE, // debug/verification only — SECTION N
    // Debug/verification only — AREA 1/AREA 2 vertical stage (SECTION C).
    get currentArea() { return currentArea; },
    get area1Cleared() { return area1Cleared; },
    set area1Cleared(v) { area1Cleared = v; }, // debug/verification only
    get area2Cleared() { return area2Cleared; },
    set area2Cleared(v) { area2Cleared = v; }, // debug/verification only
    CAMERA_FOLLOW_RATE, areaTopY, clampPlayerToScreen,
    // Debug/verification only — SECTION K/L/O (3-STAGE/3-encounter STORY
    // progression) and SECTION P/Q/R (GAME CLEAR / RESULT stats).
    get gameClearRemainingMs() { return gameClearRemainingMs; },
    set gameClearRemainingMs(v) { gameClearRemainingMs = v; }, // debug/verification only
    triggerGameClear, GAME_CLEAR_DISPLAY_MS,
    get storyStartTime() { return storyStartTime; },
    set storyStartTime(v) { storyStartTime = v; }, // debug/verification only
    get storyPausedAccumMs() { return storyPausedAccumMs; },
    set storyPausedAccumMs(v) { storyPausedAccumMs = v; }, // debug/verification only
    get shotsFired() { return shotsFired; },
    set shotsFired(v) { shotsFired = v; }, // debug/verification only
    get shotsHit() { return shotsHit; },
    set shotsHit(v) { shotsHit = v; }, // debug/verification only
    get totalDamageTaken() { return totalDamageTaken; },
    set totalDamageTaken(v) { totalDamageTaken = v; }, // debug/verification only
    RESULT_RANK_THRESHOLDS, computeResultRank, formatPlayTime, enterResultScreen,
    // Debug/verification only — SECTION A (root-cause fix)/B (watchdog)/C
    // (STUN)/G-H-I (REBOOT)/J (ENCOUNTER 3 forced STUN)/M (GAME OVER).
    isStunLocked, recoverControlState, detectControlStateCorruption, triggerStun,
    updateStunVisuals, triggerGameOver,
    get lastPlayerInputAt() { return lastPlayerInputAt; },
    set lastPlayerInputAt(v) { lastPlayerInputAt = v; }, // debug/verification only
    CONTROL_WATCHDOG_IDLE_MS, STUN_LIFE_PULSE_MS, ARTIST_PAGE_URL,
    get encounter3StunFlashRemainingMs() { return encounter3StunFlashRemainingMs; },
    set encounter3StunFlashRemainingMs(v) { encounter3StunFlashRemainingMs = v; }, // debug/verification only
    ENCOUNTER3_STUN_FLASH_TOTAL_MS,
    // Debug/verification only — PART 2/3: SECURITY TRAINING / SECURITY ROBOT (DRONE).
    securityRobots, spawnSecurityRobots, securityDroneRowY, pickSecurityDroneCenterX,
    isPlayerInSecurityShadow, getSecurityShadowCenter, getSecurityRobotMuzzlePos,
    fireSecurityLaser, resolveSecurityLaserHit, updateSecurityRobots, distanceToSegment,
    applyDamageToSecurityDrone, spawnExplosionVisual,
    get securityAttackSlotsInUse() { return securityAttackSlotsInUse; },
    set securityAttackSlotsInUse(v) { securityAttackSlotsInUse = v; }, // debug/verification only
    get securityTrainingBgIndex() { return securityTrainingBgIndex; },
    set securityTrainingBgIndex(v) { securityTrainingBgIndex = v; }, // debug/verification only
    SECURITY_ROBOT_COUNT, SECURITY_ROBOTS_PER_AREA,
    SECURITY_TELEGRAPH_MS, SECURITY_LASER_VISUAL_MS,
    SECURITY_LASER_COOLDOWN_MIN_MS, SECURITY_LASER_COOLDOWN_MAX_MS,
    SECURITY_MAX_SIMULTANEOUS_ATTACKS, SECURITY_SHADOW_RADIUS_X, SECURITY_SHADOW_RADIUS_Y,
    SECURITY_ROBOT_DRAW_D, SECURITY_ROBOT_METRICS, SECURITY_ROBOT_MIN_SPACING,
    SECURITY_PATROL_RANGE_MIN, SECURITY_PATROL_RANGE_MAX, SECURITY_PATROL_SPEED_MIN, SECURITY_PATROL_SPEED_MAX,
    SECURITY_SCAN_RANGE_MIN, SECURITY_SCAN_RANGE_MAX, SECURITY_SCAN_SPEED_MIN, SECURITY_SCAN_SPEED_MAX,
    SECURITY_DRONE_HP, SECURITY_DRONE_HIT_RADIUS, SECURITY_DRONE_DEATH_MS,
    SECURITY_ROBOT_DRAW_SCALE, SECURITY_DRONE_HIT_TINT_MS, SECURITY_DRONE_HIT_BLINK_COUNT, SECURITY_DRONE_HIT_BLINK_TOTAL_MS,
    // Debug/verification only — PART 5: DRONE behavior profiles, CENTER
    // SCANNER, 3/5/7 count randomization, STORY_STAGE_PLAN/bossEncounterIndex
    // separation, FINAL STAGE DRONEs, DRONE-explosion-damages-GABRIEL.
    SECURITY_BEHAVIOR_TYPES, SECURITY_BEHAVIOR_MULTIPLIERS,
    CENTER_SCAN_SLOW_FACTOR, CENTER_SCAN_DURATION_MIN_MS, CENTER_SCAN_DURATION_MAX_MS,
    CENTER_SCAN_RETURN_SPEED, CENTER_SCAN_COOLDOWN_MIN_MS, CENTER_SCAN_COOLDOWN_MAX_MS,
    SECURITY_DRONE_COUNT_CHOICES, FINAL_STAGE_DRONE_COUNT, FINAL_DRONES_PER_AREA, FINAL_STAGE_DRONE_SPEED_MULTIPLIER,
    pickSecurityBehaviorTypes, buildSecurityDrone, pickSecurityDroneCount, pickSecurityDroneSpot,
    populateSecurityDroneAreas, spawnFinalStageDrones, spawnFinalStageDronesForArea, updateCenterScannerMovement,
    STORY_STAGE_PLAN, BOSS_ENCOUNTER_BARREL_COUNTS,
    get bossEncounterIndex() { return bossEncounterIndex; },
    set bossEncounterIndex(v) { bossEncounterIndex = v; }, // debug/verification only
    get storyDroneBgIndex() { return storyDroneBgIndex; },
    set storyDroneBgIndex(v) { storyDroneBgIndex = v; }, // debug/verification only
    isStoryDroneStage, isFinalStoryStage, isSecurityDroneSystemActive,
    enterStoryStage, pickFreshStoryDroneBackground,
    // Debug/verification only — this turn: input-lock root-cause fix
    // (SECTION A), all-DRONE-kill EXIT gating (SECTION E), RETRY (SECTION J).
    isDroneStageCleared, resetModeState, retryCurrentRun,
    getPlayerFootWorldPosition, SECURITY_FOOT_DETECT_RADIUS,
    // Debug/verification only — this turn's DRONE fast-type/wave/damage work.
    get finalDroneRespawnedByArea() { return finalDroneRespawnedByArea; },
    set finalDroneRespawnedByArea(v) { finalDroneRespawnedByArea = v; }, // debug/verification only
    spawnFinalStageDrones, spawnFinalStageDronesForArea, populateSecurityDroneAreas,
    FINAL_STAGE_DRONE_EXPLOSION_BOSS_DAMAGE, FINAL_STAGE_DRONE_EXPLOSION_BOSS_DAMAGE_MULTIPLIER,
    // Debug/verification only — this turn's GABRIEL DEFENSE-counter work
    // (STRAIGHT_CLAW_TRIGGER_GUARDS is already exposed above).
    spawnStraightClaw, isPlayerInvulnerable,
    // Debug/verification only — AREA1<->AREA2 (and bonus-band) door-collision fix.
    getFloorXRangeWorld, getStageDrawMetrics, AREA_BOUNDARY_DOOR_BAND, getAreaBoundaryYs,
    getDronePlacementRangeX, clampPlayerToScreen,
    get W() { return W; }, get H() { return H; },
    get spriteAspect() { return spriteAspect; }, SPRITE_DRAW_H,
    // Debug/verification only — PART7: RELOAD system.
    FIRE_MAG_SIZE, FIRE_COOLDOWN_MS, triggerManualReload,
    // Debug/verification only — PART7: healing item system.
    healItem, spawnHealItem, getHealItemSpawnPos, HEAL_ITEM_HEAL_FRAC, HEAL_ITEM_IMAGES, HEAL_ITEM_HIT_RADIUS,
    HEAL_ITEM_FRAME1_SCALE, healPickupTexts, HEAL_PICKUP_TEXT_MS,
    // Debug/verification only — PART8: separate manual/auto reload durations,
    // counter-CLAW speed, and the shared Area-wall/LOS helper.
    MANUAL_RELOAD_MS, EMPTY_RELOAD_MS, COUNTER_CLAW_SPEED_MULTIPLIER, segmentCrossesAreaWall,
    // Debug/verification only — PART7: FINAL-STAGE DRONE drop-in.
    FINAL_DRONE_DROP_MS,
  };

  // ---------- Main loop ----------
  let lastTime = performance.now();

  function update(dt, now) {
    if (gameState.paused) return; // PAUSE freezes everything: no movement, AI, bullets, timers
    updateDarkPhaseOverlay(dt); // always ticks whenever unpaused, regardless of stage-transition/intro state below
    updateStageTransition(now); // always ticks, even while frozen below
    if (stageTransition.active) {
      // Freezes player input/movement/barrels for the whole short fade
      // sequence, same spirit as the INTRO freeze below — updateBoss still
      // runs so a freshly-spawned boss's own intro timer can start advancing
      // during the fade-in, exactly like a normal BOSS MODE start.
      updateBoss(dt, now);
      updateScreenFlashes(dt); // SECTION R/S: intro-start/landing flashes must keep ticking here too, not just in the normal post-intro path below
      return;
    }
    if (boss.state === 'intro') {
      // The BOSS MODE intro cinematic freezes player movement/FIRE/DASH/AIM,
      // barrels, and the boss's own combat AI entirely — only the intro's
      // own phase timer (inside updateBoss()) advances. THRESHOLD and DYING
      // do NOT freeze gameplay this way (only the boss's own AI/hittability
      // pauses for those — see bossIsInCinematic() usage elsewhere), so
      // this early-return only applies to 'intro'.
      updateBoss(dt, now);
      // SECTION R/S: both new intro flashes fire and must animate/decay
      // WHILE boss.state === 'intro' (that's the whole point — they mark the
      // intro trigger and the landing moment), so this early-return path
      // must tick them too, not just the normal non-intro path further down.
      updateScreenFlashes(dt);
      return;
    }

    const kb = getKeyboardVec();
    let vx = actionStickVec.x + kb.x;
    let vy = actionStickVec.y + kb.y;
    const mag = Math.hypot(vx, vy);
    if (mag > 1) { vx /= mag; vy /= mag; }

    // Knockback lockout — deliberately short (a few hundred ms, not a full
    // stun), but while it's active MOVE/AIM/FIRE are ALL suppressed, not
    // just movement: a player who gets knocked back must not be able to
    // keep the pressure on by simply re-aiming and firing again the instant
    // the shove itself finishes resolving.
    const knockbackLocked = now < player.knockbackUntil;
    // PART 8/SECTION H: the boss INTRO cinematic (and the pre-spawn wait
    // before it — isBossIntroLocked() covers both) locks MOVE translation/
    // AIM/FIRE/DASH/FLASH/STEALTH completely — the player must stay exactly
    // where PART 1/spawnBoss() placed them for the whole sequence.
    // handleAimStickMove() has its own matching early-return so AIM can't
    // sneak baseDir changes in around this per-frame gate either. SECTION H
    // reverses the previous exception: AIM STICK is now the one fully inert
    // control during this window, while MOVE STICK is explicitly still
    // allowed to change FACING ONLY (never translation, which stays gated
    // on moveStickPushed below).
    const introLocked = isBossIntroLocked();
    // SECTION C: STUN blocks MOVE completely — unlike introLocked, it never
    // gets the "MOVE STICK still changes facing" carve-out below, so it's
    // tracked as its own flag rather than folded into introLocked itself
    // (see isStunLocked()'s own comment for why).
    const stunLocked = isStunLocked();
    const anyMoveLock = introLocked || stunLocked;

    const moveStickPushedRaw = mag > ACTION_STICK_DEADZONE;
    const moveStickPushed = !anyMoveLock && moveStickPushedRaw;
    // PART 9/10: facing follows the AIM STICK whenever it's actively
    // engaged (dragging, or a double-tap snap still locked in) — see
    // handleAimStickMove()/performNearestAutoAimSnap(), which update
    // player.baseDir directly. MOVE STICK only drives facing the rest of
    // the time, exactly as before. aimEngaged is forced false throughout
    // anyMoveLock (AIM STICK is inert then), so the facing check below
    // naturally falls through to MOVE STICK during that window.
    const aimEngaged = !anyMoveLock && (aimStickActive || now < aimDoubleTapLockUntil);
    // SECTION H's facing-only exception is introLocked-only — STUN (E-3)
    // blocks MOVE STICK entirely, with no facing carve-out.
    if (!aimEngaged && (moveStickPushed || (introLocked && !stunLocked && moveStickPushedRaw))) {
      const moveAngle = Math.atan2(vy, vx);
      setBaseDir(stickAngleToBucket(moveAngle, player.baseDir));
    }
    // PART 23-27: MOVE now takes priority over FIRE, the reverse of the old
    // rule — actually walking (MOVE STICK past its deadzone) is decided
    // FIRST, from MOVE STICK/DASH/knockback alone, never from whether FIRE
    // happens to be held; isFiringHeld below is then gated on NOT walking,
    // so holding FIRE while the stick is pushed does nothing at all (no
    // shot, no fire sprite, movement never interrupted) instead of the old
    // walk/fire sprite flicker. Stationary + AIM (with or without a shot
    // actually landing yet) still fires freely, tap or held, exactly as
    // before.
    const moving = moveStickPushed && !player.dashing && !knockbackLocked;
    player.moving = moving;
    // PART 7/8: holding FIRE forces an immediate, full stop — no
    // translation, no walk animation — but only when not already walking
    // (see above); does not touch an already-in-progress DASH (a self-
    // contained burst — see PART 21, which instead stops a NEW dash from
    // starting while this is true).
    const isFiringHeld = !knockbackLocked && !anyMoveLock && !moving && (fireHeld || keys.fire);

    // SECTION B: any genuine, currently-engaged MOVE/AIM/FIRE input counts
    // as combat activity for the watchdog — DASH/FLASH/STEALTH (momentary
    // presses) bump this at their own press handlers instead. Deliberately
    // NOT gated on anyMoveLock/isFiringHeld — holding a control during a
    // lock (e.g. absent-mindedly holding MOVE through BOSS INTRO) still
    // proves the player is present, so it should still count.
    if (moveStickPushedRaw || aimStickActive || fireHeld || keys.fire) {
      lastPlayerInputAt = now;
    }

    // SECTION B/C/L: CONTROL RECOVERY WATCHDOG. Reaching this line already
    // rules out LOADING/OPENING/MAIN MENU/SETTING/RESULT/GAME OVER/
    // landscape-block (update() only runs on screen==='gameplay' and
    // !isLandscapeBlocked(), see loop()) and PAUSE/STAGE TRANSITION/BOSS
    // INTRO (each returns out of update() before this point) — the
    // remaining exclusions (GAME CLEAR, already-STUNned) are checked
    // explicitly below. "battle active" is interpreted as boss spawned and
    // not mid-cinematic (threshold/dying/dead), since the player has
    // nothing to meaningfully react to otherwise.
    // PART 4 SECTION A: STUN is now treated as an in-world effect of
    // GABRIEL's own presence/fear, not a generic operator-error penalty —
    // reverted here to strictly 'boss' mode only (PART 2/3 had briefly
    // extended it to SECURITY TRAINING; that is explicitly retired). Plain
    // 'training' (BASIC TRAINING) was never included here either, so both
    // TRAINING modes are now STUN-less for the same reason: neither ever
    // has GABRIEL spawned (A-5).
    // DARK OUT PART 3: BOSS BATTLE MODE's GABRIEL fight gets the SAME STUN
    // watchdog GABRIEL always has in STORY MODE — this is GABRIEL's own
    // presence/fear mechanic (per the comment above), so sharing GABRIEL's
    // implementation as-is (spec's own explicit requirement) means sharing
    // this too, not a new behavior invented for BOSS BATTLE MODE.
    const battleActiveForWatchdog = (gameState.mode === 'boss' || gameState.mode === 'bossBattle') && boss.spawned && !bossIsInCinematic();
    if (battleActiveForWatchdog && !player.stunned && gameClearRemainingMs <= 0) {
      if (detectControlStateCorruption() || now - lastPlayerInputAt >= CONTROL_WATCHDOG_IDLE_MS) {
        triggerStun(now);
      }
    }
    updateStunVisuals(); // keeps the CONTROL PANEL blackout / PAUSE button color live every frame

    updateDash(now); // may override player.x for the duration of a DASH
    if (!player.dashing && moving && !knockbackLocked) {
      player.x += vx * player.speed * dt;
      player.y += vy * player.speed * dt;
    }

    // Clamp to screen bounds (keep character fully visible)
    clampPlayerToScreen();

    // SECTION A (rework): AREA 1 + AREA 2 are ONE continuous 2-screen-tall
    // stage, not two separate encounters — `currentArea` only ever tracks
    // the player's LIVE position (purely for barrel-spawn margins/HUD
    // composition), it is never a boss-encounter trigger. The one and only
    // BOSS INTRO happens once per GABRIEL ENCOUNTER, from enterStoryStage()'s
    // own direct spawnBoss() call the instant a boss-type STORY_STAGE_PLAN
    // entry is entered (always while currentArea is still 1) — crossing
    // into AREA 2 is a pure world/camera
    // position change with NO side effects on boss/player state, no
    // re-spawn, no screen shake, no bullet/barrel reset. The boss itself is
    // the same persistent entity across the whole combined world — see its
    // own CHASE-state clamp below, which no longer snaps it to whichever
    // area the PLAYER currently stands in.
    // SECTION 15-18: this whole AREA 1/AREA 2 system was previously gated
    // on `H >= W` (portrait only) — but style.css itself documents that
    // "this game is primarily played in landscape" (PART 17), so on a real
    // device in its actual primary orientation, currentArea/area1Cleared
    // never updated at all and the stage never appeared as 2 areas, no
    // matter how thoroughly a portrait-viewport test verified the
    // underlying logic. The camera-scroll math itself (cameraY, the
    // "cover"-style background tiling below) has no dependency on aspect
    // ratio, so removing the orientation restriction is enough — it now
    // runs identically in landscape and portrait.
    // SECTION B (this turn): TRAINING MODE now gets the SAME AREA1+AREA2
    // world tracking as BOSS MODE — investigation found the player
    // "disappearing" past AREA1 in TRAINING was never a clamp bug
    // (clampPlayerToScreen() below already allows the full AREA1+AREA2
    // band in EVERY mode, ungated on gameState.mode) but a camera bug: the
    // whole currentArea/cameraY-follow block was gated to `=== 'boss'`
    // only, so in TRAINING the player's world.y legitimately walked into
    // AREA2's negative-y band while cameraY stayed pinned at 0 forever —
    // rendering the player above the visible canvas. Extending both gates
    // below to include 'training' fixes this while changing nothing about
    // the BOSS MODE behavior itself (identical condition, just also true
    // for the other mode).
    // DARK OUT PART 3: 'bossBattle' added to this gate (and the camera-
    // follow gate just below) — BOSS BATTLE MODE's GABRIEL fight needs the
    // exact same 2-area world/camera tracking STORY's own GABRIEL encounters
    // already get; TRAINING/SECURITY TRAINING behavior is unchanged.
    if (gameState.mode === 'boss' || gameState.mode === 'training' || gameState.mode === 'securityTraining' || gameState.mode === 'bossBattle') {
      currentArea = player.y < 0 ? 2 : 1;
      // AREA 1 clear (C-13): the one shared boss fully dissolved while the
      // player happened to be standing in AREA 1's band. boss.state can
      // only ever reach 'dead' when gameState.mode === 'boss' or 'bossBattle'
      // (updateBoss() itself early-returns for every other mode — see its
      // own top-of-function comment), so this remains structurally
      // unreachable in TRAINING regardless of the widened gate above —
      // satisfying B-5's "never connect AREA crossing to boss spawn/stage
      // transition" for TRAINING without needing a separate mode check here.
      if (!area1Cleared && boss.state === 'dead' && currentArea === 1) {
        area1Cleared = true;
      }
      // AREA 2 clear (C-20): same boss, same 'dead' state, just read while
      // the player is standing in AREA 2's band instead (e.g. they walk up
      // to it after the kill) -> the existing EXIT/stage-transition
      // machinery (unchanged) takes over from here. Same B-5 reasoning as
      // above: unreachable in TRAINING since boss.state never leaves
      // 'inactive' there.
      if (!area2Cleared && boss.state === 'dead' && currentArea === 2) {
        area2Cleared = true;
      }
    }

    // Camera + EXIT (PART 21-29, extended by SECTION C) — smooth-follows
    // the player vertically through AREA 1 -> AREA 2 -> (once
    // worldScrollUnlocked()/trainingWorldScrollUnlocked()) the small bonus
    // EXIT-hunting space, clamped so it never scrolls past whichever band
    // is currently unlocked (C-10). Reaching the EXIT is never automatic:
    // the player must physically walk into that zone themselves. PART 4
    // SECTION K/L: TRAINING (both BASIC and SECURITY) now ALSO reaches its
    // own EXIT/advance-stage branch here — trainingWorldScrollUnlocked() is
    // never gated behind a "clear" flag, so this is always open for
    // TRAINING (unlike STORY's worldScrollUnlocked()).
    const scrollUnlockedHere = worldScrollUnlocked() || trainingWorldScrollUnlocked();
    if ((gameState.mode === 'boss' || gameState.mode === 'training' || gameState.mode === 'securityTraining' || gameState.mode === 'bossBattle') && !stageTransition.active) {
      // SECTION G: AREA 1 + AREA 2's own band is always unlocked now — only
      // the further post-clear bonus space beyond it stays gated.
      const minCameraY = scrollUnlockedHere ? -H - worldExtraAbove : -H;
      const targetCameraY = Math.max(minCameraY, Math.min(0, player.y - H * 0.6));
      // Exponential smoothing (C-9): closes (1 - e^(-RATE*dt)) of the
      // remaining distance each frame — framerate-independent, and fast
      // enough (RATE=6) that the player is never left stranded off-screen.
      cameraY += (targetCameraY - cameraY) * Math.min(1, CAMERA_FOLLOW_RATE * dt);
      cameraY = Math.max(minCameraY, Math.min(0, cameraY)); // C-10: never past whichever band is currently unlocked
      if (scrollUnlockedHere) {
        const exit = exitWorldPos();
        if (Math.abs(player.x - exit.x) < EXIT_ZONE_W / 2 && Math.abs(player.y - exit.y) < EXIT_ZONE_H / 2) {
          beginStageTransition(now); // updateStageTransition() itself branches STORY vs TRAINING advance by gameState.mode
        }
      }
    } else {
      cameraY = 0;
    }

    // SECTION D: 30-shot magazine cooldown ticks down here every frame
    // (dt-driven, so it correctly freezes during PAUSE like every other
    // countdown in this file) — once it reaches 0, the magazine auto-resets
    // to a full FIRE_MAG_SIZE and FIRE works again, with no manual reload.
    if (player.ammoCooldownRemainingMs > 0) {
      player.ammoCooldownRemainingMs = Math.max(0, player.ammoCooldownRemainingMs - dt * 1000);
      if (player.ammoCooldownRemainingMs === 0) {
        player.ammo = FIRE_MAG_SIZE;
        player.reloadType = null; // PART8 SECTION AI: no reload in progress once it's actually complete
      }
    }
    updateFireHud();

    // Firing — direction comes from getFinalAimAngle() (the AIM STICK's own
    // absolute angle while aiming, else the current base facing), never
    // from movement. Suppressed entirely during knockbackLocked, same as
    // MOVE/AIM. SECTION D: also suppressed while the magazine is empty and
    // cooling down — never bypasses AIM/muzzle/trajectory/AUTO AIM, purely
    // an extra gate in front of the existing fire trigger. PART7 SECTION N:
    // also suppressed for the full RELOAD duration even when triggered
    // manually at partial ammo (ammoCooldownRemainingMs > 0 with ammo still
    // >0) — MOVE/AIM/DASH/STEALTH/FLASH are untouched by this gate.
    const wantsFire = isFiringHeld && player.ammo > 0 && player.ammoCooldownRemainingMs <= 0;
    if (wantsFire && now - lastFireTime >= FIRE_INTERVAL) {
      lastFireTime = now;
      spawnBullet();
      player.ammo--;
      if (player.ammo <= 0) {
        player.ammo = 0;
        player.reloadType = 'auto'; // PART8 SECTION A: empty-magazine reload always uses EMPTY_RELOAD_MS, never the manual duration
        player.ammoCooldownRemainingMs = EMPTY_RELOAD_MS;
      }
      // STEALTH reveal (PART 17/18/20): firing — manual or AUTO-AIM-assisted,
      // no distinction — reveals the player's CURRENT position to GABRIEL
      // for the rest of this STEALTH window, without ending STEALTH itself
      // or cancelling its timer. Overwritten by each subsequent shot; never
      // updated by mere movement, so GABRIEL doesn't auto-follow afterward.
      if (now < player.stealthUntil) {
        boss.revealedShotX = player.x;
        boss.revealedShotY = player.y;
      }
    }

    // SOUTH RELAXED IDLE: any input activity resets the idle clock; it only
    // engages after RELAXED_IDLE_DELAY_MS of total silence while facing
    // south, and drops out the instant any input resumes (checked fresh
    // every frame, not just on a timer).
    const inputActive = moving || aimStickActive || wantsFire || player.dashing;
    if (inputActive) player.lastActivityAt = now;
    player.relaxed = player.baseDir === 'down' && !player.dashing &&
      (now - player.lastActivityAt) >= RELAXED_IDLE_DELAY_MS;

    if (!knockbackLocked && !introLocked) updateAutoAim(now); // AIM is locked (frozen, not reset) for the same window as MOVE/FIRE

    // Update bullets — weak point is checked first (only matters while
    // boss.state === 'defense'), body hurtbox otherwise, then alive barrels.
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      const prevBx = b.x, prevBy = b.y;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // PART8 SECTION N: an Area-boundary WALL vanishes the bullet on the
      // spot, same as the left/right screen-edge wall just below — checked
      // as a segment from last frame's position to this one so a fast
      // bullet can never tunnel through the wall between two frames.
      if (segmentCrossesAreaWall(prevBx, prevBy, b.x, b.y)) {
        bullets.splice(i, 1);
        continue;
      }
      // LEFT/RIGHT wall contact: the bullet simply vanishes on the spot —
      // no ricochet/bounce of any kind (the previous mirror-reflection
      // system, its reflection-angle math, its post-bounce "flank" damage
      // bypass, and its dedicated wall-spark VFX have all been removed).
      if (b.x <= 0 || b.x >= W) {
        bullets.splice(i, 1);
        continue;
      }
      if (b.x < -20 || b.x > W + 20 || b.y < cameraY - 20 || b.y > cameraY + H + 20) {
        bullets.splice(i, 1);
        continue;
      }
      let consumed = false;
      // TELEPORT (PART 7): GABRIEL isn't drawn and has no physical presence
      // at all for the whole sequence — bullets simply pass through, same
      // as if it weren't spawned. SECTION C: DARK PHASE's own fully-hidden
      // window is the same — no hitbox at all until the mask reappears.
      if (boss.spawned && boss.state !== 'dead' && boss.state !== 'teleport' && !isDarkPhaseHidden()) {
        // Genuine physical hitbox overlap only — never inferred from "same
        // direction as the sprite". getWeakPointScreenPos returns null for
        // a direction with no visible eye (NORTH), so a bullet can never
        // register a weak-point hit while defending that way.
        let wpPos = null;
        let weakPointHit = false;
        if (boss.state === 'defense') {
          wpPos = getWeakPointScreenPos(boss.defenseDir);
          weakPointHit = !!wpPos && Math.hypot(b.x - wpPos.x, b.y - wpPos.y) <= WEAKPOINT_HIT_RADIUS;
        }
        const bodyHit = !weakPointHit && Math.hypot(b.x - boss.x, b.y - boss.y) <= BOSS_HURT_RADIUS;
        if (weakPointHit || bodyHit) {
          shotsHit++; // SECTION Q-2: any genuine bullet-vs-boss contact counts toward ACCURACY, regardless of what happens next (point-blank counter/weak point/body damage) — FLASH is a separate mechanic, never counted here
          // POINT-BLANK counter (PART 5): scoped away from DARK PHASE/FLASH
          // DOWN/any cinematic — those are already fully invulnerable (or,
          // for DARK PHASE, deliberately built around GABRIEL closing to
          // melee range) and must never be affected by this.
          const pointBlankGated = boss.state !== 'darkphase' && boss.state !== 'flashdown' && !bossIsInCinematic();
          if (pointBlankGated && now < boss.closeRangeInvulnUntil) {
            consumed = true; // still inside the counter's own brief invulnerability window
          } else if (pointBlankGated && Math.hypot(player.x - boss.x, player.y - boss.y) <= CLOSE_RANGE_SHOT_THRESHOLD) {
            triggerCloseRangeCounter(now);
            consumed = true;
          } else if (weakPointHit) {
            applyWeakPointHitToBoss(now, b.autoAimedBoss, b.x, b.y, b.vx, b.vy);
            consumed = true;
          } else {
            applyBodyHitToBoss(now, b.x, b.y, b.vx, b.vy, b.autoAimedBoss);
            consumed = true;
          }
        }
      }
      if (!consumed) {
        for (const barrel of barrels) {
          if (!barrel.alive) continue;
          if (Math.hypot(b.x - barrel.x, b.y - barrel.y) <= BARREL_HITBOX_RADIUS) {
            explodeBarrel(barrel, now);
            consumed = true;
            break;
          }
        }
      }
      // PART 3 SECTION E: normal FIRE hitting a DRONE — gated on
      // isSecurityDroneSystemActive() (PART 5) rather than just
      // securityRobots happening to be non-empty, so this stays
      // structurally impossible outside SECURITY TRAINING, STORY's
      // DRONE-type STAGEs, and the FINAL STAGE (SECTION S).
      if (!consumed && isSecurityDroneSystemActive()) {
        for (const robot of securityRobots) {
          if (robot.hp <= 0) continue;
          if (Math.hypot(b.x - robot.x, b.y - robot.y) <= SECURITY_DRONE_HIT_RADIUS) {
            applyDamageToSecurityDrone(robot, now);
            consumed = true;
            break;
          }
        }
      }
      // PART7 SECTION U/V: the player's own bullet (this loop is the SHOT
      // pipeline only — DRONE LASER/GABRIEL CLAW/enemy projectiles/DRONE
      // explosion/player contact/DASH/STEALTH/FLASH never reach this code
      // path at all) is the ONLY thing that can destroy/trigger a healing
      // item. Marked inactive immediately (SECTION U: never usable twice)
      // before the heal is applied, and the bullet is consumed like any
      // other hit.
      if (!consumed && healItem.active) {
        if (Math.hypot(b.x - healItem.x, b.y - healItem.y) <= HEAL_ITEM_HIT_RADIUS) {
          healItem.active = false;
          player.life = playerMaxLife === Infinity ? Infinity : Math.min(playerMaxLife, player.life + playerMaxLife * HEAL_ITEM_HEAL_FRAC);
          spawnHealPickupText(healItem.x, healItem.y, now); // PART8 SECTION W
          consumed = true;
        }
      }
      if (consumed) bullets.splice(i, 1);
    }

    updateBarrels(dt, now);
    updateHealItem(dt); // PART7 SECTION S/Q: dt-driven, freezes during PAUSE like every other timer here
    updateSecurityRobots(dt, now);
    updateFlashGrenade(dt, now);
    updateScreenFlashes(dt);
    updateStealth(dt, now);
    updateBoss(dt, now);
    updateArcClawSlashes(now);

    // DARK OUT PART 3 SECTION 16: detect GABRIEL's defeat inside BOSS
    // BATTLE MODE right as it happens (same frame updateBossDying() flips
    // boss.state to 'dead', matching GAME CLEAR's own timing for the STORY
    // FINAL STAGE) — a pure addition, never touching updateBossDying()/
    // isFinalStoryStage() themselves, so STORY's own GAME CLEAR condition
    // (which requires gameState.mode === 'boss', never 'bossBattle' — see
    // isFinalStoryStage()) is completely unaffected.
    if (bossBattleState.active && boss.state === 'dead' && !bossBattleState.defeatHandled) {
      triggerBossBattleDefeat(now);
    }
  }

  function currentPose(now) {
    // Alternates AIM -> FIRE -> AIM in sync with each shot, instead of
    // sticking on FIRE for the whole time the button is held.
    return (now - lastFireTime < FIRE_POSE_DURATION) ? 'fire' : 'aim';
  }

  // ---------- Bullet rendering: elongated tracer, not a circle ----------
  function drawBullet(b) {
    const angle = Math.atan2(b.vy, b.vx);
    const len = 18;
    const halfW = 3;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(angle);

    // Tapered tail-to-nose body with a gradient from dim orange (tail) to
    // bright near-white (nose) — a tracer streak, not a round ball.
    const grad = ctx.createLinearGradient(-len * 1.3, 0, len * 0.55, 0);
    grad.addColorStop(0, 'rgba(255,120,20,0)');
    grad.addColorStop(0.5, 'rgba(255,140,30,0.65)');
    grad.addColorStop(1, 'rgba(255,235,180,0.95)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(len * 0.55, 0);
    ctx.lineTo(len * 0.1, -halfW);
    ctx.lineTo(-len * 1.3, -halfW * 0.3);
    ctx.lineTo(-len * 1.3, halfW * 0.3);
    ctx.lineTo(len * 0.1, halfW);
    ctx.closePath();
    ctx.fill();

    // Bright glowing tip
    ctx.fillStyle = 'rgba(255,250,215,0.95)';
    ctx.beginPath();
    ctx.ellipse(len * 0.32, 0, len * 0.22, halfW * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // Scope/reticle marker: ring + 4 outward tick marks + tiny center dot.
  // Turns red while AUTO AIM has a target engaged (PART 2/3).
  function drawReticle(x, y, hot) {
    const r = 7;
    const gap = 2;
    const tick = 4;
    const color = hot ? 'rgba(255,70,60,0.95)' : 'rgba(255,255,255,0.9)';
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, -(r + gap)); ctx.lineTo(0, -(r + gap + tick));
    ctx.moveTo(0, r + gap); ctx.lineTo(0, r + gap + tick);
    ctx.moveTo(-(r + gap), 0); ctx.lineTo(-(r + gap + tick), 0);
    ctx.moveTo(r + gap, 0); ctx.lineTo(r + gap + tick, 0);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------- Aim prediction line: dotted, matches the actual firing angle ----------
  // Its length is the fixed AIM_GUIDE_LEN (RANGE gauge removed, PART 12) —
  // a purely visual "where am I precisely aiming" indicator, never bullet
  // travel distance (bullets always fly their own full lifetime regardless
  // — see spawnBullet()). While AUTO AIM is genuinely locked onto
  // something, the guide instead snaps to that target's real distance so
  // the reticle visibly sits on it.
  function drawAimLine() {
    if (!aimStickActive) return;
    const angle = getFinalAimAngle();
    // PART 12: the guide starts from the EXACT SAME point spawnBullet() uses
    // — never player-center, never its own independent radial calc — so
    // east/west (whose muzzle is a fixed sprite-relative point, not a
    // rotating radial one) can never visually diverge from the real bullet
    // spawn again.
    const muzzle = getMuzzleWorldPosition(angle);
    const bx = muzzle.x, by = muzzle.y;
    let guideLen = AIM_GUIDE_LEN;
    if (autoAimActive && autoAimLockedPoint) {
      guideLen = Math.hypot(autoAimLockedPoint.x - bx, autoAimLockedPoint.y - by);
    }
    const ex = bx + Math.cos(angle) * guideLen;
    const ey = by + Math.sin(angle) * guideLen;

    // SECTION H: red now means EXACTLY ONE thing, unconditionally — "a
    // FLASH thrown right now would hit" — canFlashTarget() is the SAME
    // predicate flashPress() checks, so the two can never disagree, in ANY
    // situation. Previously, aiming at something other than GABRIEL (a
    // barrel, or nothing) fell back to the plain AUTO AIM magnet flag,
    // which could be true with no relation to FLASH at all (e.g. locked
    // onto a barrel) — that's exactly the "red but FLASH can't fire" bug
    // this section reports. There is no more such fallback: a barrel/no
    // lock now always reads as the ordinary white line.
    const isLocked = canFlashTarget();
    ctx.save();
    ctx.strokeStyle = isLocked ? 'rgba(255,90,80,0.6)' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    drawReticle(ex, ey, isLocked);
  }

  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    // Barrel-explosion camera shake: a small temporary translate applied to
    // every canvas draw below, restored at the end of this function. Purely
    // visual — world coordinates (hit tests, positions) never see it.
    ctx.save();
    const shake = getScreenShakeOffset(now);
    ctx.translate(shake.x, shake.y);

    // ---- World content (PART 21-29): everything below is drawn in WORLD
    // space, shifted by the vertical scroll camera. Before the boss is
    // fully dead, cameraY is always 0, so this is pixel-identical to the
    // original single-screen rendering. ----
    const stage = currentStage();
    // SECTION 15-18: no longer restricted to portrait — the "cover"-style
    // scale formula below (Math.max(W/iw, H/ih)) already works correctly
    // for any aspect ratio, so the only real gate is whether the image
    // itself has loaded.
    const stageOn = stage.ready;
    ctx.save();
    ctx.translate(0, -cameraY);

    if (stageOn) {
      // Portrait viewport: draw the stage floor image "cover"-style —
      // uniformly scaled (never stretched on one axis only) so it fills the
      // screen, center-cropping only the minimum needed on one axis. Tiled
      // vertically (same real pixels, no distortion) to also cover the
      // extra world space above the original screen once unlocked — this
      // is what gives the world its extra vertical extent post-victory.
      const { iw, ih, scale, dw, dh, dx, baseDy } = getStageDrawMetrics(stage);
      // SECTION C: the tiled column now needs to reach past AREA 2's own
      // full screen-height band (H) as well as the further post-clear EXIT
      // bonus space beyond it — same single background asset the whole
      // way up, never a different image per area (C-2/C-3/C-7).
      const topLimit = -H - worldExtraAbove - dh;
      for (let y = baseDy; y > topLimit; y -= dh) {
        ctx.drawImage(stage.img, dx, y, dw, dh);
      }
      // SECTION M-3: a small per-stage light tint distinguishes the two
      // INDOOR stages (lab_b03/stage_a) from each other and from the
      // OUTDOOR one, using only CSS/Canvas color — no new art.
      if (stage.lightTint && stage.lightTint !== 'rgba(0,0,0,0)') {
        ctx.fillStyle = stage.lightTint;
        ctx.fillRect(0, cameraY, W, H);
      }
    } else {
      // Landscape (or image not yet loaded): unchanged original background.
      ctx.fillStyle = '#131416';
      ctx.fillRect(0, cameraY, W, H);

      // subtle ground grid for spatial reference (minimal, non-intrusive)
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      const grid = 64;
      for (let gx = (W / 2) % grid; gx < W; gx += grid) {
        ctx.beginPath(); ctx.moveTo(gx, cameraY); ctx.lineTo(gx, cameraY + H); ctx.stroke();
      }
      for (let gy = cameraY - (((cameraY % grid) + grid) % grid); gy < cameraY + H; gy += grid) {
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
      }
    }

    // Barrels sit on the ground, above the background but below the
    // characters (drawn next), same as an ordinary game object. Falling
    // (not-yet-landed) barrels draw too, via their own in-air pose.
    for (const b of barrels) if (b.alive || b.falling) drawBarrel(b);
    drawHealItem(); // PART7 SECTION T: sits in the worldExtraAbove bonus band, same painter layer as barrels
    drawHealPickupTexts(now); // PART8 SECTION W: "HP+30%！" floating text, world-space, drawn above the item's own layer
    for (let i = barrelLandings.length - 1; i >= 0; i--) {
      const l = barrelLandings[i];
      if (now - l.startAt >= BARREL_LANDING_MS) { barrelLandings.splice(i, 1); continue; }
      drawBarrelLanding(l, now);
    }
    for (const e of explosions) drawExplosion(e, now);

    // PART 2: SECURITY ROBOT shadows + bodies draw as ordinary ground-layer
    // objects, same layer as barrels — securityRobots is always empty
    // outside SECURITY TRAINING (spawnSecurityRobots() is only ever called
    // from resetModeState() when gameState.mode === 'securityTraining'), so
    // this is a safe no-op in every other mode (SECTION S).
    for (const robot of securityRobots) drawSecurityShadow(robot);
    for (const robot of securityRobots) drawSecurityRobot(robot, now); // PART 4 SECTION E: now() drives the per-robot hit-flash blink timing

    // DARK PHASE screen-darken: drawn HERE — under the bullets/claw attacks/
    // player/boss below, not as a final overlay on top of everything — so it
    // can go near-total-black (see DARKPHASE_OVERLAY_ALPHA) without also
    // hiding the things that must stay clearly visible per spec: the
    // player, their bullets, and GABRIEL's own glowing eye. Everything
    // drawn ABOVE this point (background, barrels, barrel landings,
    // explosions) gets buried under it; everything drawn BELOW stays at
    // full brightness. Mutually exclusive with the ambient stage-lighting
    // drift at the end of this function (see the `darkPhaseOverlayAlpha <=
    // 0` guard there) so the two can never compete/flicker together.
    if (darkPhaseOverlayAlpha > 0) {
      ctx.fillStyle = `rgba(4, 4, 8, ${darkPhaseOverlayAlpha})`;
      ctx.fillRect(0, cameraY, W, H);
    }

    // bullets
    for (const b of bullets) drawBullet(b);
    drawFlashGrenade();

    // ARC CLAW SLASH / CLAW STING draw alongside the player's own bullets.
    for (const s of arcClawSlashes) drawArcClawSlash(s);

    // Player and boss are painter-sorted by Y so whichever is visually
    // "closer" (further down the screen) draws on top of the other. TELEPORT
    // (PART 7) never draws the boss at all — it has no visible presence for
    // the whole sequence, covered by the blackout regardless.
    const bossVisible = boss.spawned && boss.state !== 'teleport';
    if (bossVisible && boss.y < player.y) {
      drawBoss(now);
      drawPlayer(now);
    } else {
      drawPlayer(now);
      if (bossVisible) drawBoss(now);
    }
    drawReloadingText(now); // PART7 SECTION P: drawn in this same world-translated block so it follows the player through camera scroll

    // PART 2: laser beams draw crossing over the player/boss layer, so the
    // shot itself is never hidden behind either — still world-space (before
    // the camera-translate restore() below), same origin/endpoint the
    // damage hitbox already used at fire-time.
    for (const robot of securityRobots) drawSecurityLaserBeam(robot);

    // PART 1: the aim line/reticle draw last among game-world content —
    // strictly above the background, barrels, bullets, claw projectiles,
    // player, and boss — so the boss's sprite (or anything else) can never
    // paint over the dashed line or hide the reticle. It stays below the
    // DOM control UI (ACTION/AIM/FIRE/DASH/PAUSE), which is a separate
    // layer entirely and always on top regardless of canvas draw order.
    drawAimLine();

    drawBossFeedback(now);
    drawExitZone(now); // no-op until worldScrollUnlocked() (boss fully dead)

    ctx.restore(); // undo the camera translate — everything below is screen-space

    // SECTION V: PLAYER LIFE / BOSS LIFE / "BOSS: GABRIEL" are pure HUD —
    // drawn AFTER the camera-translate restore() above, so they are true
    // screen-space and can never drift with cameraY (AREA1<->AREA2 scroll,
    // or a future stage's own scroll) the way they did before this fix,
    // when they were mistakenly still inside the world-space translated
    // block above.
    drawBossHud(now);
    drawLifeHud(now);
    drawBossLifeHud(now);

    // Ambient stage lighting: a slow, gentle brightness drift instead of a
    // fixed darkening amount — screen-space and computed independently of
    // the boss-intro FLASH below, so the two can never wash each other out.
    // Suppressed entirely while DARK PHASE's own (much stronger, and drawn
    // much earlier — see above) darken layer is active, so the two never
    // compete/flicker together.
    if (darkPhaseOverlayAlpha <= 0 && stageOn) {
      ctx.fillStyle = `rgba(0, 0, 0, ${getAmbientDarkenAlpha(now)})`;
      ctx.fillRect(0, 0, W, H);
    }

    if (now < playerHitFlashUntil) {
      ctx.fillStyle = 'rgba(220, 30, 30, 0.18)';
      ctx.fillRect(0, 0, W, H);
    }

    // Stage transition fade (PART 26) — a short, simple fade, never a
    // long loading-style sequence; screen-space, on top of everything.
    const stageFadeAlpha = getStageTransitionOverlayAlpha(now);
    if (stageFadeAlpha > 0) {
      ctx.fillStyle = `rgba(6, 8, 10, ${stageFadeAlpha})`;
      ctx.fillRect(0, 0, W, H);
    }

    // WEAK-POINT-SPAM teleport blackout (PART 7) — deliberately a real,
    // full-screen-space opaque cut drawn ON TOP of everything (player
    // included), unlike DARK PHASE's own much lighter, under-the-action
    // darken layer further up — its own separate variable/system
    // (teleportBlackoutAlpha), never touching or driven by
    // darkPhaseOverlayAlpha.
    if (teleportBlackoutAlpha > 0) {
      ctx.fillStyle = `rgba(2, 2, 4, ${teleportBlackoutAlpha})`;
      ctx.fillRect(0, 0, W, H);
    }

    // FLASH GRENADE screen flash — deliberately independent of the ambient
    // stage-lighting drift above (never washes it out or gets washed out by
    // it), brief (<=FLASH_SCREEN_FLASH_MS, within the requested 100-250ms
    // band), always drawn last so it reads as the brightest, topmost thing
    // on screen at the instant it fires.
    if (flashScreenFlashRemainingMs > 0) {
      const alpha = Math.min(1, flashScreenFlashRemainingMs / FLASH_SCREEN_FLASH_MS);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillRect(0, 0, W, H);
    }

    // SECTION K: a few short on/off pulses the instant COUNTER (invulnerable
    // STRAIGHT CLAW) begins — moderate alpha, never fully opaque, so it
    // never blocks the in-canvas HUD/warning text (and CONTROL AREA is a
    // separate DOM region below the canvas, so it can never reach that
    // either).
    if (counterFlashRemainingMs > 0) {
      const elapsedIntoFlash = COUNTER_FLASH_TOTAL_MS - counterFlashRemainingMs;
      const cyclePos = elapsedIntoFlash % COUNTER_FLASH_CYCLE_MS;
      if (cyclePos < COUNTER_FLASH_ON_MS) {
        ctx.fillStyle = `rgba(255,255,255,${COUNTER_FLASH_ALPHA_MAX})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    // U-11: one short, sharp white flash right as GABRIEL's death triggers —
    // a single decaying pulse, distinct from COUNTER's multi-pulse flicker.
    if (deathFlashRemainingMs > 0) {
      const alpha = Math.min(1, deathFlashRemainingMs / DEATH_FLASH_MS);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillRect(0, 0, W, H);
    }

    // SECTION R: a few white/pale-gray pulses the instant the real BOSS
    // INTRO trigger fires (AREA1 only) — its own timer, independent of
    // every other flash here.
    if (introStartFlashRemainingMs > 0) {
      const elapsedIntoFlash = BOSS_INTRO_START_FLASH_TOTAL_MS - introStartFlashRemainingMs;
      const cyclePos = elapsedIntoFlash % BOSS_INTRO_START_FLASH_CYCLE_MS;
      if (cyclePos < BOSS_INTRO_START_FLASH_ON_MS) {
        ctx.fillStyle = `rgba(235,235,240,${BOSS_INTRO_START_FLASH_ALPHA_MAX})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    // SECTION S: a few red pulses the instant GABRIEL's DOWN sprite reaches
    // the ground — its own timer, independent of every other flash here.
    if (landingRedFlashRemainingMs > 0) {
      const elapsedIntoFlash = BOSS_LANDING_RED_FLASH_TOTAL_MS - landingRedFlashRemainingMs;
      const cyclePos = elapsedIntoFlash % BOSS_LANDING_RED_FLASH_CYCLE_MS;
      if (cyclePos < BOSS_LANDING_RED_FLASH_ON_MS) {
        ctx.fillStyle = `rgba(160,10,10,${BOSS_LANDING_RED_FLASH_ALPHA_MAX})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    // SECTION J: ~3 red pulses the instant ENCOUNTER 3's DARK PHASE forces
    // STUN — its own timer, independent of every other flash here (never
    // shared with landingRedFlashRemainingMs above).
    if (encounter3StunFlashRemainingMs > 0) {
      const elapsedIntoFlash = ENCOUNTER3_STUN_FLASH_TOTAL_MS - encounter3StunFlashRemainingMs;
      const cyclePos = elapsedIntoFlash % ENCOUNTER3_STUN_FLASH_CYCLE_MS;
      if (cyclePos < ENCOUNTER3_STUN_FLASH_ON_MS) {
        ctx.fillStyle = `rgba(200,10,10,${ENCOUNTER3_STUN_FLASH_ALPHA_MAX})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    // SECTION P: "GAME CLEAR!!" — drawn last of all, on top of the frozen
    // final gameplay frame (and above every other flash above), simple
    // white/red text per spec rather than a rainbow celebratory effect.
    if (gameClearRemainingMs > 0) {
      const elapsed = GAME_CLEAR_DISPLAY_MS - gameClearRemainingMs;
      const fadeInMs = 300;
      const alpha = Math.min(1, elapsed / fadeInMs);
      ctx.fillStyle = `rgba(0,0,0,${0.45 * alpha})`;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 44px "Arial Narrow", Arial, sans-serif';
      ctx.shadowColor = 'rgba(200,20,20,0.9)';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ffffff';
      ctx.fillText('GAME CLEAR!!', W / 2, H / 2);
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // DARK OUT PART 3 SECTION 16: BOSS BATTLE MODE's own separate "BOSS
    // DEFEATED" overlay — same visual technique as GAME CLEAR above (never
    // shares its variable/branch), but never leads to RESULT.
    if (bossBattleDefeatRemainingMs > 0) {
      const elapsed = BOSS_BATTLE_DEFEAT_DISPLAY_MS - bossBattleDefeatRemainingMs;
      const fadeInMs = 300;
      const alpha = Math.min(1, elapsed / fadeInMs);
      ctx.fillStyle = `rgba(0,0,0,${0.45 * alpha})`;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 40px "Arial Narrow", Arial, sans-serif';
      ctx.shadowColor = 'rgba(200,20,20,0.9)';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ffffff';
      ctx.fillText('BOSS DEFEATED', W / 2, H / 2);
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    ctx.restore(); // matches the shake-translate ctx.save() at the top of this function

    // Expired explosion effects are pruned here rather than in update(),
    // purely so a paused game still shows a mid-explosion frame frozen
    // instead of having it vanish while update() isn't running.
    for (let i = explosions.length - 1; i >= 0; i--) {
      if (now - explosions[i].startAt > EXPLOSION_DURATION_MS) explosions.splice(i, 1);
    }
  }

  // ---------- STEALTH colorless space-distortion compositing ----------
  // No new image files, and the real sprite files on disk are never
  // touched — this draws WHATEVER sprite drawPlayer() would normally show
  // (movement/DASH/FIRE/idle, any of the 4 directions), reworked as of
  // SECTION O: no color tint/glow of any kind anymore (blue, or
  // anything else) — STEALTH is now a colorless "optical camouflage" look:
  // (1) the player sprite itself draws at a reduced, neutral alpha, no
  // recolor at all, and (2) the background immediately behind/around the
  // silhouette visibly warps, as if a transparent body were bending the
  // space there (heat-haze/refraction style) — built entirely from
  // existing canvas drawImage() ops (no getImageData/putImageData, so it
  // stays hardware-accelerated and cheap): the already-rendered main
  // canvas content right where the player is about to be drawn is copied
  // into an offscreen buffer in thin horizontal strips, each strip offset
  // sideways by a small sine wave (a different phase per strip, animated
  // over time), then that warped copy is masked to the player's own
  // opaque silhouette (destination-in against the sprite) and painted back
  // over the same spot — so only the area the body actually occupies
  // reads as distorted, not a plain rectangle.
  const stealthDistortCanvas = document.createElement('canvas');
  const stealthDistortCtx = stealthDistortCanvas.getContext('2d');
  const stealthMaskCanvas = document.createElement('canvas');
  const stealthMaskCtx = stealthMaskCanvas.getContext('2d');
  // 5 more percentage points of transparency than the previous 0.40 —
  // Math.max(0, previous - 0.05), per instruction.
  const STEALTH_ALPHA_ACTIVE_PREVIOUS = 0.40;
  const STEALTH_ALPHA_ACTIVE = Math.max(0, STEALTH_ALPHA_ACTIVE_PREVIOUS - 0.05);
  const STEALTH_DISTORT_STRIPS = 14;
  const STEALTH_DISTORT_AMPLITUDE_PX = 3.5; // max sideways displacement per strip, at full strength
  const STEALTH_DISTORT_PERIOD_MS = 650; // one full wave cycle
  // Debug/verification only — declared after window.__game's own literal
  // above, so appended here rather than inside it (same pattern as
  // window.__game.playerFrame below).
  window.__game.STEALTH_ALPHA_ACTIVE = STEALTH_ALPHA_ACTIVE;
  window.__game.STEALTH_ALPHA_ACTIVE_PREVIOUS = STEALTH_ALPHA_ACTIVE_PREVIOUS;

  function drawPlayerStealthed(img, dx, dy, w, h, strength, now) {
    const cw = Math.max(1, Math.round(w));
    const ch = Math.max(1, Math.round(h));
    if (stealthDistortCanvas.width !== cw || stealthDistortCanvas.height !== ch) {
      stealthDistortCanvas.width = cw;
      stealthDistortCanvas.height = ch;
      stealthMaskCanvas.width = cw;
      stealthMaskCanvas.height = ch;
    }
    // Sample whatever is already drawn on the main canvas right behind the
    // player, sliced into thin horizontal strips each nudged sideways by a
    // sine wave — a lightweight heat-haze/refraction wave, GPU-composited
    // (drawImage from the live canvas element, never a per-pixel JS read).
    const dctx = stealthDistortCtx;
    dctx.clearRect(0, 0, cw, ch);
    const stripH = ch / STEALTH_DISTORT_STRIPS;
    for (let i = 0; i < STEALTH_DISTORT_STRIPS; i++) {
      const sy = i * stripH;
      const wave = Math.sin((now / STEALTH_DISTORT_PERIOD_MS) * Math.PI * 2 + i * 0.9) * STEALTH_DISTORT_AMPLITUDE_PX * strength;
      dctx.drawImage(ctx.canvas, dx, dy + sy, cw, stripH + 1, wave, sy, cw, stripH + 1);
    }
    // Mask the warped copy to the player's own silhouette, so only the
    // body's own shape reads as distorted, never a plain rectangle.
    const mctx = stealthMaskCtx;
    mctx.clearRect(0, 0, cw, ch);
    mctx.drawImage(dctx.canvas, 0, 0);
    mctx.globalCompositeOperation = 'destination-in';
    mctx.drawImage(img, 0, 0, cw, ch);
    mctx.globalCompositeOperation = 'source-over';

    // Paint the masked, warped patch back over the player's own on-screen
    // position (replacing what's directly there with a subtly-shifted
    // version of itself), then the plain sprite on top at reduced,
    // perfectly neutral alpha — no recolor, no glow, no outline.
    ctx.drawImage(stealthMaskCanvas, dx, dy, w, h);
    ctx.save();
    // 1 at strength=0 (fully normal/opaque) -> STEALTH_ALPHA_ACTIVE at strength=1.
    ctx.globalAlpha = 1 - (1 - STEALTH_ALPHA_ACTIVE) * strength;
    ctx.drawImage(img, dx, dy, w, h);
    ctx.restore();
  }

  function drawPlayer(now) {
    let img;
    if (player.dashing) {
      // All 4 cardinal directions have dedicated dash art now.
      img = dashSprites[player.dashDir];
    } else if (player.moving) {
      // Display-only change: ordinary MOVE STICK movement (not a DASH burst)
      // now shows a genuine 3-frame walk cycle for all 4 directions
      // (SOUTH's own 3rd frame completed the set in the 2nd image batch),
      // instead of reusing the static DASH-pose sprite. Pure rendering —
      // speed/distance/invulnerability/DASH itself are all untouched (see
      // updateDash()/player.dashing above, which still takes priority when a
      // real DASH is in progress).
      const walkSet = walkSprites[player.baseDir];
      if (walkSet) {
        const frame = Math.floor(now / PLAYER_WALK_FRAME_PERIOD_MS) % 3;
        img = walkSet[frame];
      } else {
        img = dashSprites[player.baseDir];
      }
    } else if (player.baseDir === 'down' && player.relaxed) {
      img = relaxedSprite.down;
    } else {
      const pose = currentPose(now);
      img = sprites[pose] && sprites[pose][player.baseDir];
    }
    window.__game.playerFrame = img ? img.src.slice(img.src.lastIndexOf('/') + 1).replace('.png', '') : null; // debug/verification only
    if (img && img.complete && img.naturalWidth > 0) {
      spriteAspect = img.naturalWidth / img.naturalHeight;
      const isSideDash = player.dashing && (player.dashDir === 'right' || player.dashDir === 'left');
      const scaleMul = isSideDash ? SIDE_DASH_DISPLAY_SCALE : 1;
      const drawH = SPRITE_DRAW_H * scaleMul;
      const drawW = drawH * spriteAspect;
      const dx = player.x - drawW / 2;
      // Canvas-center (screen x = player.x always, any scale) needs no
      // correction, but the foot row does: a plain center-anchored shrink
      // would otherwise lift east/west DASH's feet off the ground. Solve dy
      // so the foot lands exactly where it would at normal (100%) scale.
      const footFrac = PLAYER_FOOT_Y / PLAYER_CANVAS_H;
      const dy = isSideDash
        ? player.y - SPRITE_DRAW_H / 2 + SPRITE_DRAW_H * footFrac * (1 - scaleMul)
        : player.y - drawH / 2;
      // STEALTH (PART 15 + addendum): whatever sprite was just picked above
      // (idle/walk/DASH/FIRE, any direction) draws exactly as it always
      // has — same scale/anchor/facing — only the pixels change, via the
      // green-tint compositing path, whenever STEALTH's fade-in/hold/
      // fade-out strength is above 0. Firing or DASHing during STEALTH
      // never reverts to the plain draw call, since `img` above already
      // picked the FIRE/DASH sprite and this only changes HOW it's drawn.
      // SECTION F: on an actual hit, a brief on/off blink of the sprite
      // itself (never a whole-screen effect — see playerHitFlashUntil's own
      // separate red tint above for that). During each "on" pulse, draw the
      // PLAIN full-opacity sprite even if STEALTH would otherwise dim/
      // distort it — guarantees the blink stays visible/legible no matter
      // STEALTH's current state, without changing STEALTH's own rendering
      // path at all between pulses (it resumes exactly where it left off).
      let hitBlinkPulseOn = false;
      if (playerHitBlinkRemainingMs > 0) {
        const elapsedIntoBlink = PLAYER_HIT_BLINK_TOTAL_MS - playerHitBlinkRemainingMs;
        hitBlinkPulseOn = (elapsedIntoBlink % PLAYER_HIT_BLINK_CYCLE_MS) < PLAYER_HIT_BLINK_CYCLE_MS / 2;
      }
      const stealthStrength = getStealthEffectStrength(now);
      if (stealthStrength > 0 && !hitBlinkPulseOn) {
        drawPlayerStealthed(img, dx, dy, drawW, drawH, stealthStrength, now);
      } else {
        ctx.drawImage(img, dx, dy, drawW, drawH);
      }
    } else {
      // fallback placeholder while sprites load
      ctx.fillStyle = '#888';
      ctx.fillRect(player.x - 20, player.y - 40, 40, 80);
    }
  }

  // ---------- Boss rendering ----------
  function bossFrameName(now) {
    if (boss.state === 'straightclaw') {
      // The windup telegraph is shared by south/east/west (only 1 windup
      // image exists, and it's just a generic "charging up" pose) — but
      // NORTH's own windup uses the EXISTING north_idle image instead
      // (SECTION B): the shared windup pose is a front-facing crouch built
      // to face the player, which looks backwards when GABRIEL's back is
      // to them (player north of it), so north_idle (already correctly
      // anchored/scaled) reads naturally there instead. What changes AFTER
      // windup is the RELEASE/recovery pose: boss.counterDir === 'south'
      // keeps the original front-facing STING pose (straight_claw_release);
      // north/east/west instead reuse the EXISTING per-direction ARC CLAW
      // SLASH attack pose (SECTION 4) — the STING pose only reads correctly
      // when GABRIEL is facing the player, i.e. player south of it.
      const elapsed = now - boss.stateEnteredAt;
      if (elapsed < STRAIGHT_CLAW_WINDUP_MS) {
        return boss.counterDir === 'north' ? 'north_idle' : 'straight_claw_windup';
      }
      if (boss.counterDir === 'north') return 'attack_north';
      if (boss.counterDir === 'east') return 'attack_east_release';
      if (boss.counterDir === 'west') return 'attack_west_release';
      return 'straight_claw_release'; // 'south'
    }
    if (boss.state === 'preattack') {
      // SOUTH only now — NORTH/EAST/WEST never enter this state (see
      // updateBoss()'s CHASE->PRE_ATTACK/ATTACK branch); EAST/WEST's old
      // telegraph was removed, so this is the one and only frame here.
      return 'preattack_south';
    }
    if (boss.state === 'attack') {
      // boss.dir is set to face the player at the exact moment ATTACK
      // begins (see the CHASE->ATTACK and GUARD BREAK->ATTACK transitions),
      // so it's already "where the player was relative to the boss when
      // the attack started" — exactly what picks the sprite here. Each
      // direction has its own dedicated release-moment render now.
      const atkKey = DIR_TO_BOSS_KEY[boss.dir];
      if (atkKey === 'north') return 'attack_north';
      if (atkKey === 'south') return 'attack_south_release';
      if (atkKey === 'east') return 'attack_east_release';
      return 'attack_west_release';
    }
    // DEFENSE always shows the direction the attack came FROM
    // (boss.defenseDir), not boss.dir — see applyBodyHitToBoss().
    if (boss.state === 'defense') return `defense_${boss.defenseDir}`;
    // GUARD BREAK's brief stagger keeps showing the same defense pose (a
    // flash overlay sells the "guard just broke" moment — see
    // drawBossFeedback()) right up until it flips into ATTACK.
    if (boss.state === 'guardbreak') return `defense_${boss.defenseDir}`;
    const key = DIR_TO_BOSS_KEY[boss.dir]; // north | south | east | west
    if (key === 'south') {
      if (!boss.moving) return 'south_idle';
      // Plain 3-frame wrap (1 -> 2 -> 3 -> 1 -> ...), never ping-pong — same
      // pattern as NORTH's own cycle just below, on SOUTH_WALK_FRAME_PERIOD_MS
      // (a hair slower than the shared WALK_FRAME_PERIOD_MS).
      const frame = Math.floor(now / SOUTH_WALK_FRAME_PERIOD_MS) % 3;
      if (frame === 0) return 'walk_south_1';
      if (frame === 1) return 'walk_south_2';
      return 'walk_south_3';
    }
    if (key === 'north') {
      if (!boss.moving) return 'north_idle';
      // 3-frame cycle, same cadence as SOUTH's (WALK_FRAME_PERIOD_MS/frame)
      // per explicit instruction to keep all directions' walk pace uniform.
      // The small NORTH_BOUNCE_AMPLITUDE draw-time bounce (see drawBoss())
      // still layers on top of whichever of these three frames is picked —
      // an independent, purely-visual accent, not a replacement for having
      // real walk art.
      const frame = Math.floor(now / WALK_FRAME_PERIOD_MS) % 3;
      if (frame === 0) return 'walk_north_1';
      if (frame === 1) return 'walk_north_2';
      return 'walk_north_3';
    }
    if (key === 'east') {
      if (!boss.moving) return 'east_idle';
      // 2-frame alternation, same WALK_FRAME_PERIOD_MS cadence as SOUTH/NORTH.
      return (Math.floor(now / WALK_FRAME_PERIOD_MS) % 2 === 0) ? 'walk_east_1' : 'walk_east_2';
    }
    if (key === 'west') {
      if (!boss.moving) return 'west_idle';
      return (Math.floor(now / WALK_FRAME_PERIOD_MS) % 2 === 0) ? 'walk_west_1' : 'walk_west_2';
    }
    return 'north_idle';
  }

  function drawBoss(now) {
    // 'dead' is the true terminal state, reached only after DYING's particle
    // dissolve finishes — there is nothing left to draw by then.
    if (boss.state === 'dead') return;
    if (boss.state === 'intro') { drawBossIntro(now); return; }
    if (boss.state === 'threshold') { drawBossThreshold(now); return; }
    if (boss.state === 'dying') { drawBossDying(now); return; }
    if (boss.state === 'flashdown') { drawBossFlashDown(now); return; }
    if (boss.state === 'darkphase') { drawBossDarkPhase(now); return; }

    const name = bossFrameName(now);
    window.__game.bossFrame = name; // debug/verification only
    const img = bossSprites[name];
    let bounce = 0;
    if (boss.moving && DIR_TO_BOSS_KEY[boss.dir] === 'north') {
      bounce = Math.sin(now / 120) * NORTH_BOUNCE_AMPLITUDE;
    }
    // Per-frame visual-only scale — never touches the hurtbox/hitbox, only
    // the drawn size. SOUTH WALK reads a little small next to the other
    // directions (110%); PRE_ATTACK's reused older art reads a little
    // small for its dramatic telegraph moment (113%). Both scale up from
    // the sprite's BOTTOM edge (feet) so the boss never visibly jumps or
    // grows from its center when the frame changes — only the top extends.
    let scale = 1;
    if (name === 'walk_south_1' || name === 'walk_south_2' || name === 'walk_south_3' || name === 'south_idle') scale = SOUTH_WALK_SCALE;
    else if (name === 'preattack_south') scale = PRE_ATTACK_SCALE;
    // NORTH_IDLE_SCALE applies uniformly to north_idle AND the 3 new walk
    // frames (same reasoning as SOUTH_WALK_SCALE covering all 4 south
    // frames above) — the walk frames were scale-matched to north_idle's
    // OWN canvas measurements during processing, so without this shared
    // multiplier they'd visibly shrink 10% the instant NORTH starts moving.
    else if (name === 'north_idle' || name === 'walk_north_1' || name === 'walk_north_2' || name === 'walk_north_3') scale = NORTH_IDLE_SCALE;
    else if (name === 'attack_north') scale = NORTH_ATTACK_SCALE;
    else if (name === 'attack_south_release') scale = SOUTH_ATTACK_SCALE;
    // COUNTER windup/release now use DIFFERENT scales — real-device
    // feedback said windup read too small and release too large, in
    // opposite directions. Scaling via this same shared mechanism scales
    // from the sprite's own BOTTOM edge (see the comment above), so the
    // ground anchor/attack position are unaffected either way — only the
    // drawn height/width change. attack_north/attack_east_release/
    // attack_west_release and north_idle (all shown instead of these for a
    // north/east/west COUNTER ATTACK — see bossFrameName()) keep their own
    // existing scale untouched, matching how they already look during a
    // normal ARC CLAW SLASH attack or normal idle.
    else if (name === 'straight_claw_windup') scale = COUNTER_WINDUP_SCALE;
    else if (name === 'straight_claw_release') scale = COUNTER_STING_SCALE;
    if (img && img.complete && img.naturalWidth > 0) {
      const w = BOSS_DRAW_W * scale, h = BOSS_DRAW_H * scale;
      const bottomY = boss.y + BOSS_DRAW_H / 2 + bounce;
      const dx = boss.x - w / 2, dy = bottomY - h;
      const blinkElapsed = now - bossDamageBlinkStartAt;
      // PART 35/36: 3 distinct on/off blinks (明暗明暗明暗), not one fading
      // tint — segment 0,2,4 are "on" (tinted, fading within their own
      // half-step for a little punch), 1,3,5 are "off" (drawn completely
      // normally), so the eye reads three clean flashes.
      if (blinkElapsed >= 0 && blinkElapsed < BOSS_DAMAGE_BLINK_TOTAL_MS) {
        const segment = Math.floor(blinkElapsed / BOSS_HIT_TINT_MS);
        if (segment % 2 === 0) {
          const tWithinHalf = 1 - (blinkElapsed % BOSS_HIT_TINT_MS) / BOSS_HIT_TINT_MS;
          drawBossWithHitTint(img, dx, dy, w, h, tWithinHalf);
        } else {
          ctx.drawImage(img, dx, dy, w, h);
        }
      } else {
        ctx.drawImage(img, dx, dy, w, h);
      }
    }
  }

  // Brief red hit-tint (see BOSS_HIT_TINT_MS/bossDamageBlinkStartAt above) — tints
  // ONLY the boss sprite's own opaque pixels, never a flat colored
  // rectangle over the background, by compositing on a small offscreen
  // canvas first (source-atop respects THAT canvas's own alpha, which at
  // this point is exactly the sprite's silhouette) and drawing the result.
  const bossTintCanvas = document.createElement('canvas');
  const bossTintCtx = bossTintCanvas.getContext('2d');
  function drawBossWithHitTint(img, dx, dy, w, h, tintT) {
    const cw = Math.max(1, Math.ceil(w)), ch = Math.max(1, Math.ceil(h));
    bossTintCanvas.width = cw;
    bossTintCanvas.height = ch;
    bossTintCtx.clearRect(0, 0, cw, ch);
    bossTintCtx.drawImage(img, 0, 0, cw, ch);
    bossTintCtx.globalCompositeOperation = 'source-atop';
    bossTintCtx.fillStyle = `rgba(255,40,30,${0.3 + 0.45 * tintT})`;
    bossTintCtx.fillRect(0, 0, cw, ch);
    bossTintCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(bossTintCanvas, dx, dy, w, h);
  }

  // PART 5: the intro's "shadow reveal" — the EXISTING south_idle art
  // recolored to a flat black silhouette (source-in preserves only the
  // sprite's own alpha shape, so the silhouette's outline is pixel-for-
  // pixel the real artwork, not a generated shape) and drawn at a rising
  // alpha. No new image asset, no AI regeneration — same offscreen-canvas
  // compositing technique as drawBossWithHitTint()/STEALTH's tint above.
  const bossSilhouetteCanvas = document.createElement('canvas');
  const bossSilhouetteCtx = bossSilhouetteCanvas.getContext('2d');
  function drawBossSilhouette(img, dx, dy, w, h, alpha) {
    if (alpha <= 0) return;
    const cw = Math.max(1, Math.ceil(w)), ch = Math.max(1, Math.ceil(h));
    bossSilhouetteCanvas.width = cw;
    bossSilhouetteCanvas.height = ch;
    bossSilhouetteCtx.clearRect(0, 0, cw, ch);
    bossSilhouetteCtx.drawImage(img, 0, 0, cw, ch);
    bossSilhouetteCtx.globalCompositeOperation = 'source-in';
    bossSilhouetteCtx.fillStyle = 'rgba(0,0,0,1)';
    bossSilhouetteCtx.fillRect(0, 0, cw, ch);
    bossSilhouetteCtx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(bossSilhouetteCanvas, dx, dy, w, h);
    ctx.restore();
  }

  // PART 39: the defeat sequence's gradual "normal color -> near-black"
  // step — draws the sprite at full color, then composites a black tint
  // over ONLY its own opaque pixels (source-atop, same technique as
  // drawBossWithHitTint()'s red tint) at a rising alpha. blackT=1 reads as
  // "nearly pure black" (0.92, not 1.0, so it visibly still reads as a body
  // right up until drawBossSilhouette() takes over for the disintegrate
  // phase, rather than snapping to flat black a step early).
  const bossBlackenCanvas = document.createElement('canvas');
  const bossBlackenCtx = bossBlackenCanvas.getContext('2d');
  function drawBossBlackenTint(img, dx, dy, w, h, blackT) {
    const cw = Math.max(1, Math.ceil(w)), ch = Math.max(1, Math.ceil(h));
    bossBlackenCanvas.width = cw;
    bossBlackenCanvas.height = ch;
    bossBlackenCtx.clearRect(0, 0, cw, ch);
    bossBlackenCtx.drawImage(img, 0, 0, cw, ch);
    bossBlackenCtx.globalCompositeOperation = 'source-atop';
    bossBlackenCtx.fillStyle = `rgba(0,0,0,${Math.min(1, blackT) * 0.92})`;
    bossBlackenCtx.fillRect(0, 0, cw, ch);
    bossBlackenCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(bossBlackenCanvas, dx, dy, w, h);
  }

  // All timing here reads boss.cinematicElapsed (cached by updateBossIntro()
  // during update(), which PAUSE already skips) rather than recomputing
  // from `now`, which keeps advancing every frame regardless of PAUSE.
  // PART 1-8's new sequence: nothing visible during the initial shake or
  // the silence that follows -> a rising black silhouette of GABRIEL's own
  // south_idle art (PART 5) -> at the instant it finishes, GABRIEL appears
  // fully formed with no transition at all (PART 6 — the landing shake,
  // triggered from updateBossIntro(), supplies the "impact" on its own; no
  // extra flash/ring effect is added here, deliberately, per PART 6's
  // explicit "no cheap big circle effect" instruction) -> south idle holds
  // through the landing shake and the pause that follows -> south attack
  // telegraph (visual only — no arc claw slash, no hitbox, no real attack
  // logic runs; GABRIEL's AI stays fully paused throughout via
  // bossIsInCinematic()) -> battle begins (see updateBossIntro()).
  function drawBossIntro(now) {
    const elapsed = boss.cinematicElapsed;
    const bottomY = boss.introTargetY + BOSS_DRAW_H / 2;

    if (elapsed >= BOSS_INTRO_SILENCE_END && elapsed < BOSS_INTRO_SHADOW_END) {
      // SECTION A: a ground shadow marks the landing spot while GABRIEL
      // drops in from directly above using the existing DOWN/CINEMATIC
      // pose (getCinematicImageInfo() — same image/anchor formula
      // drawBossThreshold()/drawBossDying() already use) — no new art, no
      // AI regeneration. The shadow itself reuses the same growing/
      // darkening ellipse technique already used for barrel landings.
      const cin = getCinematicImageInfo();
      const t = (elapsed - BOSS_INTRO_SILENCE_END) / BOSS_INTRO_SHADOW_REVEAL_MS;
      const shadowT = Math.min(1, t * 1.15); // reaches full darkness a hair before the landing instant, not exactly at it
      ctx.save();
      ctx.globalAlpha = 0.4 * shadowT;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(boss.x, bottomY, cin.w * 0.30 * shadowT, cin.w * 0.30 * shadowT * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (cin.img.complete && cin.img.naturalWidth > 0) {
        const fallT = t * t; // ease-in — accelerating fall, not a linear slide
        const restDrawY = boss.y - cin.h / 2 + cin.offY; // same resting anchor drawBossThreshold()/drawBossDying() use
        const startDrawY = -cin.h - H * 0.35; // comfortably off the top of PLAY AREA at t=0
        const drawY = startDrawY + (restDrawY - startDrawY) * fallT;
        ctx.drawImage(cin.img, boss.x - cin.w / 2 + cin.offX, drawY, cin.w, cin.h);
      }
    } else if (elapsed >= BOSS_INTRO_SHADOW_END && elapsed < BOSS_INTRO_POST_PAUSE_END) {
      // Landed instantly at BOSS_INTRO_SHADOW_END (the landing shake fires
      // from updateBossIntro() at this same instant) — held on the same
      // DOWN pose through the shake and the pause that follows, right up
      // until the walk-frame switch below.
      const cin = getCinematicImageInfo();
      if (cin.img.complete && cin.img.naturalWidth > 0) {
        ctx.drawImage(cin.img, boss.x - cin.w / 2 + cin.offX, boss.y - cin.h / 2 + cin.offY, cin.w, cin.h);
      }
    } else if (elapsed >= BOSS_INTRO_POST_PAUSE_END && elapsed < BOSS_INTRO_SOUTH_IDLE_END) {
      // SECTION A/B: walk_south_1 — the south walk cycle's own first frame,
      // held perfectly STATIC (never advancing through frames 2/3) —
      // replaces the old south_idle hold here.
      const img = bossSprites.walk_south_1;
      if (img && img.complete && img.naturalWidth > 0) {
        const scale = SOUTH_WALK_SCALE;
        const w = BOSS_DRAW_W * scale, h = BOSS_DRAW_H * scale;
        ctx.drawImage(img, boss.x - w / 2, bottomY - h, w, h);
      }
    } else if (elapsed >= BOSS_INTRO_SOUTH_IDLE_END) {
      const img = bossSprites.attack_south_release;
      if (img && img.complete && img.naturalWidth > 0) {
        const scale = SOUTH_ATTACK_SCALE; // matches the same sprite's real in-battle scale
        const w = BOSS_DRAW_W * scale, h = BOSS_DRAW_H * scale;
        ctx.drawImage(img, boss.x - w / 2, bottomY - h, w, h);
      }
    }
    // Before BOSS_INTRO_SILENCE_END (initial shake + silence): nothing is
    // drawn at all — GABRIEL has no presence yet.
  }

  // Brief HP-milestone reaction: hold on the CINEMATIC POSE with a quick
  // impact flash, in place (boss.x/y don't move during this).
  function drawBossThreshold(now) {
    const elapsed = boss.cinematicElapsed;
    const thresholdCin = getCinematicImageInfo();
    if (thresholdCin.img.complete && thresholdCin.img.naturalWidth > 0) {
      ctx.drawImage(
        thresholdCin.img,
        boss.x - thresholdCin.w / 2 + thresholdCin.offX,
        boss.y - thresholdCin.h / 2 + thresholdCin.offY,
        thresholdCin.w, thresholdCin.h
      );
    }
    if (elapsed < 180) {
      const ft = elapsed / 180;
      ctx.save();
      ctx.globalAlpha = (1 - ft) * 0.7;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.arc(boss.x, boss.y, BOSS_DRAW_W * (0.3 + ft * 0.35), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // FLASH DOWN: hold on the direction-based DOWN pose for the whole
  // FLASH_DOWN_MS window — same image/anchor rule as drawBossThreshold(),
  // no impact-flash ring (that belongs to the milestone reaction only).
  function drawBossFlashDown(now) {
    const flashDownCin = getCinematicImageInfo();
    if (flashDownCin.img.complete && flashDownCin.img.naturalWidth > 0) {
      ctx.drawImage(
        flashDownCin.img,
        boss.x - flashDownCin.w / 2 + flashDownCin.offX,
        boss.y - flashDownCin.h / 2 + flashDownCin.offY,
        flashDownCin.w, flashDownCin.h
      );
    }
  }

  // DARK PHASE (SECTION C rebuild): GABRIEL's body is intentionally never
  // drawn here — no silhouette, no outline of any color, nothing that could
  // read as a white/gray halo. During the fully-hidden sub-state, NOTHING is
  // drawn at all — no sprite, no mask, no hint of position. Once the mask
  // reappears (telegraph/attacking), only the direction-appropriate head
  // image (see assets/boss/darkphase_heads_build_meta.json — each one
  // alpha-cropped straight out of its own attached photo, never a
  // Canvas-drawn design) is drawn, at DARK_PHASE_MASK_SCALE_BOOST on top of
  // its normal display size, positioned via getDarkPhaseHeadScreenPos()'s
  // same (boost-inclusive) scale/anchor so drawing and the FLASH hit-test
  // can never drift apart. A gentle brightness pulse marks the TELEGRAPH
  // window specifically (the "it's coming" beat before the claws start) —
  // a pixel-value rescale, never a new shape or an added light source. The
  // screen-darken overlay itself is drawn separately, UNDER the
  // player/bullets/this head (see draw()), so it can go near-total-black
  // without also hiding anything that must stay visible — see
  // darkPhaseOverlayAlpha/updateDarkPhaseOverlay().
  function drawBossDarkPhase(now) {
    if (isDarkPhaseHidden()) return; // no sprite, no hitbox, no mask at all during this window
    const anchor = getDarkPhaseHeadScreenPos(); // same single anchor point for every direction — never moves independently of this
    const dirKey = DIR_TO_BOSS_KEY[boss.dir]; // 'north' | 'south' | 'east' | 'west'
    const img = darkPhaseHeadImgs[dirKey];
    const m = DARKPHASE_HEAD_METRICS[dirKey];
    if (!img || !m || !img.complete || img.naturalWidth <= 0) return;
    ctx.save();
    if (boss.darkPhaseSubState === 'telegraph') ctx.filter = `brightness(${1 + 0.35 * Math.abs(Math.sin(now / 130))})`;
    // Anchor on the image's OWN eye/head-center offset (not its bbox
    // center), so the visible eye (or, for north's eyeless back-of-head
    // photo, its equivalent head-center point) lands exactly on the same
    // point isAimedAtDarkPhaseHead() checks against, whichever direction is
    // showing. Both the drawn size and this offset are scaled by
    // DARK_PHASE_MASK_SCALE_BOOST together, so the whole head display grows
    // uniformly rather than just shifting position.
    const boostedW = m.displayW * DARK_PHASE_MASK_SCALE_BOOST;
    const boostedH = m.displayH * DARK_PHASE_MASK_SCALE_BOOST;
    const drawX = anchor.x - m.eyeOffsetScaledX * DARK_PHASE_MASK_SCALE_BOOST;
    const drawY = anchor.y - m.eyeOffsetScaledY * DARK_PHASE_MASK_SCALE_BOOST;
    ctx.drawImage(img, drawX, drawY, boostedW, boostedH);
    ctx.restore();
  }

  // Samples the CINEMATIC POSE image (as actually drawn on-screen, so
  // colors/silhouette match exactly) into a grid of small opaque cells —
  // built once per death via boss.dyingParticlesBuilt. Outer/edge cells get
  // an earlier dissolveAt than central ones, so the body visibly peels
  // apart from the outside in rather than dissolving uniformly.
  function buildDyingParticles() {
    const dyingCin = getCinematicImageInfo();
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.ceil(dyingCin.w));
    off.height = Math.max(1, Math.ceil(dyingCin.h));
    const octx = off.getContext('2d');
    if (dyingCin.img.complete && dyingCin.img.naturalWidth > 0) {
      octx.drawImage(dyingCin.img, 0, 0, off.width, off.height);
    }
    let data = null;
    try { data = octx.getImageData(0, 0, off.width, off.height).data; } catch (e) { data = null; }

    const cols = Math.ceil(off.width / DYING_CELL_SIZE);
    const rows = Math.ceil(off.height / DYING_CELL_SIZE);
    const cells = [];
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const px = Math.min(off.width - 1, gx * DYING_CELL_SIZE + (DYING_CELL_SIZE >> 1));
        const py = Math.min(off.height - 1, gy * DYING_CELL_SIZE + (DYING_CELL_SIZE >> 1));
        let a = 0;
        if (data) {
          const idx = (py * off.width + px) * 4;
          a = data[idx + 3];
        } else {
          a = 255; // getImageData unavailable — fall back to a solid silhouette-less block field
        }
        if (a <= 40) continue; // transparent background cell — not part of the character
        cells.push({ gx, gy });
      }
    }

    const particles = cells.map((c) => {
      const xFrac = cols > 1 ? c.gx / (cols - 1) : 0.5;
      const yFrac = rows > 1 ? c.gy / (rows - 1) : 0.5;
      // U-9: distance to the NEAREST of a few fixed crack-origin points
      // (shoulder/wing, torso, leg/CLAW areas) — cells near any one of them
      // start dissolving first, so the body visibly cracks apart from
      // several places at once rather than one single top-to-bottom sweep.
      // A little per-cell jitter keeps each boundary ragged, not a hard edge.
      let minD = Infinity;
      for (const seed of DEATH_CRACK_SEED_FRACS) {
        const d = Math.hypot(xFrac - seed.x, (yFrac - seed.y) * 1.3);
        if (d < minD) minD = d;
      }
      const spreadFrac = Math.min(1, minD / 0.62);
      let dissolveAt = Math.max(0, Math.min(0.72, spreadFrac * 0.55 + Math.random() * 0.22));
      // U-10: the wings/CLAW reach far to either side of the torso —
      // pushing their outer columns' dissolve a little later keeps the
      // silhouette recognizable the longest.
      const colFrac = Math.abs(xFrac - 0.5) * 2;
      if (colFrac > DEATH_OUTER_COLUMN_FRAC) {
        dissolveAt = Math.min(0.9, dissolveAt + DEATH_OUTER_DELAY_FRAC + Math.random() * 0.05);
      }
      // U-5: swept away up/upper-right (never straight down), with a
      // per-particle angle jitter so it reads as organic, not a fan.
      const angle = DEATH_PARTICLE_BASE_ANGLE + (Math.random() - 0.5) * DEATH_PARTICLE_ANGLE_JITTER;
      // Black to dark-gray grains — not the sprite's own sampled color —
      // since by the time anything is breaking off, the body itself has
      // already fully blackened (see drawBossBlackenTint()/BOSS_DEFEAT_
      // BLACKEN_* above).
      const shade = Math.floor(Math.random() * 34);
      const isShard = Math.random() < DEATH_SHARD_FRAC;
      return {
        gx: c.gx, gy: c.gy,
        color: `rgba(${shade},${shade},${shade},`,
        dissolveAt,
        angle,
        maxDist: 60 + Math.random() * 110, // U-6: total travel distance, reached via an ease-in curve below — not a fixed px/sec speed
        spin: (Math.random() - 0.5) * 4,
        isShard,
        // U-7: most grains small (radius 1-2.5 == 2-5px diameter); a few
        // larger elongated shards (radius 3-5 == 6-10px diameter).
        grain: isShard ? (3 + Math.random() * 2) : (1 + Math.random() * 1.5),
        shardLen: isShard ? (6 + Math.random() * 8) : 0,
      };
    });
    boss.dyingParticles = particles;
    boss.dyingParticlesBuilt = true;
  }

  // SECTION U: instant blacken -> the body cracks apart from several points
  // at once -> fine shards sweep up/upper-right, accelerating -> a brief
  // dim residual outline -> gone. The intact (blackened) sprite is drawn
  // first each frame, then every already-dissolved cell is punched out of
  // it (destination-out) and redrawn as a separate departing fragment, so
  // the body visibly comes apart in pieces rather than fading in place.
  function drawBossDying(now) {
    if (!boss.dyingParticlesBuilt) buildDyingParticles();
    const dyingDrawCin = getCinematicImageInfo(); // same boss.downFacing as buildDyingParticles() used — stable for the whole sequence
    if (!dyingDrawCin.img.complete || dyingDrawCin.img.naturalWidth <= 0) return;
    const elapsed = boss.cinematicElapsed;
    const drawX = boss.x - dyingDrawCin.w / 2 + dyingDrawCin.offX;
    const drawY = boss.y - dyingDrawCin.h / 2 + dyingDrawCin.offY;

    if (elapsed < BOSS_DEFEAT_BLACKEN_END) {
      // U-1/U-3: normal color -> near-black in one sharp beat — no static
      // full-color hold beforehand anymore.
      const blackT = (elapsed - BOSS_DEFEAT_BLACKEN_START) / BOSS_DEFEAT_BLACKEN_MS;
      drawBossBlackenTint(dyingDrawCin.img, drawX, drawY, dyingDrawCin.w, dyingDrawCin.h, blackT);
      return;
    }

    const disintegrateElapsed = elapsed - BOSS_DEFEAT_BLACKEN_END;
    const frac = Math.min(1, disintegrateElapsed / BOSS_DEFEAT_DISINTEGRATE_MS);

    // U-8: full alpha until the final residue window, then a low constant
    // "afterimage" alpha for a short stretch, then a quick snap to gone —
    // never one long linear fade across the whole tail.
    const residueWindowFrac = DEATH_RESIDUE_WINDOW_MS / BOSS_DEFEAT_DISINTEGRATE_MS;
    const residueSnapFrac = DEATH_RESIDUE_SNAP_MS / BOSS_DEFEAT_DISINTEGRATE_MS;
    let silhouetteAlpha = 1;
    if (frac > 1 - residueWindowFrac) {
      const intoResidue = frac - (1 - residueWindowFrac);
      const snapStart = residueWindowFrac - residueSnapFrac;
      silhouetteAlpha = intoResidue < snapStart
        ? DEATH_RESIDUE_ALPHA
        : DEATH_RESIDUE_ALPHA * Math.max(0, 1 - (intoResidue - snapStart) / residueSnapFrac);
    }

    ctx.save();
    ctx.globalAlpha = silhouetteAlpha;
    drawBossSilhouette(dyingDrawCin.img, drawX, drawY, dyingDrawCin.w, dyingDrawCin.h, 1); // fully blackened by now
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    for (const p of boss.dyingParticles) {
      if (frac < p.dissolveAt) continue;
      ctx.fillRect(drawX + p.gx * DYING_CELL_SIZE, drawY + p.gy * DYING_CELL_SIZE, DYING_CELL_SIZE + 1, DYING_CELL_SIZE + 1);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    // U-5/U-6/U-7: fine black/dark-gray grains (a few larger elongated
    // shards) swept away up/upper-right, accelerating via an ease-in curve
    // (slow start, fast finish) — never falling, never a fixed drift speed.
    for (const p of boss.dyingParticles) {
      if (frac < p.dissolveAt) continue;
      const localT = Math.min(1, (frac - p.dissolveAt) / Math.max(0.05, 1 - p.dissolveAt));
      const dist = p.maxDist * Math.pow(localT, DEATH_PARTICLE_EASE_POWER);
      const dx = Math.cos(p.angle) * dist;
      const dy = Math.sin(p.angle) * dist;
      const alpha = Math.max(0, 1 - localT);
      if (alpha <= 0.02) continue;
      const px = drawX + p.gx * DYING_CELL_SIZE + DYING_CELL_SIZE / 2 + dx;
      const py = drawY + p.gy * DYING_CELL_SIZE + DYING_CELL_SIZE / 2 + dy;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color + '1)';
      if (p.isShard) {
        ctx.translate(px, py);
        ctx.rotate(p.angle + p.spin * localT);
        ctx.fillRect(-p.shardLen / 2, -p.grain / 2, p.shardLen, p.grain);
      } else {
        const r = p.grain * (1 - localT * 0.3);
        if (r > 0.05) {
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  // SECTION G: called from draw() AFTER the camera-translate restore() —
  // true screen coordinates, so this is immune to cameraY regardless of
  // which AREA/STAGE is scrolling underneath it. "BOSS: GABRIEL" only — no
  // WARNING/BATTLE/ENCOUNTER text — shown at true screen-center only while
  // GABRIEL has actually landed and is visible (through the walk_south_1
  // static hold), never lingering into normal battle.
  function drawBossHud(now) {
    if (!boss.spawned) return;
    if (boss.state === 'intro' && boss.cinematicElapsed >= BOSS_INTRO_SHADOW_END && boss.cinematicElapsed < BOSS_INTRO_SOUTH_IDLE_END) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(255,60,60,${0.55 + 0.45 * Math.abs(Math.sin(now / 150))})`;
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(`BOSS: ${boss.name}`, W / 2, H / 2);
      ctx.restore();
    }
  }

  // SECTION E/V: PLAYER LIFE HUD — screen-fixed top-left (called AFTER the
  // camera-translate restore() in draw(), so cameraY can never move it,
  // fixing the previous bug where it was drawn inside the world-space
  // block and drifted/vanished on AREA1->AREA2 scroll). Small "LIFE" label
  // + a thin horizontal gauge — no numeric value ever shown. At the
  // Infinity setting the gauge is always drawn full; at a finite max it
  // reflects current/max as a fraction of the same bar width.
  function drawLifeHud(now) {
    const labelY = Math.max(10, H * 0.03) + 4;
    const gaugeY = labelY + 12;
    const x = HUD_MARGIN_X;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = 'bold 11px sans-serif';
    // SECTION D: STUN styling — P-1: this applies even at LIFE=Infinity,
    // since it keys off player.stunned, never off the LIFE value itself.
    // A slow, smooth breathing alpha (never a harsh fast blink), shared by
    // the LIFE bar's own fill and the separate STUN status gauge below it
    // so the two read as one connected effect, within the requested
    // 500-700ms band (STUN_LIFE_PULSE_MS).
    const stunned = player.stunned;
    const pulseAlpha = stunned
      ? 0.6 + 0.4 * (0.5 + 0.5 * Math.sin((now / STUN_LIFE_PULSE_MS) * Math.PI * 2))
      : 1;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('LIFE', x, labelY + 8);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(x, gaugeY, HUD_BAR_W, HUD_BAR_H);
    const frac = player.life === Infinity ? 1 : Math.max(0, Math.min(1, player.life / playerMaxLife));
    // D-1: the LIFE bar itself turns orange while stunned (replacing the
    // normal green fill) — D-2's pulse is folded into this same fillStyle.
    ctx.fillStyle = stunned ? `rgba(255,150,30,${pulseAlpha})` : 'rgba(100,220,140,0.9)';
    ctx.fillRect(x, gaugeY, HUD_BAR_W * frac, HUD_BAR_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, gaugeY + 0.5, HUD_BAR_W - 1, HUD_BAR_H - 1);
    if (stunned) {
      // PART 3 SECTION B: "STUN" now renders INSIDE the LIFE gauge itself
      // (small black text, centered) instead of as its own separate label
      // next to "LIFE" — B-1/B-2/B-3. Drawn after the bar fill/stroke above
      // so it sits on top of the orange fill without being covered by it;
      // sized to the bar's own height so it never spills outside the gauge.
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${HUD_BAR_H}px sans-serif`;
      ctx.fillStyle = '#000000';
      ctx.fillText('STUN', x + HUD_BAR_W / 2, gaugeY + HUD_BAR_H / 2 + 0.5);
      ctx.restore();
    }
    if (stunned) {
      // D-4: a thin, separate status gauge directly under the LIFE bar —
      // this is NOT a LIFE value (always full-width) — purely a "currently
      // STUNned" indicator, kept visually attached to the same HUD block
      // (same x/width, orange, pulsing in sync with the bar above it).
      const stunGaugeY = gaugeY + HUD_BAR_H + 3;
      const stunGaugeH = 3;
      ctx.fillStyle = `rgba(255,150,30,${pulseAlpha})`;
      ctx.fillRect(x, stunGaugeY, HUD_BAR_W, stunGaugeH);
    }
    ctx.restore();
  }

  // SECTION F/V: BOSS LIFE HUD — screen-fixed top-right, symmetric with
  // PLAYER LIFE's own design (same bar size/style, mirrored side). No
  // numeric HP value — HP/damage/kill logic stays fully internal, only the
  // gauge width communicates it.
  function drawBossLifeHud(now) {
    if (!boss.spawned) return;
    const labelY = Math.max(10, H * 0.03) + 4;
    const gaugeY = labelY + 12;
    const x = W - HUD_MARGIN_X - HUD_BAR_W;
    ctx.save();
    ctx.textAlign = 'right';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = 'rgba(255,140,140,0.85)';
    ctx.fillText(boss.name, W - HUD_MARGIN_X, labelY + 8);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(x, gaugeY, HUD_BAR_W, HUD_BAR_H);
    const frac = Math.max(0, Math.min(1, boss.hp / BOSS_HP_MAX));
    ctx.fillStyle = 'rgba(225,70,70,0.9)';
    ctx.fillRect(x, gaugeY, HUD_BAR_W * frac, HUD_BAR_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, gaugeY + 0.5, HUD_BAR_W - 1, HUD_BAR_H - 1);
    // PART 3 SECTION C / new-turn SECTION 9: "無敵" — thin white text,
    // centered inside the gauge — shown only while isBossDamageImmune() is
    // actually true (the SAME real invincibility condition the actual
    // damage code already checks — never a separate display-only flag), and
    // disappears the instant that stops being true (C-4, checked fresh every
    // frame here). Gauge size/position/HP-fill logic above is untouched;
    // only this text's own color/weight changed this turn (black/bold ->
    // thin/white) per this turn's explicit spec.
    if (isBossDamageImmune()) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${HUD_BAR_H}px sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText('無敵', x + HUD_BAR_W / 2, gaugeY + HUD_BAR_H / 2 + 0.5);
    }
    ctx.restore();
  }

  // Small, non-intrusive combat feedback: a metallic spark + ricochet on a
  // blocked hit during DEFENSE (see spawnDefenseRicochet()/
  // drawDefenseRicochets()). PART 34 removed the red dot marker that used
  // to render here at the weak-point impact point on a genuine hit — GABRIEL's
  // own 3x damage-blink (drawBossWithHitTint(), see BOSS_DAMAGE_BLINK_*
  // above) is now the only visual feedback for a successful hit.
  function drawBossFeedback(now) {
    if (!boss.spawned) return;
    if (now < guardBreakFlashUntil) {
      const t = 1 - Math.max(0, (guardBreakFlashUntil - now) / GUARD_BREAK_PAUSE_MS);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(boss.x, boss.y, BOSS_DRAW_W * (0.35 + t * 0.3), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,230,120,0.95)';
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('GUARD BREAK', boss.x, boss.y - BOSS_DRAW_H * 0.5 - 12);
      ctx.restore();
    }
    drawDefenseRicochets(now);
  }

  // SECTION N: reads the SAME (orientation: landscape) media feature
  // style.css's #landscape-block-overlay keys off of, so the visual
  // overlay and this gameplay freeze can never disagree about which
  // orientation is currently active.
  function isLandscapeBlocked() {
    return !!(window.matchMedia && window.matchMedia('(orientation: landscape)').matches);
  }

  function loop(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    // lastTime still advances every frame either way, so dt is never a
    // huge catch-up jump the instant play resumes back in portrait.
    // SECTION J: the gameplay world (update()/draw(), which together own
    // the canvas, boss AI, bullets, etc.) only ever ticks while
    // screen==='gameplay' — LOADING/OPENING/MAIN MENU are plain DOM/CSS,
    // so there's nothing running in the background under them.
    if (!isLandscapeBlocked() && gameState.screen === 'gameplay') {
      update(dt, now);
      draw(now);
    }
    requestAnimationFrame(loop);
  }

  requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });
  initLoadingSequence();
})();
