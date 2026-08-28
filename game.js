(() => {
  'use strict';

  // ---------- Canvas setup ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  let W = 0, H = 0;
  // Extra walkable WORLD space that opens up above the original screen once
  // a boss is fully defeated (PART 21-29) — see the "Stage world / camera"
  // section below. Declared here (not there) so the very first resize()
  // call below can safely set it before anything else runs.
  let worldExtraAbove = 0;
  let cameraY = 0;
  const WORLD_EXTRA_ABOVE_FACTOR = 1.3; // world opens up to 1.3x the screen height taller, post-victory

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
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
  // Data-driven list so adding another stage later is just one more entry
  // here — no other code needs to change. Decorative floor art only; no
  // collision is derived from it. Used for portrait/tall viewports (where
  // the aspect ratio fits well); landscape keeps the original dark grid
  // background rather than force-fitting a tall image into a wide screen.
  // The pre-existing lab floor stays first/default so a fresh page load
  // looks exactly as it did before this batch (no regression).
  const STAGES = [
    { key: 'lab_b03', file: 'assets/stage/lab_b03_floor.png' },
    { key: 'stage_a', file: 'assets/stage/stage_a_floor.png' },
    { key: 'stage_b', file: 'assets/stage/stage_b_floor.jpg' },
  ];
  STAGES.forEach((s) => {
    s.img = new Image();
    s.ready = false;
    s.img.onload = () => { s.ready = true; };
    s.img.src = s.file;
  });
  let currentStageIndex = 0;
  function currentStage() { return STAGES[currentStageIndex]; }
  // Picks a stage guaranteed to differ from the one passed in — the EXIT
  // must never send the player straight back into the same stage they just
  // cleared (PART 27).
  function pickRandomOtherStage(excludeIndex) {
    if (STAGES.length <= 1) return excludeIndex;
    let idx;
    do { idx = Math.floor(Math.random() * STAGES.length); } while (idx === excludeIndex);
    return idx;
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
    // The on-disk walk_east.png/walk_west.png pair has its content swapped
    // from its filename (walk_east.png is actually the left/west-facing
    // render and vice versa — confirmed by visual comparison against the
    // correctly-labeled east_idle/west_idle pair). Rather than touch the
    // image files, the logical keys below simply load the other file.
    walk_south_1: 'walk_south_1', walk_south_2: 'walk_south_2', walk_south_3: 'walk_south_3', walk_east: 'walk_west', walk_west: 'walk_east',
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
  // The visible "red eye glow" is EXTRACTED directly from the previously-
  // attached DARK PHASE GABRIEL render (assets/boss/source/dark_phase_source.png,
  // kept unmodified) — never a Canvas-drawn design. Every pixel classified
  // as glow (redness = R - max(G,B) > 15, the exact same threshold already
  // verified when building the retired assets/boss/dark_phase.png) keeps
  // its original RGB at full opacity; every other pixel (the original white
  // background AND the black body/wings alike) is fully transparent — see
  // assets/boss/dark_phase_eyes_build_meta.json for the full method. GABRIEL's
  // body itself is never drawn during DARK PHASE at all.
  const darkPhaseEyesImg = new Image();
  darkPhaseEyesImg.src = 'assets/boss/dark_phase_eyes.png';
  // The crop's own bounding box within the ORIGINAL 1152x1728 source canvas
  // (see dark_phase_eyes_build_meta.json) — used to position the crop
  // exactly where it would sit on GABRIEL's full body if that were drawn at
  // DARKPHASE_SCALE (declared below, next to BOSS_SPEED), so the glow reads
  // at a plausible head-height/size rather than an arbitrary one.
  const DARKPHASE_EYES_SOURCE_W = 1152, DARKPHASE_EYES_SOURCE_H = 1728;
  const DARKPHASE_EYES_CROP_X0 = 534, DARKPHASE_EYES_CROP_Y0 = 269;
  const DARKPHASE_EYES_CROP_X1 = 669, DARKPHASE_EYES_CROP_Y1 = 426;
  // Single anchor point (the crop's own bbox center, in source-canvas
  // coordinates) used for BOTH drawing the glow AND the FLASH head-aim
  // hit-test — see getDarkPhaseHeadScreenPos()/isAimedAtDarkPhaseHead()
  // below, so the two can never drift apart as GABRIEL moves.
  const DARKPHASE_HEAD_CANVAS_X = (DARKPHASE_EYES_CROP_X0 + DARKPHASE_EYES_CROP_X1) / 2;
  const DARKPHASE_HEAD_CANVAS_Y = (DARKPHASE_EYES_CROP_Y0 + DARKPHASE_EYES_CROP_Y1) / 2;
  const DARKPHASE_HEAD_HIT_RADIUS = 55; // screen px — perpendicular tolerance for the FLASH aim-ray check, see isAimedAtDarkPhaseHead()
  // Drawn display size: deliberately larger than what DARKPHASE_SCALE's
  // body-accurate projection alone would give (that math places a real
  // human head/visor at only ~10-12px tall on a phone screen — anatomically
  // correct, but too small to read as "a glowing eye in the dark" during
  // actual play). A uniform resize is explicitly allowed processing (no
  // reshaping, no redraw) — the crop's own aspect ratio is preserved
  // exactly, only its on-screen size changes, always centered on the SAME
  // anchor point drawBossDarkPhase()/isAimedAtDarkPhaseHead() both use.
  const DARKPHASE_EYES_DISPLAY_H = 46;
  const DARKPHASE_EYES_DISPLAY_W = DARKPHASE_EYES_DISPLAY_H * ((DARKPHASE_EYES_CROP_X1 - DARKPHASE_EYES_CROP_X0) / (DARKPHASE_EYES_CROP_Y1 - DARKPHASE_EYES_CROP_Y0));
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
  // Full draw box (including the image's own transparent margin); the
  // visible drum within it ends up ~26% of the player's height, inside
  // the requested 20-30% band.
  const BARREL_DRAW_H = SPRITE_DRAW_H * 0.30;
  const BARREL_HITBOX_RADIUS = 12; // scaled down to match the smaller draw size
  const BARREL_EXPLOSION_RADIUS = 300; // area-effect range, not tied to the sprite size (3x the previous 100)
  // Ceiling-drop restock: when every barrel on stage is gone, a fresh batch
  // falls in from above instead of the field staying permanently empty.
  const BARREL_RESTOCK_DELAY_MIN_MS = 1000, BARREL_RESTOCK_DELAY_MAX_MS = 2000;
  const BARREL_RESTOCK_MIN_COUNT = 2, BARREL_RESTOCK_MAX_COUNT = 4;
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
  const HALF_RANGE = Math.PI / 3; // +-60 degrees (120-degree total aim wedge)

  // ACTION STICK dead zone: fraction of the stick's radius that must be
  // crossed before any direction/movement registers at all. Kept small
  // (~12%) so input feels immediate — big enough only to ignore a resting
  // thumb's tiny involuntary tremor, not to noticeably delay a real push.
  const ACTION_STICK_DEADZONE = 0.12;

  // Returns (angle - center) clamped to +-HALF_RANGE, preserving whichever
  // side of center it's already on (nearest-valid-angle correction). The
  // result is an offset relative to `center`, not an absolute angle.
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
    speed: 240, // px/sec
    baseDir: 'down',   // discrete sprite bucket, set only by ACTION STICK
    aimOffsetRaw: 0,   // radians relative to BASE_ANGLE[baseDir], within +-HALF_RANGE — raw AIM STICK input
    aimOffset: 0,      // effective offset actually used to fire/draw — aimOffsetRaw, lightly pulled toward a nearby AUTO AIM target
    moving: false,
    // DASH: one of the 4 cardinal directions, always the direction the
    // player is currently facing (baseDir) at the moment DASH is pressed —
    // all 4 now have dedicated dash art, so no horizontal-fallback is
    // needed for south/north anymore.
    dashing: false,
    dashDir: 'right', // 'right' | 'left' | 'up' | 'down' — SPRITE selection only (nearest cardinal)
    dashAngle: 0, // radians — the REAL movement direction (can be diagonal via MOVE STICK double-tap)
    bufferedDashAngle: null, // angle to use for an auto-chained 2nd dash, if it was requested with one
    dashStartAt: -Infinity,
    dashFromX: 0,
    dashFromY: 0,
    dashDistance: 0,
    dashBuffered: false, // a DASH press received near the end of the current DASH
    dashChainCount: 0, // dashes used in the current chain (max DASH_CHAIN_MAX)
    facingLockUntil: 0, // briefly holds baseDir after a completed 2-dash chain reversal
    knockbackUntil: 0, // brief movement-input suppression after a forced-counter KNOCKBACK
    // RELAXED IDLE (SOUTH only): tracks how long all inputs have been idle.
    lastActivityAt: performance.now(),
    relaxed: false,
  };

  // The single source of truth for firing/aim-line direction: always the
  // current base facing's center angle plus the (clamped) aim offset. When
  // aimOffset is 0 — the default, and what it resets to whenever the base
  // facing changes or the AIM STICK is released — this is exactly the base
  // direction's true angle, so an un-aimed shot always matches the sprite.
  function getAimAngle() {
    return BASE_ANGLE[player.baseDir] + player.aimOffset;
  }

  function resetPlayerPosition() {
    player.x = W / 2;
    player.y = H / 2;
  }
  resetPlayerPosition();

  // Unconditionally applies a new base facing (used by the DASH-chain
  // reversal, which must force the flip even though the requested direction
  // may momentarily equal whatever the stick already reports). Snaps aim
  // back to its center immediately rather than carrying over an offset
  // computed for the old direction — same as the guarded setBaseDir below.
  function forceSetBaseDir(dir) {
    player.baseDir = dir;
    player.aimOffsetRaw = 0;
    player.aimOffset = 0;
    aimStickKnob.style.transform = 'translate(0px, 0px)';
    updateAimSectorOverlay();
  }

  function setBaseDir(dir) {
    if (dir === player.baseDir) return;
    forceSetBaseDir(dir);
  }

  function clampPlayerToScreen() {
    const halfW = (SPRITE_DRAW_H * spriteAspect) / 2;
    const halfH = SPRITE_DRAW_H / 2;
    // Before the boss is fully defeated, this is pixel-identical to the
    // original single-screen clamp (worldScrollUnlocked() is false) — the
    // extra world space above only becomes walkable post-victory.
    const topY = worldScrollUnlocked() ? -worldExtraAbove + halfH : halfH;
    player.x = Math.max(halfW, Math.min(W - halfW, player.x));
    player.y = Math.max(topY, Math.min(H - halfH, player.y));
  }

  // ---------- DASH (4 directions, max 2 chained) ----------
  const DASH_DURATION_MS = 800;
  const DASH_DISTANCE_FRAC = 0.20; // 20% of screen width — within the 15-25% target
  const RELAXED_IDLE_DELAY_MS = 400;
  const DASH_CHAIN_MAX = 2; // at most 2 dashes per chain — a 3rd request is refused
  const FACING_LOCK_MS = 200; // briefly holds the post-chain reversed facing against stick input
  const OPPOSITE_DIR = { up: 'down', down: 'up', left: 'right', right: 'left' };

  // angleOverride (radians) lets a MOVE STICK double-tap dash in the exact
  // diagonal direction it was pressed, while player.dashDir (nearest
  // cardinal, via angleToBucket — the same 4-way split used everywhere
  // else) still picks which of the 4 existing DASH sprites to show, since
  // no diagonal dash art exists. Omitting it (the DASH button / old
  // move-stick flow) keeps the previous cardinal-only behavior exactly.
  function tryStartDash(now, angleOverride) {
    if (player.dashing) return;
    if (player.dashChainCount >= DASH_CHAIN_MAX) return; // chain already used up
    const angle = (angleOverride === undefined || angleOverride === null) ? BASE_ANGLE[player.baseDir] : angleOverride;
    player.dashing = true;
    player.dashAngle = angle;
    player.dashDir = angleToBucket(angle);
    player.dashChainCount += 1;
    player.dashStartAt = now;
    player.dashFromX = player.x;
    player.dashFromY = player.y;
    // Same distance value on every axis (screen-width based, not
    // screen-height) so vertical DASH feels like the same distance as
    // horizontal DASH instead of being stretched on tall portrait screens.
    player.dashDistance = W * DASH_DISTANCE_FRAC;
    player.lastActivityAt = now;
  }

  // No extra cooldown after DASH — the next DASH is available the instant
  // the current one ends (as long as the chain hasn't already used its 2
  // dashes). A press can't multi-trigger the same DASH (it's just ignored
  // while player.dashing), but ANY press received at any point while DASH 1
  // is running is remembered and fired the instant it ends — a fast
  // "tap-tap" always chains, with no visible pause between the two —
  // unless the chain is already at DASH_CHAIN_MAX, in which case a 3rd
  // request (buffered or not) is simply dropped.
  function requestDash(now, angleOverride) {
    if (!player.dashing) {
      tryStartDash(now, angleOverride);
      return;
    }
    if (player.dashChainCount >= DASH_CHAIN_MAX) return;
    // A 2nd press is accepted as buffered at ANY point during the 1st
    // DASH's run — not just its final DASH_INPUT_BUFFER_MS — so two fast
    // taps ("tap-tap") always chain, including a 2nd tap landing right at
    // the start of the 1st DASH. It still only fires the instant DASH 1
    // actually ends (see updateDash()), so there's never a visible pause
    // and never more than DASH_CHAIN_MAX dashes in the chain.
    player.dashBuffered = true;
    player.bufferedDashAngle = (angleOverride === undefined) ? null : angleOverride;
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
      const finishedDir = player.dashDir;
      const canChain = player.dashChainCount < DASH_CHAIN_MAX;
      const buffered = player.dashBuffered && canChain;
      player.dashBuffered = false;
      const bufferedAngle = player.bufferedDashAngle;
      player.bufferedDashAngle = null;
      if (buffered) {
        tryStartDash(now, bufferedAngle); // chain immediately, no cooldown gap
        return;
      }
      // The chain ends here — either only 1 dash was used, or the 2nd just
      // finished with nothing buffered. A completed 2-dash chain reverses
      // facing to the opposite direction and shows that direction's normal
      // pose (never left standing in the DASH pose); a lone single dash
      // keeps facing the dash direction, unchanged from before chaining
      // existed. The reversed facing is held briefly (FACING_LOCK_MS)
      // against the ACTION STICK so it's actually visible for a moment
      // even if the stick is still held in the original direction.
      if (player.dashChainCount >= DASH_CHAIN_MAX) {
        forceSetBaseDir(OPPOSITE_DIR[finishedDir]);
        player.facingLockUntil = now + FACING_LOCK_MS;
      }
      player.dashChainCount = 0;
      return;
    }
    // Real movement always follows the exact dashAngle (which may be a
    // diagonal from a MOVE STICK double-tap) — dashDir only ever affects
    // which sprite is drawn, never the actual travel vector.
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
  const BOSS_SPEED = 78; // px/sec — 60% of the previous 130 (was too fast to react to)
  const BOSS_SPAWN_DELAY_MS = 5000;
  const BOSS_ATTACK_RANGE = 130; // distance at which CHASE -> ATTACK
  const BOSS_ATTACK_WINDUP_MS = 400;
  const BOSS_ATTACK_ACTIVE_MS = 150;
  const BOSS_ATTACK_REACH = 108; // forward offset of the claw hitbox center
  const BOSS_ATTACK_HIT_RADIUS = 68;
  const BOSS_RECOVER_MS = 350;
  const BOSS_DEFENSE_MS = 1800;
  const BOSS_HURT_RADIUS = 46; // small torso-only hurtbox, not the full sprite
  const BULLET_DAMAGE = 40;
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
  // ANY 4 valid AUTO-AIM-assisted damage hits (body or weak point, in any
  // boss state — distinct from GUARD BREAK's DEFENSE-only counter) send the
  // boss into DARK PHASE — total damage immunity (this time including
  // barrel explosions, unlike DEFENSE) with an ARC-CLAW-SLASH-only AI,
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
  // DARK PHASE AI (see updateBossDarkPhase() and its 6 per-substate helper
  // functions below) — a STALK -> CLOSE IN -> PAUSE -> LUNGE -> ARC CLAW ->
  // DISENGAGE loop, replacing a plain straight-line approach/retreat so
  // GABRIEL never magnet-homes onto the player: boss.x/y genuinely move
  // (not just a VFX) at a DIFFERENT speed per phase, curving in from an
  // angle rather than beelining, with a short telegraph pause before each
  // burst-speed strike.
  const DARKPHASE_STALK_SPEED = BOSS_SPEED * 0.40; // slow — a distant, wary drift, not an approach
  const DARKPHASE_CLOSEIN_SPEED = BOSS_SPEED * 0.90; // medium — genuinely closing the gap, but not yet the strike itself
  const DARKPHASE_LUNGE_SPEED = BOSS_SPEED * 2.4; // fast — the one moment that should feel sudden
  const DARKPHASE_DISENGAGE_SPEED = BOSS_SPEED * 0.90; // medium — same pace as CLOSE IN, just outbound
  const DARKPHASE_ATTACK_RANGE = BOSS_ATTACK_RANGE; // distance at which LUNGE ends and ARC CLAW SLASH actually fires
  // CLOSE IN ends (PAUSE begins) once within this distance — deliberately
  // wider than DARKPHASE_ATTACK_RANGE so LUNGE always has a real, visible
  // burst of distance left to cover, rather than firing from wherever
  // CLOSE IN happened to stop.
  const DARKPHASE_PAUSE_TRIGGER_RANGE = DARKPHASE_ATTACK_RANGE * 2.2;
  const DARKPHASE_STALK_MS_MIN = 900, DARKPHASE_STALK_MS_MAX = 1700; // randomized so STALK never reads as a fixed-timer tick
  const DARKPHASE_PAUSE_MS_MIN = 100, DARKPHASE_PAUSE_MS_MAX = 250; // the "it's coming" telegraph beat, per spec
  const DARKPHASE_DISENGAGE_MS_MIN = 650, DARKPHASE_DISENGAGE_MS_MAX = 1000;
  const DARKPHASE_LUNGE_TIMEOUT_MS = 1500; // safety: if the player somehow outruns LUNGE, bail back to CLOSE IN rather than firing from far away
  const DARKPHASE_CLOSEIN_CURVE_RAD = 55 * Math.PI / 180; // how far CLOSE IN's path starts curving away from a straight line to the player
  const DARKPHASE_DISENGAGE_CURVE_RAD = 40 * Math.PI / 180;
  const DARKPHASE_STALK_MIN_DIST = 200, DARKPHASE_STALK_MAX_DIST = 420; // keeps STALK's lateral drift within a believable "circling" band
  const WALK_FRAME_PERIOD_MS = 260; // south 2-frame alternation period
  const NORTH_BOUNCE_AMPLITUDE = 4; // px, decorative only (no NORTH walk art)
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
  // Intro: flash -> shadow grows -> descend -> land -> normal AI begins.
  const INTRO_FLASH_MS = 700;
  const INTRO_SHADOW_MS = 900;
  const INTRO_DESCEND_MS = 800;
  const INTRO_LANDING_MS = 250;
  const INTRO_TOTAL_MS = INTRO_FLASH_MS + INTRO_SHADOW_MS + INTRO_DESCEND_MS + INTRO_LANDING_MS;
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
  // Death: brief hold on the cinematic pose, then a real (non-opacity-only)
  // particle dissolve — see buildDyingParticles()/drawBossDying().
  const DYING_DURATION_MS = 1600;
  // Fine sand/ash grain, not blocky squares — small enough that the sampling
  // grid itself reads as smooth erosion rather than visible pixel chunks.
  const DYING_CELL_SIZE = 3; // px, sampled at the cinematic sprite's on-screen size
  const PLAYER_HIT_RADIUS = 22;

  // Claw-projectile ranged attack, fired once per ATTACK cycle as a 3-way
  // volley (see spawnClawProjectile()).
  const CLAW_PROJECTILE_SPEED = 340; // slower than the player's 620 bullets — dodgeable
  const CLAW_PROJECTILE_HIT_RADIUS = 16; // a touch larger than before (14) for the longer blade, still tight relative to its visual length
  const BLADE_SPREAD_ANGLE = 15 * Math.PI / 180; // +-15 degrees either side of the center blade

  // Where each of the 3 blades spawns from — near the claws, not the torso
  // center. NORTH/SOUTH use fixed points measured directly on their own
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
    attackType: 'blade', // 'blade' (existing 3-way volley + melee swing) | 'arcClaw' (ARC CLAW SLASH) — chosen in enterAttackSequence()
    lastAttackType: 'blade', // tracks the previous attack so arcClaw can never fire twice in a row
    chaseBackoffUntil: 0,
    deadAt: 0,
    warningUntil: 0,
    defenseAimHits: 0, // valid AUTO-AIM-assisted hits landed during the current DEFENSE
    weakPointConsecutiveHits: 0, // ANY valid weak-point damage hit (auto-aimed or manual) landed during the current DEFENSE
    autoAimHitStreak: 0, // ANY valid AUTO-AIM-assisted damage hit, body or weak point, regardless of state — see registerGlobalAutoAimHit()
    invulnerableUntil: 0, // legacy field — no longer ever set to a nonzero value (4-hit AUTO AIM now triggers DARK PHASE, not a timed window); left in place harmlessly
    darkPhaseAttackTimer: 0, // dt-driven sub-phase timer, meaning depends on darkPhaseSubState — see updateBossDarkPhase()
    darkPhaseSubState: 'stalk', // 'stalk'|'closein'|'pause'|'lunge'|'arcclaw'|'disengage' — see updateBossDarkPhase()
    darkPhaseSign: 1, // ±1, re-rolled each STALK/CLOSE IN/DISENGAGE entry — which side GABRIEL curves in/out from, so it never reads as a straight magnet-line
    darkPhaseCloseInStartDist: 0, // distance-to-player captured at CLOSE IN entry, used to fade the curve out as it closes in
    darkPhasePauseMs: 0, // randomized 100-250ms telegraph duration for the current PAUSE
    darkPhaseDisengageMs: 0, // randomized duration for the current DISENGAGE
    darkPhaseStalkMs: 0, // randomized 900-1700ms duration for the current STALK — set fresh in startBossDarkPhase()/updateBossDarkPhaseDisengage()
    darkPhaseLungeElapsed: 0, // safety timeout accumulator for LUNGE — see DARKPHASE_LUNGE_TIMEOUT_MS
    // Cinematic sequence state (intro / HP threshold / death) — see the
    // "Boss cinematic sequences" constants above and startBossThreshold(),
    // startBossDying(), updateBossIntro/Threshold/Dying(), drawBoss*().
    phaseTriggered: { p30: false, p60: false, p90: false },
    introFromY: 0,
    introTargetY: 0,
    introLandingTriggered: false,
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

  function bossEnterState(state, now) {
    boss.state = state;
    boss.stateEnteredAt = now;
    if (state === 'attack') {
      boss.attackHitApplied = false;
      boss.attackProjectileSpawned = false;
    }
    // The GUARD BREAK and weak-point-streak counters only ever mean
    // something mid-DEFENSE — reset them the instant any other state
    // (fresh DEFENSE included, since this covers entering it too) is
    // entered so a stale count never survives.
    if (state !== 'defense') {
      boss.defenseAimHits = 0;
      boss.weakPointConsecutiveHits = 0;
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

  // Picks which attack this cycle will be. ARC CLAW SLASH is deliberately
  // never allowed twice in a row (falls back to the existing blade attack
  // instead) so the boss's attack pattern stays varied rather than
  // repeating the newest, flashiest move every time.
  function rollAttackType() {
    if (boss.lastAttackType === 'arcClaw') return 'blade';
    return Math.random() < 0.5 ? 'arcClaw' : 'blade';
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
    boss.x = W / 2;
    boss.introTargetY = Math.max(BOSS_DRAW_H * 0.55, H * 0.16); // the normal resting spawn spot
    boss.introFromY = -CINEMATIC_DRAW_H; // starts just above the visible screen
    boss.y = boss.introFromY;
    boss.spawned = true;
    boss.hp = BOSS_HP_MAX;
    boss.dir = 'down';
    boss.downFacing = 'south'; // fresh spawn always has no prior facing yet — default SOUTH per spec
    boss.defenseDir = 'south';
    boss.moving = false;
    boss.warningUntil = now + 1500;
    boss.defenseAimHits = 0;
    boss.autoAimHitStreak = 0;
    boss.invulnerableUntil = 0;
    boss.attackType = 'blade';
    boss.lastAttackType = 'blade';
    boss.phaseTriggered = { p30: false, p60: false, p90: false };
    boss.introLandingTriggered = false;
    boss.cinematicElapsed = 0;
    boss.dyingParticlesBuilt = false;
    boss.dyingParticles = [];
    // BOSS MODE only ever shows this — TRAINING MODE never calls
    // spawnBoss() at all, so it never plays.
    bossEnterState('intro', now);
  }

  function bossIsInCinematic() {
    return boss.state === 'intro' || boss.state === 'threshold' || boss.state === 'dying' || boss.state === 'dead';
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
    clawProjectiles.length = 0; // no lingering attack hazards during the death cinematic
    arcClawSlashes.length = 0;
    boss.dyingParticlesBuilt = false;
    boss.dyingParticles = [];
    bossEnterState('dying', now);
  }

  // Triggered by 4 valid AUTO-AIM-assisted hits (see registerGlobalAutoAimHit()
  // above) — GABRIEL goes fully invulnerable (body/weak-point/AUTO-AIM/
  // barrel-explosion damage all become 0 — see applyBodyHitToBoss()/
  // applyExplosionDamageToBoss()) and switches to an ARC-CLAW-SLASH-only AI
  // (see updateBossDarkPhase()). Deliberately NOT added to bossIsInCinematic()
  // — DARK PHASE must stay a valid AUTO AIM target (it just takes 0 damage),
  // and FLASH GRENADE must stay usable during it. Has NO timeout of its
  // own — see startBossFlashDown() below for the only way out.
  function startBossDarkPhase(now) {
    clawProjectiles.length = 0; // no lingering 3WAY BLADE/other attacks from before DARK PHASE
    arcClawSlashes.length = 0;
    boss.darkPhaseAttackTimer = 0;
    boss.darkPhaseLungeElapsed = 0;
    boss.darkPhaseSign = Math.random() < 0.5 ? 1 : -1;
    boss.darkPhaseStalkMs = DARKPHASE_STALK_MS_MIN + Math.random() * (DARKPHASE_STALK_MS_MAX - DARKPHASE_STALK_MS_MIN);
    boss.darkPhaseSubState = 'stalk'; // always starts by warily drifting, never mid-slash/mid-lunge
    bossEnterState('darkphase', now);
  }

  // DARK PHASE AI: STALK -> CLOSE IN -> PAUSE -> LUNGE -> ARC CLAW ->
  // DISENGAGE -> (back to STALK), completely distinct from normal CHASE/
  // ATTACK/DEFENSE. GABRIEL's own x/y genuinely move (not just a VFX), and
  // deliberately never point straight at the player every frame — each
  // phase either moves laterally, curves in from a fixed-at-entry side, or
  // (LUNGE only) beelines for a short, fast, clearly-telegraphed burst —
  // so the whole loop reads as "being stalked" rather than a magnet or a
  // stationary turret. See the per-phase helpers just below for exactly
  // what each one does.
  //   stalk    -> slow lateral drift around the player (a rough orbiting
  //               band, not a fixed radius), for a randomized duration
  //   closein  -> medium-speed approach along a curve that starts wide (the
  //               fixed-at-entry darkPhaseSign chooses which side) and
  //               straightens out as GABRIEL closes in, ending once within
  //               DARKPHASE_PAUSE_TRIGGER_RANGE
  //   pause    -> a brief (100-250ms) full stop — the eye's own telegraph
  //               beat, with a temporary brightness boost (see
  //               drawBossDarkPhase()) — before the strike
  //   lunge    -> a short, fast, DIRECT burst (no curve) until within
  //               DARKPHASE_ATTACK_RANGE, which is when ARC CLAW SLASH
  //               actually fires — so the attack always fires from
  //               genuinely close range, by construction
  //   arcclaw  -> hold position for the slash's own ARC_CLAW_LIFETIME_MS
  //               (the existing attack fully owns its own hit timing — see
  //               updateArcClawSlashes())
  //   disengage-> pull back at an angle (not a straight retreat) for a
  //               randomized duration, then loop back to STALK
  // No DEFENSE, no 3WAY BLADE, no normal ATTACK — ARC CLAW SLASH is the only
  // attack this loop ever calls, forever, until FLASH GRENADE ends DARK
  // PHASE (see startBossFlashDown() below).
  function updateBossDarkPhaseStalk(dt, now) {
    const dx = player.x - boss.x, dy = player.y - boss.y;
    const dist = Math.hypot(dx, dy) || 1;
    const perpAngle = Math.atan2(dy, dx) + boss.darkPhaseSign * (Math.PI / 2);
    let vx = Math.cos(perpAngle), vy = Math.sin(perpAngle);
    // Mild radial correction keeps STALK orbiting a believable band instead
    // of wandering arbitrarily far or crowding the player — blended in
    // alongside the lateral component, never replacing it, so GABRIEL is
    // still always drifting sideways rather than pointing straight at/away
    // from the player.
    if (dist > DARKPHASE_STALK_MAX_DIST) { vx += (dx / dist) * 0.6; vy += (dy / dist) * 0.6; }
    else if (dist < DARKPHASE_STALK_MIN_DIST) { vx -= (dx / dist) * 0.6; vy -= (dy / dist) * 0.6; }
    const len = Math.hypot(vx, vy) || 1;
    boss.x += (vx / len) * DARKPHASE_STALK_SPEED * dt;
    boss.y += (vy / len) * DARKPHASE_STALK_SPEED * dt;
    boss.moving = true;
    boss.darkPhaseAttackTimer += dt * 1000;
    if (boss.darkPhaseAttackTimer >= boss.darkPhaseStalkMs) {
      boss.darkPhaseAttackTimer = 0;
      boss.darkPhaseSign = Math.random() < 0.5 ? 1 : -1; // re-rolled for the upcoming CLOSE IN curve side
      boss.darkPhaseCloseInStartDist = dist;
      boss.darkPhaseSubState = 'closein';
    }
  }

  function updateBossDarkPhaseCloseIn(dt, now) {
    const dx = player.x - boss.x, dy = player.y - boss.y;
    const dist = Math.hypot(dx, dy) || 1;
    const toPlayerAngle = Math.atan2(dy, dx);
    // t=1 at CLOSE IN's own start (full curve), fading to 0 as it closes —
    // an approach that visibly bends in from the side rather than a
    // straight line, without ever refusing to actually make progress.
    const t = Math.max(0, Math.min(1, dist / (boss.darkPhaseCloseInStartDist || dist)));
    const moveAngle = toPlayerAngle + boss.darkPhaseSign * DARKPHASE_CLOSEIN_CURVE_RAD * t;
    boss.x += Math.cos(moveAngle) * DARKPHASE_CLOSEIN_SPEED * dt;
    boss.y += Math.sin(moveAngle) * DARKPHASE_CLOSEIN_SPEED * dt;
    boss.moving = true;
    if (dist <= DARKPHASE_PAUSE_TRIGGER_RANGE) {
      boss.darkPhaseSubState = 'pause';
      boss.darkPhaseAttackTimer = 0;
      boss.darkPhasePauseMs = DARKPHASE_PAUSE_MS_MIN + Math.random() * (DARKPHASE_PAUSE_MS_MAX - DARKPHASE_PAUSE_MS_MIN);
    }
  }

  function updateBossDarkPhasePause(dt, now) {
    boss.moving = false; // a genuine full stop — the "it's coming" telegraph beat
    boss.darkPhaseAttackTimer += dt * 1000;
    if (boss.darkPhaseAttackTimer >= boss.darkPhasePauseMs) {
      boss.darkPhaseAttackTimer = 0;
      boss.darkPhaseLungeElapsed = 0;
      boss.darkPhaseSubState = 'lunge';
    }
  }

  function updateBossDarkPhaseLunge(dt, now) {
    const dx = player.x - boss.x, dy = player.y - boss.y;
    const dist = Math.hypot(dx, dy) || 1;
    boss.x += (dx / dist) * DARKPHASE_LUNGE_SPEED * dt;
    boss.y += (dy / dist) * DARKPHASE_LUNGE_SPEED * dt;
    boss.moving = true;
    if (dist <= DARKPHASE_ATTACK_RANGE) {
      // Only ever reached here, genuinely close — see the range check
      // above — so ARC CLAW SLASH can never fire from far away.
      boss.dir = angleToBucket(Math.atan2(dy, dx));
      boss.darkPhaseSubState = 'arcclaw';
      boss.darkPhaseAttackTimer = 0;
      boss.moving = false;
      spawnArcClawSlash(now);
      return;
    }
    boss.darkPhaseLungeElapsed += dt * 1000;
    if (boss.darkPhaseLungeElapsed > DARKPHASE_LUNGE_TIMEOUT_MS) {
      // Safety: the player outran the burst — fall back to CLOSE IN rather
      // than firing from a distance the attack was never meant to cover.
      boss.darkPhaseLungeElapsed = 0;
      boss.darkPhaseCloseInStartDist = dist;
      boss.darkPhaseSubState = 'closein';
    }
  }

  function updateBossDarkPhaseArcClaw(dt, now) {
    boss.moving = false;
    boss.darkPhaseAttackTimer += dt * 1000;
    if (boss.darkPhaseAttackTimer >= ARC_CLAW_LIFETIME_MS) {
      boss.darkPhaseAttackTimer = 0;
      boss.darkPhaseSign = Math.random() < 0.5 ? 1 : -1; // re-rolled for the upcoming DISENGAGE angle
      boss.darkPhaseDisengageMs = DARKPHASE_DISENGAGE_MS_MIN + Math.random() * (DARKPHASE_DISENGAGE_MS_MAX - DARKPHASE_DISENGAGE_MS_MIN);
      boss.darkPhaseSubState = 'disengage';
    }
  }

  function updateBossDarkPhaseDisengage(dt, now) {
    const dx = player.x - boss.x, dy = player.y - boss.y;
    const awayAngle = Math.atan2(-dy, -dx) + boss.darkPhaseSign * DARKPHASE_DISENGAGE_CURVE_RAD;
    boss.x += Math.cos(awayAngle) * DARKPHASE_DISENGAGE_SPEED * dt;
    boss.y += Math.sin(awayAngle) * DARKPHASE_DISENGAGE_SPEED * dt;
    boss.moving = true;
    boss.darkPhaseAttackTimer += dt * 1000;
    if (boss.darkPhaseAttackTimer >= boss.darkPhaseDisengageMs) {
      boss.darkPhaseAttackTimer = 0;
      boss.darkPhaseStalkMs = DARKPHASE_STALK_MS_MIN + Math.random() * (DARKPHASE_STALK_MS_MAX - DARKPHASE_STALK_MS_MIN);
      boss.darkPhaseSubState = 'stalk';
    }
  }

  function updateBossDarkPhase(dt, now) {
    switch (boss.darkPhaseSubState) {
      case 'closein': updateBossDarkPhaseCloseIn(dt, now); break;
      case 'pause': updateBossDarkPhasePause(dt, now); break;
      case 'lunge': updateBossDarkPhaseLunge(dt, now); break;
      case 'arcclaw': updateBossDarkPhaseArcClaw(dt, now); break;
      case 'disengage': updateBossDarkPhaseDisengage(dt, now); break;
      default: updateBossDarkPhaseStalk(dt, now); break; // 'stalk'
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
    const scale = (BOSS_DRAW_H * DARKPHASE_SCALE) / DARKPHASE_EYES_SOURCE_H;
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
    const head = getDarkPhaseHeadScreenPos();
    const angle = getAimAngle();
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    const toHeadX = head.x - player.x, toHeadY = head.y - player.y;
    const along = toHeadX * dirX + toHeadY * dirY;
    if (along < 0) return false;
    const perpX = toHeadX - dirX * along, perpY = toHeadY - dirY * along;
    return Math.hypot(perpX, perpY) <= DARKPHASE_HEAD_HIT_RADIUS;
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
    clawProjectiles.length = 0; // no lingering attack hazards during the DOWN window
    arcClawSlashes.length = 0;
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

  let weakPointFlashUntil = 0;
  let weakPointFlashAt = { x: 0, y: 0 };
  let guardBreakFlashUntil = 0;
  // A brief red hit-tint across the boss's whole sprite on a genuine
  // weak-point (or its AUTO-AIM body-fallback) damage hit — separate from
  // the AUTO AIM reticle's own red color and from the small local spark
  // burst above, and drawn in drawBoss() via a source-atop tint rather than
  // a flat color fill, so it reads as "hit tint", not a solid red silhouette.
  const BOSS_HIT_TINT_MS = 90; // within the requested 50-120ms band
  let bossHitTintUntil = 0;

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

  // ---------- Wall ricochet VFX (LEFT/RIGHT stage boundary only) ----------
  // Deliberately small and metallic-reading — a handful of sparks and a
  // short white/yellow tracer — never anything close to the barrel
  // explosion's scale.
  const wallSparks = [];
  const WALL_SPARK_DURATION_MS = 160;
  function spawnWallSpark(x, y, newVx, now) {
    const bounceAngle = Math.atan2(0, newVx); // purely horizontal, matches the mirror-reflection bounce
    const sparks = [];
    for (let i = 0; i < 6; i++) {
      const a = bounceAngle + (Math.random() - 0.5) * 2.0;
      sparks.push({ angle: a, speed: 70 + Math.random() * 110, size: 0.9 + Math.random() * 1.2 });
    }
    wallSparks.push({ x, y, startAt: now, sparks });
  }
  function drawWallSparks(now) {
    for (const s of wallSparks) {
      const t = now - s.startAt;
      if (t >= WALL_SPARK_DURATION_MS) continue;
      const frac = t / WALL_SPARK_DURATION_MS;
      const alpha = 1 - frac;
      ctx.save();
      ctx.translate(s.x, s.y);
      for (const p of s.sparks) {
        const d = p.speed * (t / 1000);
        ctx.fillStyle = `rgba(255,240,190,${alpha})`;
        ctx.beginPath();
        ctx.arc(Math.cos(p.angle) * d, Math.sin(p.angle) * d, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(255,255,240,${Math.max(0, alpha - 0.4) * 1.5})`;
      ctx.beginPath();
      ctx.arc(0, 0, 2.6 * (1 - frac * 0.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    for (let i = wallSparks.length - 1; i >= 0; i--) {
      if (now - wallSparks[i].startAt > WALL_SPARK_DURATION_MS) wallSparks.splice(i, 1);
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
      if (boss.state !== 'flashdown' && boss.state !== 'darkphase' && !bossIsInCinematic()) {
        startBossDarkPhase(now);
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
  function applyBodyHitToBoss(now, bulletX, bulletY, bulletVx, bulletVy, autoAimed, isRicochet) {
    // GUARD BREAK's stagger pause is a brief (250ms), deliberately
    // untargetable beat between DEFENSE ending and ATTACK beginning — a hit
    // landing in that window must not re-trigger DEFENSE mid-transition.
    // bossIsInCinematic() also covers intro/threshold/dying/dead: the boss
    // is untargetable throughout every cinematic sequence, not just death.
    if (!boss.spawned || bossIsInCinematic() || boss.state === 'guardbreak') return;
    // DARK PHASE: total damage immunity — still shows the same realistic
    // ricochet/spark feedback as an ordinary blocked hit, never a big blue
    // barrier. Unlike DEFENSE (which barrel explosions always bypass), DARK
    // PHASE blocks EVEN barrel explosions — see applyExplosionDamageToBoss().
    // Has no timeout of its own; only FLASH GRENADE ends it.
    if (boss.state === 'darkphase') {
      spawnDefenseRicochet(now, bulletX, bulletY, bulletVx, bulletVy);
      return;
    }
    const incomingFrom = OPPOSITE_COMPASS[velocityToCompass(bulletVx, bulletVy)];
    if (boss.state === 'defense') {
      const priorDefenseDir = boss.defenseDir; // captured before reassignment, for the ricochet-direction check below
      boss.defenseDir = incomingFrom;
      // A wall-ricocheted bullet striking from a direction OTHER than the
      // one just being defended bypasses the block entirely — a genuine
      // flank/rear hit (per the wall-ricochet spec), dealing real damage
      // regardless of auto-aim. This ADDS to, and never removes, the
      // existing autoAimed-gated block/damage rule below: a non-ricocheted
      // bullet's behavior is completely unchanged from before, and a
      // ricocheted bullet that still lands from the SAME defended
      // direction also falls through to that same existing rule.
      const isFlankRicochet = isRicochet && incomingFrom !== priorDefenseDir;
      if (autoAimed || isFlankRicochet) {
        boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
        if (checkBossHpMilestones(now)) return; // death or a threshold cinematic took over
        weakPointFlashUntil = now + 220; // "valid hit" feedback — same as a real weak-point hit, not a ricochet
        weakPointFlashAt = { x: bulletX, y: bulletY };
        bossHitTintUntil = now + BOSS_HIT_TINT_MS;
        if (autoAimed) { registerDefenseAimHit(now); registerGlobalAutoAimHit(now); }
        return;
      }
      spawnDefenseRicochet(now, bulletX, bulletY, bulletVx, bulletVy);
      return;
    }
    boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
    // Brief hit-flash feedback (reuses the existing BOSS_HIT_TINT_MS/
    // drawBossWithHitTint() machinery, already used by the DEFENSE-blocked
    // and weak-point hit paths below) — gated on actual HP damage having
    // just been applied above, not merely on a bullet touching the boss.
    bossHitTintUntil = now + BOSS_HIT_TINT_MS;
    if (checkBossHpMilestones(now)) return;
    if (autoAimed) registerGlobalAutoAimHit(now);
    // FLASH DOWN must never be interrupted into DEFENSE by an ordinary body
    // hit — it stays fully damageable for its whole duration instead.
    if (boss.state !== 'flashdown') {
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

  // 5 consecutive valid weak-point hits (any aim mode) force DEFENSE open:
  // the boss immediately counterattacks (through PRE_ATTACK for S/E/W, or
  // straight into ATTACK for N, via the same enterAttackSequence() CHASE
  // uses) and shoves the player away (0 damage) so the fight can't be
  // trivially chain-stunned from the weak point forever.
  function triggerWeakPointForcedCounter(now) {
    boss.weakPointConsecutiveHits = 0;
    applyPlayerKnockback(now);
    boss.dir = angleToBucket(Math.atan2(player.y - boss.y, player.x - boss.x));
    enterAttackSequence(now);
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
    weakPointFlashUntil = now + 220;
    bossHitTintUntil = now + BOSS_HIT_TINT_MS;
    const wp = getWeakPointScreenPos(boss.defenseDir);
    if (wp) weakPointFlashAt = wp;
    if (checkBossHpMilestones(now)) return; // death or a threshold cinematic took over
    if (autoAimed) registerGlobalAutoAimHit(now);

    boss.weakPointConsecutiveHits += 1;
    if (boss.weakPointConsecutiveHits >= WEAKPOINT_FORCED_COUNTER_HITS) {
      triggerWeakPointForcedCounter(now); // this hit is "spent" here — never also registers toward GUARD BREAK
      return;
    }
    if (autoAimed) registerDefenseAimHit(now);
  }

  function updateBoss(dt, now) {
    if (gameState.mode !== 'boss') return; // TRAINING MODE never spawns a boss
    if (!boss.spawned) {
      if (now - modeStartTime >= BOSS_SPAWN_DELAY_MS) spawnBoss(now);
      return;
    }
    if (boss.state === 'dead') return;
    // Cinematic sequences each own their own progression/timing entirely —
    // see updateBossIntro/Threshold/Dying() — and never fall through to the
    // normal CHASE/ATTACK/DEFENSE/RECOVER AI below.
    if (boss.state === 'intro') { updateBossIntro(dt, now); return; }
    if (boss.state === 'threshold') { updateBossThreshold(dt, now); return; }
    if (boss.state === 'dying') { updateBossDying(dt, now); return; }
    if (boss.state === 'flashdown') { updateBossFlashDown(dt, now); return; }
    if (boss.state === 'darkphase') { updateBossDarkPhase(dt, now); return; }
    if (window.__game.freezeBossAI) return; // debug/verification only



    const dx = player.x - boss.x;
    const dy = player.y - boss.y;
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
        vx = dirX * BOSS_SPEED;
        vy = dirY * BOSS_SPEED;
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
      // ARC CLAW SLASH is a wholly separate attack (its own hitbox/damage/
      // knockback, handled entirely inside updateArcClawSlashes()) — it
      // replaces both the melee swing AND the 3-way blade for this cycle,
      // it doesn't run alongside them, and it needs a longer active window
      // to cover its own full sweep.
      const activeMs = isArcClaw ? ARC_CLAW_LIFETIME_MS : BOSS_ATTACK_ACTIVE_MS;
      if (elapsed >= fireAt) {
        if (!boss.attackProjectileSpawned) {
          boss.attackProjectileSpawned = true;
          if (isArcClaw) spawnArcClawSlash(now); else spawnClawProjectile(now);
        }
        if (!isArcClaw && elapsed < fireAt + activeMs && !boss.attackHitApplied) {
          const facing = BASE_ANGLE[boss.dir];
          const hx = boss.x + Math.cos(facing) * BOSS_ATTACK_REACH;
          const hy = boss.y + Math.sin(facing) * BOSS_ATTACK_REACH;
          const hd = Math.hypot(player.x - hx, player.y - hy);
          if (!isPlayerInvulnerable() && hd <= BOSS_ATTACK_HIT_RADIUS + PLAYER_HIT_RADIUS) {
            boss.attackHitApplied = true;
            window.__game.playerHitCount++;
            playerHitFlashUntil = now + 150;
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
      if (now - boss.stateEnteredAt >= BOSS_RECOVER_MS) {
        bossEnterState('chase', now);
      }
    }

    // Facing: derived from actual movement, same 4-direction bucket the
    // player's ACTION STICK uses; held steady while stopped/attacking so
    // the boss keeps facing the direction it last moved/attacked in.
    if (boss.moving && (vx !== 0 || vy !== 0)) {
      boss.dir = angleToBucket(Math.atan2(vy, vx));
    }

    boss.x = Math.max(BOSS_DRAW_W * 0.3, Math.min(W - BOSS_DRAW_W * 0.3, boss.x));
    boss.y = Math.max(BOSS_DRAW_H * 0.3, Math.min(H - BOSS_DRAW_H * 0.3, boss.y));
  }

  // BOSS MODE start: flash -> shadow grows -> descend -> land -> normal AI.
  // boss.cinematicElapsed is cached here (not recomputed in draw()) so a
  // PAUSE mid-sequence freezes it for free and RESUME continues from
  // exactly the same point — see the boss object's cinematicElapsed field.
  function updateBossIntro(dt, now) {
    boss.cinematicElapsed += dt * 1000;
    const elapsed = boss.cinematicElapsed;
    const descendStart = INTRO_FLASH_MS + INTRO_SHADOW_MS;
    if (elapsed >= descendStart) {
      const t = Math.min(1, (elapsed - descendStart) / INTRO_DESCEND_MS);
      const eased = 1 - Math.pow(1 - t, 2); // ease-out — slows into the landing
      boss.y = boss.introFromY + (boss.introTargetY - boss.introFromY) * eased;
    }
    if (elapsed >= descendStart + INTRO_DESCEND_MS && !boss.introLandingTriggered) {
      boss.introLandingTriggered = true;
      triggerScreenShake(now, 8, 220);
    }
    if (elapsed >= INTRO_TOTAL_MS) {
      boss.y = boss.introTargetY;
      bossEnterState('chase', now);
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
    }
  }

  // ---------- Boss claw projectile (ranged ATTACK payload) ----------
  // Fired once per ATTACK cycle, aimed at the player's position at the
  // exact instant it spawns — no homing, trajectory is fixed forever after.
  const clawProjectiles = [];

  // Fires a 3-way volley (LEFT/CENTER/RIGHT blades): the center blade aims
  // at the player's position at this exact instant, the outer two diverge
  // by +-BLADE_SPREAD_ANGLE from that same center trajectory. All 3 are
  // independent projectiles — their own x/y/vx/vy/angle/hitbox — with
  // velocity fixed at spawn; nothing here re-aims them afterward (see
  // updateClawProjectiles(), which only ever adds vx*dt/vy*dt).
  function spawnClawProjectile(now) {
    const origin = getClawOrigin();
    const centerAngle = Math.atan2(player.y - origin.y, player.x - origin.x);
    for (const spread of [-BLADE_SPREAD_ANGLE, 0, BLADE_SPREAD_ANGLE]) {
      const angle = centerAngle + spread;
      clawProjectiles.push({
        x: origin.x, y: origin.y,
        vx: Math.cos(angle) * CLAW_PROJECTILE_SPEED,
        vy: Math.sin(angle) * CLAW_PROJECTILE_SPEED,
        angle,
      });
    }
  }

  function updateClawProjectiles(dt, now) {
    for (let i = clawProjectiles.length - 1; i >= 0; i--) {
      const p = clawProjectiles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < -40 || p.x > W + 40 || p.y < cameraY - 40 || p.y > cameraY + H + 40) {
        clawProjectiles.splice(i, 1);
        continue;
      }
      if (!isPlayerInvulnerable() &&
          Math.hypot(p.x - player.x, p.y - player.y) <= CLAW_PROJECTILE_HIT_RADIUS + PLAYER_HIT_RADIUS) {
        clawProjectiles.splice(i, 1);
        window.__game.playerHitCount++;
        playerHitFlashUntil = now + 150;
      }
    }
  }

  // Canvas-drawn blade — slender, metallic silver-to-black, oriented along
  // its travel direction, with a short trailing streak. No image asset.
  // A long, thin, sharply-pointed claw-blade — not a bullet, not a short
  // triangle: a pronounced tip, narrow shoulders just behind it, then a
  // long thin tapering tail. Total tip-to-tail length ~62px, ~1.7x the
  // previous 36px blade (within the requested 1.5-2x band); width is
  // narrower than before (5.2px vs 8px) so it still reads as a thin spike
  // despite being longer.
  function drawClawProjectile(p) {
    const tipX = 24, shoulderX = 4, shoulderHalfW = 2.6, tailX = -38, tailHalfW = 0.8;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    const grad = ctx.createLinearGradient(tailX, 0, tipX, 0);
    grad.addColorStop(0, 'rgba(20,20,24,0)');
    grad.addColorStop(0.5, 'rgba(110,113,122,0.75)');
    grad.addColorStop(1, 'rgba(240,242,246,0.98)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(tipX, 0);
    ctx.lineTo(shoulderX, -shoulderHalfW);
    ctx.lineTo(tailX, -tailHalfW);
    ctx.lineTo(tailX, tailHalfW);
    ctx.lineTo(shoulderX, shoulderHalfW);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,10,12,0.75)';
    ctx.lineWidth = 0.75;
    ctx.stroke();
    ctx.restore();
  }

  // ---------- ARC CLAW SLASH (separate attack type from the 3-way blade) ----------
  // Managed as its own array/object shape (type-distinct from clawProjectiles
  // above) so the two never share update/draw/hit logic: a giant claw is
  // swept through a quadratic-Bezier arc near the boss, its own sprite
  // rotation kept locked to the arc's live tangent direction the whole way,
  // rather than flying in a straight line at a fixed angle.
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
    const geo = pickArcClawGeometry(origin, { x: player.x, y: player.y });
    arcClawSlashes.push({
      p0: geo.p0, p1: geo.p1, p2: geo.p2, mirrored: geo.mirrored,
      startedAt: now, hasHit: false,
      x: geo.p0.x, y: geo.p0.y, angle: 0, tangentAngle: 0, trail: [],
    });
  }

  function updateArcClawSlashes(now) {
    for (let i = arcClawSlashes.length - 1; i >= 0; i--) {
      const s = arcClawSlashes[i];
      const u = (now - s.startedAt) / ARC_CLAW_LIFETIME_MS;
      if (u >= 1) { arcClawSlashes.splice(i, 1); continue; }
      const t = arcClawEase(Math.max(0, u));
      const pos = quadBezierPoint(s.p0, s.p1, s.p2, t);
      const tangentAngle = quadBezierTangentAngle(s.p0, s.p1, s.p2, t);

      // Each stored sample keeps its OWN position/rotation from when it was
      // the live frame — angle for the claw image's draw rotation, and the
      // raw tangentAngle too (the auxiliary crescent trail aligns to the
      // pure travel direction, not the image's own tip-offset rotation).
      s.trail.push({ x: s.x, y: s.y, angle: s.angle, tangentAngle: s.tangentAngle });
      if (s.trail.length > ARC_CLAW_TRAIL_LEN) s.trail.shift();

      s.x = pos.x; s.y = pos.y; s.tangentAngle = tangentAngle;
      // Re-align the claw image's own tip<->base axis to the live tangent
      // direction, so it visibly points where it's travelling rather than
      // just spinning around its own center.
      const baseTip = s.mirrored ? ARC_CLAW_BASE_TIP_ANGLE_FLIPPED : ARC_CLAW_BASE_TIP_ANGLE;
      s.angle = tangentAngle - baseTip;

      if (!s.hasHit && !isPlayerInvulnerable()) {
        // Oriented rectangle aligned to the live travel direction (never a
        // plain circle) — local +X is "ahead of the tip", local -X runs
        // back along the trailing claw body.
        const relX = player.x - s.x, relY = player.y - s.y;
        const c = Math.cos(-tangentAngle), sn = Math.sin(-tangentAngle);
        const localX = relX * c - relY * sn;
        const localY = relX * sn + relY * c;
        if (localX >= -ARC_CLAW_HIT_HALF_LEN_BACK && localX <= ARC_CLAW_HIT_HALF_LEN_FWD &&
            Math.abs(localY) <= ARC_CLAW_HIT_HALF_WIDTH + PLAYER_HIT_RADIUS) {
          s.hasHit = true; // at most one damage instance per slash, ever
          window.__game.playerHitCount++;
          playerHitFlashUntil = now + 150;
          applyPlayerKnockbackAlongAngle(tangentAngle, ARC_CLAW_KNOCKBACK_DISTANCE, ARC_CLAW_KNOCKBACK_SUPPRESS_MS, now);
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
  const gameState = {
    mode: 'boss', // 'boss' | 'training'
    paused: false, // game starts running in BOSS MODE, same as before PAUSE existed
  };
  let modeStartTime = performance.now();

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
  function worldScrollUnlocked() {
    return H >= W && gameState.mode === 'boss' && boss.state === 'dead' && !stageTransition.active;
  }
  function exitWorldPos() {
    return { x: W / 2, y: -worldExtraAbove + EXIT_ZONE_H / 2 + 20 };
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
  function updateStageTransition(now) {
    if (!stageTransition.active) return;
    const elapsed = now - stageTransition.startedAt;
    if (stageTransition.phase === 'out') {
      if (elapsed < STAGE_FADE_MS) return;
      currentStageIndex = pickRandomOtherStage(currentStageIndex);
      cameraY = 0;
      resetPlayerPosition();
      player.baseDir = 'down';
      player.aimOffsetRaw = 0; player.aimOffset = 0;
      bullets.length = 0; clawProjectiles.length = 0; arcClawSlashes.length = 0; explosions.length = 0;
      barrels.length = 0;
      barrelLandings.length = 0;
      spawnBarrels(2 + Math.floor(Math.random() * 3));
      spawnBoss(now); // fresh full-HP boss; plays the existing FLASH/SHADOW/DESCEND/LANDING intro
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

  function pickBarrelSpot() {
    const marginX = BARREL_DRAW_H * 1.5;
    const marginTop = H * 0.22; // stay clear of the boss's spawn band up top
    const marginBottom = H * 0.30;
    // Live player/boss positions (not just their initial spawn points) —
    // matters for the ceiling restock, which can fire mid-fight with both
    // anywhere on the field, not only at mode-start.
    const playerX = player.x, playerY = player.y;
    const bossX = boss.spawned ? boss.x : W / 2;
    const bossY = boss.spawned ? boss.y : Math.max(BOSS_DRAW_H * 0.55, H * 0.16);
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = marginX + Math.random() * (W - marginX * 2);
      const y = marginTop + Math.random() * (H - marginTop - marginBottom);
      if (isNearUIZone(x, y)) continue;
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
    return { x: W / 2 + (Math.random() - 0.5) * W * 0.5, y: H * 0.5 };
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

  function explodeBarrel(barrel, now) {
    barrel.alive = false;
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
    explosions.push({ x: barrel.x, y: barrel.y, startAt: now, particles });
    triggerScreenShake(now, 6, 180);
    // Explosion damage bypasses DEFENSE entirely — a stage gimmick that
    // works regardless of the boss's current state, unlike gunfire. The
    // reach check adds BOSS_HURT_RADIUS so it's the boss's hurtbox CIRCLE
    // (not just its exact center point) that has to be within blast range.
    if (boss.spawned && boss.state !== 'dead' &&
        Math.hypot(barrel.x - boss.x, barrel.y - boss.y) <= BARREL_EXPLOSION_RADIUS + BOSS_HURT_RADIUS) {
      applyExplosionDamageToBoss(BARREL_DAMAGE, now);
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
        const count = BARREL_RESTOCK_MIN_COUNT + Math.floor(Math.random() * (BARREL_RESTOCK_MAX_COUNT - BARREL_RESTOCK_MIN_COUNT + 1));
        spawnFallingBarrels(count, now);
      }
    }
  }

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
    const t = now - e.startAt;
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
    if (!boss.spawned || bossIsInCinematic() || boss.state === 'darkphase') return;
    boss.hp = Math.max(0, boss.hp - amount);
    checkBossHpMilestones(now);
  }

  // ---------- AUTO AIM ----------
  // Manual AIM STICK aiming is always available; when the reticle (driven
  // by the raw stick angle) comes within AUTO_AIM_RADIUS of a targetable
  // object's target point, the effective aim is pulled a fraction of the
  // way toward that point each frame (a gentle, releasable magnet, not a
  // hard lock), and only while the player is actively holding the AIM
  // STICK near it — never automatically without stick input. The pull is
  // clamped through the exact same ±60 deg function as manual aim, so it
  // can never point outside the current base-direction wedge.
  const AUTO_AIM_RADIUS = 46; // screen px, around the reticle tip
  const AUTO_AIM_SNAP_STRENGTH = 0.35; // fraction of remaining angle closed per frame
  let autoAimActive = false;
  let autoAimTargetIsBoss = false; // true when the current snap target is the boss (weak point or body), not a barrel

  function getAutoAimTargetPoint() {
    // No lock-on target at all during any cinematic (intro/threshold/dying)
    // or once truly dead — bossIsInCinematic() covers all four.
    if (boss.spawned && bossIsInCinematic()) return { primary: null, secondary: null };
    // DEFENSE: the forehead weak point takes priority over the body — only
    // fall back to the body center if the weak point itself isn't in range
    // (or doesn't exist at all for the current defenseDir, e.g. NORTH).
    if (boss.spawned && boss.state === 'defense') {
      const wp = getWeakPointScreenPos(boss.defenseDir);
      return { primary: wp, secondary: { x: boss.x, y: boss.y } };
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

    const center = BASE_ANGLE[player.baseDir];
    const rawAngle = center + player.aimOffsetRaw;
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
    if (bossTargets.primary) {
      const d = Math.hypot(tipX - bossTargets.primary.x, tipY - bossTargets.primary.y);
      if (d < bestDist) { bestDist = d; best = bossTargets.primary; bestIsBoss = true; }
    }
    if (!best && bossTargets.secondary) {
      const d = Math.hypot(tipX - bossTargets.secondary.x, tipY - bossTargets.secondary.y);
      if (d < bestDist) { bestDist = d; best = bossTargets.secondary; bestIsBoss = true; }
    }
    for (const b of barrels) {
      if (!b.alive) continue;
      const d = Math.hypot(tipX - b.x, tipY - b.y);
      if (d < bestDist) { bestDist = d; best = { x: b.x, y: b.y }; bestIsBoss = false; }
    }

    if (best) {
      const desiredAngle = Math.atan2(best.y - my, best.x - mx);
      const desiredOffset = clampToHalfRange(desiredAngle, center);
      player.aimOffset += (desiredOffset - player.aimOffset) * AUTO_AIM_SNAP_STRENGTH;
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
  function resetModeState() {
    resetPlayerPosition();
    player.baseDir = 'down';
    player.aimOffsetRaw = 0;
    player.aimOffset = 0;
    player.dashing = false;
    player.dashBuffered = false;
    player.bufferedDashAngle = null;
    player.dashChainCount = 0;
    player.facingLockUntil = 0;
    player.knockbackUntil = 0;
    player.lastActivityAt = performance.now();
    player.relaxed = false;

    bullets.length = 0;
    clawProjectiles.length = 0;
    arcClawSlashes.length = 0;
    explosions.length = 0;

    boss.spawned = false;
    boss.state = 'inactive';
    boss.hp = BOSS_HP_MAX;
    boss.attackType = 'blade';
    boss.lastAttackType = 'blade';
    boss.darkPhaseAttackTimer = 0;
    boss.darkPhaseSubState = 'stalk';
    boss.darkPhaseLungeElapsed = 0;
    darkPhaseOverlayAlpha = 0; // RESTART snaps the dark overlay off instantly — no lingering fade

    // Stage world/camera/EXIT (PART 21-29) — a RESTART or mode switch always
    // returns to the first/default stage with the world fully closed back up.
    currentStageIndex = 0;
    cameraY = 0;
    stageTransition.active = false;
    stageTransition.phase = null;

    modeStartTime = performance.now();
    barrelLandings.length = 0;
    barrelRestockPending = false;
    barrelRestockRemainingMs = 0;
    spawnBarrels(2 + Math.floor(Math.random() * 3)); // 2-4
    hideRangeUI();
    resetFlashGrenade();
  }

  function startMode(mode) {
    gameState.mode = mode;
    resetModeState();
    gameState.paused = false;
    hideModeMenu();
  }

  function releaseAllHeldInputs() {
    // So nothing stays "stuck held" across a pause and fires the instant
    // the game resumes.
    fireHeld = false;
    fireButton.classList.remove('active');
    actionStickReset();
    aimStickReset();
  }

  const modeMenu = document.getElementById('mode-menu');
  function showModeMenu() { modeMenu.classList.add('open'); }
  function hideModeMenu() { modeMenu.classList.remove('open'); }

  function pausePress(e) {
    e.preventDefault();
    gameState.paused = true;
    releaseAllHeldInputs();
    showModeMenu();
  }
  const pauseZone = document.getElementById('pause-zone');
  pauseZone.addEventListener('touchstart', pausePress, { passive: false });
  pauseZone.addEventListener('mousedown', pausePress);

  document.getElementById('mode-boss-btn').addEventListener('click', () => startMode('boss'));
  document.getElementById('mode-training-btn').addEventListener('click', () => startMode('training'));
  // Restarts whichever mode is currently selected, from scratch — startMode()
  // already does a full resetModeState() (player/boss/HP/bullets/blade
  // projectiles/barrels/cinematic+milestone flags/DASH state/AUTO AIM/
  // explosions), so restarting is just re-entering the same mode.
  document.getElementById('mode-restart-btn').addEventListener('click', () => startMode(gameState.mode));
  document.getElementById('mode-resume-btn').addEventListener('click', () => {
    gameState.paused = false;
    hideModeMenu();
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

  // MOVE STICK double-tap DASH: pressing a clear direction on the stick
  // twice quickly triggers a DASH that way, on top of the DASH button
  // (kept as a fallback/alternate input, not replaced). Guards against
  // firing during ordinary play: (1) TIME — the two presses must land
  // within MOVE_DASH_DOUBLE_TAP_WINDOW_MS of each other; (2) POSITION/
  // MAGNITUDE — a press near the stick's center never counts (it also
  // resets the streak, so a deliberate re-center doesn't leave a stale
  // half-double-tap waiting to misfire on the next real press); (3)
  // VECTOR SIMILARITY — the two presses' angles must be within
  // MOVE_DASH_ANGLE_TOLERANCE of each other, so pressing e.g. up then
  // right in quick succession is just two separate moves, not a dash.
  const MOVE_DASH_DOUBLE_TAP_WINDOW_MS = 320;
  const MOVE_DASH_MIN_MAGNITUDE_FRAC = 0.55; // fraction of the stick's radius
  const MOVE_DASH_ANGLE_TOLERANCE = 40 * Math.PI / 180;
  let lastMoveTapAt = -Infinity;
  let lastMoveTapAngle = null;

  function angleDelta(a, b) {
    let d = a - b;
    d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return Math.abs(d);
  }

  function tryMoveStickDoubleTapDash(now, dx, dy, maxR) {
    const dist = Math.hypot(dx, dy);
    if (dist < maxR * MOVE_DASH_MIN_MAGNITUDE_FRAC) {
      lastMoveTapAt = -Infinity;
      lastMoveTapAngle = null;
      return;
    }
    const angle = Math.atan2(dy, dx);
    if (
      lastMoveTapAngle !== null &&
      (now - lastMoveTapAt) <= MOVE_DASH_DOUBLE_TAP_WINDOW_MS &&
      angleDelta(angle, lastMoveTapAngle) <= MOVE_DASH_ANGLE_TOLERANCE
    ) {
      // Face the dash's nearest cardinal immediately (for the sprite and
      // for whatever direction the player ends up in afterward); the
      // actual dash travel still uses the full-precision diagonal angle.
      setBaseDir(angleToBucket(angle));
      requestDash(now, angle);
      lastMoveTapAt = -Infinity;
      lastMoveTapAngle = null; // consumed — a 3rd tap starts a fresh pair, not an immediate re-trigger
      return;
    }
    lastMoveTapAt = now;
    lastMoveTapAngle = angle;
  }

  actionStickZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (actionStickTouchId !== null) return;
    const t = e.changedTouches[0];
    actionStickTouchId = t.identifier;
    const rect = actionStickZone.getBoundingClientRect();
    tryMoveStickDoubleTapDash(
      performance.now(),
      t.clientX - (rect.left + rect.width / 2),
      t.clientY - (rect.top + rect.height / 2),
      rect.width / 2
    );
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

  // Colors the AIM STICK's own ±60deg allowed wedge (relative to the
  // player's CURRENT facing) as a translucent sector, so it's visually
  // obvious which angles are actually reachable before even touching the
  // stick. Recomputed only when baseDir changes (see forceSetBaseDir()),
  // not every frame. CSS conic-gradient's 0deg points up and increases
  // clockwise, while BASE_ANGLE's 0 points right and increases clockwise
  // too (atan2 convention) — so a game-angle of G maps to conic-angle
  // G+90; the highlighted arc is exactly the same ±HALF_RANGE band
  // clampToHalfRange() already enforces for real aim input.
  function updateAimSectorOverlay() {
    const gameDeg = BASE_ANGLE[player.baseDir] * 180 / Math.PI;
    const conicCenter = gameDeg + 90;
    const halfDeg = HALF_RANGE * 180 / Math.PI;
    const from = conicCenter - halfDeg;
    aimStickSector.style.background =
      `conic-gradient(from ${from}deg at 50% 50%, rgba(120,190,255,0.4) 0deg ${halfDeg * 2}deg, transparent ${halfDeg * 2}deg 360deg)`;
  }
  updateAimSectorOverlay(); // initial paint for the default baseDir

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
    if (boss.spawned && !bossIsInCinematic()) {
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
      const d = Math.hypot(c.x - player.x, c.y - player.y);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  function performNearestAutoAimSnap(now) {
    const target = getNearestAutoAimCandidate();
    if (!target) return;
    const center = BASE_ANGLE[player.baseDir];
    const angle = Math.atan2(target.y - player.y, target.x - player.x);
    const offset = clampToHalfRange(angle, center);
    player.aimOffsetRaw = offset;
    player.aimOffset = offset;
    aimDoubleTapLockUntil = now + AIM_DOUBLE_TAP_LOCK_MS;
    aimDoubleTapTargetIsBoss = target.isBoss;
    aimDoubleTapTargetPoint = { x: target.x, y: target.y };
    aimStickActive = true;
    const rect = aimStickZone.getBoundingClientRect();
    const maxR = rect.width / 2;
    const finalAngle = center + offset;
    aimStickKnob.style.transform = `translate(${Math.cos(finalAngle) * maxR * 0.7}px, ${Math.sin(finalAngle) * maxR * 0.7}px)`;
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
    // RANGE always hides + resets to default the instant the finger comes
    // off AIM STICK — regardless of whether a double-tap lock below keeps
    // the reticle itself showing.
    hideRangeUI();
    if (performance.now() < aimDoubleTapLockUntil) {
      // A double-tap snap is still locked in — keep the reticle/aim line
      // showing the snapped angle instead of zeroing it on release.
      aimStickActive = true;
      return;
    }
    aimStickActive = false;
    // Releasing the stick always drops the aim back to the base direction's
    // center — an un-aimed shot must never fire along a stale angle.
    player.aimOffsetRaw = 0;
    player.aimOffset = 0;
    aimStickKnob.style.transform = 'translate(0px, 0px)';
  }

  function handleAimStickMove(clientX, clientY) {
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
      // aim offset and just show the knob near center.
      aimStickKnob.style.transform = `translate(${dx * 0.5}px, ${dy * 0.5}px)`;
      return;
    }

    const rawAngle = Math.atan2(dy, dx);
    const center = BASE_ANGLE[player.baseDir];
    player.aimOffsetRaw = clampToHalfRange(rawAngle, center);

    // Knob visually stops at the same ±60 deg wall as the raw input, so
    // the limit is felt physically under the thumb; the reticle (drawn
    // from the AUTO-AIM-adjusted effective offset) is what shows any
    // target snap.
    const clampedAngle = center + player.aimOffsetRaw;
    const clamped = Math.min(dist, maxR);
    const nx = (Math.cos(clampedAngle) * clamped) / maxR;
    const ny = (Math.sin(clampedAngle) * clamped) / maxR;
    aimStickKnob.style.transform = `translate(${nx * maxR * 0.7}px, ${ny * maxR * 0.7}px)`;
  }

  aimStickZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (aimStickTouchId !== null) return;
    const t = e.changedTouches[0];
    aimStickTouchId = t.identifier;
    aimStickActive = true;
    showRangeUI(); // AIM STICK engaged — RANGE becomes visible/operable
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
    aimStickMouseDown = true;
    aimStickActive = true;
    showRangeUI(); // AIM STICK engaged — RANGE becomes visible/operable
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

  // DASH no longer has a standalone button/DOM element at all — it is
  // triggered exclusively by double-tapping a direction on the MOVE
  // (ACTION) STICK itself (see tryMoveStickDoubleTapDash() below).

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
    if (flashCooldownRemainingMs > 0) return; // cooldown active: nothing happens at all, not even feedback
    if (!boss.spawned || flashDisabledByCinematic()) return;
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
    flashCooldownRemainingMs = FLASH_COOLDOWN_MS; // starts the instant a valid throw is accepted — win or miss, see below
    // DARK PHASE head-aim gate (PART 7-9): captured ONCE, right now at
    // throw time (the moment of commitment — GABRIEL keeps moving during
    // the grenade's short flight, so re-checking at detonation would judge
    // a different position than the one the player actually aimed at).
    // Outside DARK PHASE this is always true — FLASH's success has never
    // depended on aim, and still doesn't.
    const darkPhaseHeadHit = boss.state !== 'darkphase' || isAimedAtDarkPhaseHead();
    flashGrenade = { startX: player.x, startY: player.y, endX: boss.x, endY: boss.y, elapsedMs: 0, darkPhaseHeadHit };
  }
  flashZone.addEventListener('touchstart', flashPress, { passive: false });
  flashZone.addEventListener('mousedown', flashPress);

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
        const headHit = flashGrenade.darkPhaseHeadHit;
        flashGrenade = null;
        flashScreenFlashRemainingMs = FLASH_SCREEN_FLASH_MS; // the grenade itself still detonates either way
        if (boss.spawned && !flashDisabledByCinematic()) {
          // PART 7/8: during DARK PHASE, a throw that wasn't aimed at
          // GABRIEL's head (captured at throw time — see flashPress())
          // detonates but does nothing to GABRIEL — no DOWN, no DARK PHASE
          // end. The 10s cooldown above already started regardless, so a
          // missed head-shot is a genuinely wasted use, not a free retry.
          if (!(boss.state === 'darkphase' && !headHit)) {
            startBossFlashDown(now);
          }
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

  // Prevent default touch scroll/zoom anywhere on the game UI
  document.addEventListener('touchmove', (e) => { e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturestart', (e) => { e.preventDefault(); });

  // ---------- Bullets ----------
  const bullets = [];
  const BULLET_SPEED = 620;
  const FIRE_INTERVAL = 170; // ms
  const FIRE_POSE_DURATION = 80; // ms — how long the FIRE sprite shows per shot
  const MUZZLE_DIST = SPRITE_DRAW_H * 0.46; // same muzzle offset used previously
  const AIM_LINE_LEN = 240; // AUTO AIM's reticle-tip search distance — fixed, NOT the player-adjustable RANGE below (keeps existing AUTO AIM target-detection behavior completely unchanged)
  // ---------- RANGE gauge (aim-guide length only — never bullet distance) ----------
  // Purely a "where the dotted aim guide/reticle is drawn" control, kept
  // fully independent of the actual firing angle (AIM STICK) and of
  // AIM_LINE_LEN's internal AUTO AIM target-search math above. spawnBullet()
  // never reads this — bullets always fly their existing full lifetime/
  // stage-bounds distance regardless of what RANGE is set to.
  const AIM_RANGE_DEFAULT = AIM_LINE_LEN; // 240 — matches today's existing guide length
  const AIM_RANGE_MIN = AIM_LINE_LEN * 0.40; // 96 — within the requested ~35-45% band
  const AIM_RANGE_MAX = AIM_LINE_LEN * 1.40; // 336 — within the requested ~130-150% band
  const RANGE_DEFAULT_FRAC = (AIM_RANGE_DEFAULT - AIM_RANGE_MIN) / (AIM_RANGE_MAX - AIM_RANGE_MIN); // 0.6
  let aimRangeLen = AIM_RANGE_DEFAULT;
  let rangeSliderActive = false; // true while the player is actively dragging the RANGE thumb
  let autoAimLockedPoint = null; // {x,y} of whatever AUTO AIM is currently snapped onto, or null — see updateAutoAim()/performNearestAutoAimSnap()

  // Custom touch-driven vertical control (NOT a native <input type=range>
  // relying on the browser's own touch-drag support — that turned out to be
  // unreliable here because of the page-wide touchmove preventDefault()
  // used to block scroll/zoom, which also suppresses a native slider's own
  // default drag gesture). Tracked exactly like the AIM/MOVE sticks (own
  // touch identifier), so it can be operated at the same time as AIM STICK
  // with real multi-touch, and hidden/shown independently — see
  // showRangeUI()/hideRangeUI(), wired into the AIM STICK handlers below.
  const rangeZone = document.getElementById('range-zone');
  const rangeTrack = document.getElementById('range-track');
  const rangeThumb = document.getElementById('range-thumb');
  let rangeTouchId = null;
  let rangeMouseDown = false;

  function applyRangeFrac(frac) {
    const clamped = Math.max(0, Math.min(1, frac));
    aimRangeLen = AIM_RANGE_MIN + clamped * (AIM_RANGE_MAX - AIM_RANGE_MIN);
    rangeThumb.style.bottom = `${clamped * 100}%`;
  }
  applyRangeFrac(RANGE_DEFAULT_FRAC);

  function handleRangeMove(clientY) {
    const rect = rangeTrack.getBoundingClientRect();
    // Physically higher on the track = larger RANGE, matching the visual
    // "fill height" convention of a vertical gauge.
    applyRangeFrac(1 - (clientY - rect.top) / rect.height);
    rangeSliderActive = true;
  }

  function showRangeUI() { rangeZone.classList.add('visible'); }
  // Always both hides AND resets to default — RANGE must never sit at
  // wherever it was last left once the player's finger comes off AIM STICK.
  function hideRangeUI() {
    rangeZone.classList.remove('visible');
    rangeTouchId = null;
    rangeMouseDown = false;
    rangeSliderActive = false;
    applyRangeFrac(RANGE_DEFAULT_FRAC);
  }

  rangeZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (rangeTouchId !== null) return;
    const t = e.changedTouches[0];
    rangeTouchId = t.identifier;
    handleRangeMove(t.clientY);
  }, { passive: false });
  rangeZone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === rangeTouchId) handleRangeMove(t.clientY);
    }
  }, { passive: false });
  function rangeTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === rangeTouchId) { rangeTouchId = null; rangeSliderActive = false; }
    }
  }
  rangeZone.addEventListener('touchend', rangeTouchEnd, { passive: false });
  rangeZone.addEventListener('touchcancel', rangeTouchEnd, { passive: false });
  rangeZone.addEventListener('mousedown', (e) => {
    rangeMouseDown = true;
    handleRangeMove(e.clientY);
  });
  window.addEventListener('mousemove', (e) => { if (rangeMouseDown) handleRangeMove(e.clientY); });
  window.addEventListener('mouseup', () => { if (rangeMouseDown) { rangeMouseDown = false; rangeSliderActive = false; } });
  // The replacement RIGHT/FIRE and LEFT/FIRE sprites each have their muzzle
  // flash at a fixed point on screen (measured directly from each asset),
  // noticeably higher and further out than the generic radial offset above.
  // The sprite doesn't rotate with the fine aim angle inside the +-45 cone,
  // so a fixed screen-space point is the correct match for it, not another
  // radial formula. Scoped to RIGHT+FIRE / LEFT+FIRE only — every other
  // direction/pose still uses the generic MUZZLE_DIST radial offset above,
  // unchanged.
  const RIGHT_FIRE_MUZZLE_DX = SPRITE_DRAW_H * 0.503;
  const RIGHT_FIRE_MUZZLE_DY = SPRITE_DRAW_H * -0.253;
  const LEFT_FIRE_MUZZLE_DX = SPRITE_DRAW_H * -0.506;
  const LEFT_FIRE_MUZZLE_DY = SPRITE_DRAW_H * -0.321;
  let lastFireTime = -Infinity;

  function spawnBullet() {
    const angle = getAimAngle();
    let bx, by;
    if (player.baseDir === 'right') {
      bx = player.x + RIGHT_FIRE_MUZZLE_DX;
      by = player.y + RIGHT_FIRE_MUZZLE_DY;
    } else if (player.baseDir === 'left') {
      bx = player.x + LEFT_FIRE_MUZZLE_DX;
      by = player.y + LEFT_FIRE_MUZZLE_DY;
    } else {
      bx = player.x + Math.cos(angle) * MUZZLE_DIST;
      by = player.y + Math.sin(angle) * MUZZLE_DIST;
    }
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
      ricochetCount: 0, // bumped to 1 on a single left/right-wall bounce — see the wall-ricochet check in update()
    });
    // No canvas muzzle-flash circle — the FIRE sprites already carry their
    // own baked-in flash art; an extra orange dot on top was redundant.
  }

  let playerHitFlashUntil = 0;

  // Exposed for Playwright/manual verification only — not part of gameplay.
  window.__game = {
    player, boss, playerHitCount: 0,
    applyBodyHitToBoss, applyWeakPointHitToBoss, applyExplosionDamageToBoss, bossEnterState,
    getWeakPointScreenPos, clawProjectiles, arcClawSlashes, spawnArcClawSlash,
    gameState, barrels, explosions, bullets, spawnBarrels, startMode,
    get autoAimActive() { return autoAimActive; },
    get autoAimTargetIsBoss() { return autoAimTargetIsBoss; },
    MUZZLE_DIST, AIM_LINE_LEN, AUTO_AIM_RADIUS,
    // Debug/verification only — boss cinematic sequences.
    bossIsInCinematic, checkBossHpMilestones, startBossThreshold, startBossDying,
    BOSS_PHASE_THRESHOLDS, INTRO_TOTAL_MS, THRESHOLD_CINEMATIC_MS, DYING_DURATION_MS,
    DEFENSE_GUARD_BREAK_HITS, BARREL_EXPLOSION_RADIUS, BOSS_HURT_RADIUS,
    // Debug/verification only — stage world/camera/EXIT (PART 21-29).
    STAGES,
    get currentStageIndex() { return currentStageIndex; },
    set currentStageIndex(v) { currentStageIndex = v; }, // debug/verification only
    get cameraY() { return cameraY; },
    get worldExtraAbove() { return worldExtraAbove; },
    worldScrollUnlocked, exitWorldPos, beginStageTransition,
    get stageTransition() { return stageTransition; },
    getAmbientDarkenAlpha,
    requestDash, // debug/verification only — drives the DASH chain directly, bypassing touch-gesture detection
    HALF_RANGE, clampToHalfRange, BASE_ANGLE, keys,
    getCinematicImageInfo, CINEMATIC_SCALE, CINEMATIC_BACK_SCALE, DIR_TO_BOSS_KEY, // debug/verification only
    get barrelRestockPending() { return barrelRestockPending; },
    get barrelRestockRemainingMs() { return barrelRestockRemainingMs; },
    barrelLandings, spawnFallingBarrels, BARREL_FALL_MS, // debug/verification only
    wallSparks, // debug/verification only
    get aimRangeLen() { return aimRangeLen; },
    AIM_RANGE_MIN, AIM_RANGE_MAX, AIM_RANGE_DEFAULT, RANGE_DEFAULT_FRAC,
    showRangeUI, hideRangeUI, // debug/verification only
    get rangeZoneVisible() { return rangeZone.classList.contains('visible'); },
    get autoAimLockedPoint() { return autoAimLockedPoint; },
    get rangeSliderActive() { return rangeSliderActive; },
    set rangeSliderActive(v) { rangeSliderActive = v; }, // debug/verification only
    flashPress, startBossFlashDown, // debug/verification only
    get flashCooldownRemainingMs() { return flashCooldownRemainingMs; },
    set flashCooldownRemainingMs(v) { flashCooldownRemainingMs = v; }, // debug/verification only
    get flashGrenade() { return flashGrenade; },
    get flashScreenFlashRemainingMs() { return flashScreenFlashRemainingMs; },
    FLASH_DOWN_MS, FLASH_COOLDOWN_MS, FLASH_MIN_DISTANCE, FLASH_THROW_MS,
    // Debug/verification only — DARK PHASE.
    startBossDarkPhase, registerGlobalAutoAimHit, getDarkPhaseHeadScreenPos, isAimedAtDarkPhaseHead,
    get darkPhaseOverlayAlpha() { return darkPhaseOverlayAlpha; },
    AUTO_AIM_INVULN_HITS, DARKPHASE_FADE_MS, DARKPHASE_OVERLAY_ALPHA,
    DARKPHASE_ATTACK_RANGE, DARKPHASE_PAUSE_TRIGGER_RANGE, DARKPHASE_HEAD_HIT_RADIUS,
    DARKPHASE_STALK_SPEED, DARKPHASE_CLOSEIN_SPEED, DARKPHASE_LUNGE_SPEED, DARKPHASE_DISENGAGE_SPEED,
    DARKPHASE_STALK_MS_MIN, DARKPHASE_STALK_MS_MAX, DARKPHASE_PAUSE_MS_MIN, DARKPHASE_PAUSE_MS_MAX,
    DARKPHASE_DISENGAGE_MS_MIN, DARKPHASE_DISENGAGE_MS_MAX, DARKPHASE_LUNGE_TIMEOUT_MS,
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
      return;
    }

    const kb = getKeyboardVec();
    let vx = actionStickVec.x + kb.x;
    let vy = actionStickVec.y + kb.y;
    const mag = Math.hypot(vx, vy);
    if (mag > 1) { vx /= mag; vy /= mag; }

    const moving = mag > ACTION_STICK_DEADZONE;
    // The reversed facing from a just-completed 2-dash chain is held for a
    // brief window (FACING_LOCK_MS) even if the stick is still pushed the
    // original way, so the reversal is actually visible — see updateDash().
    if (moving && now >= player.facingLockUntil) {
      const moveAngle = Math.atan2(vy, vx);
      setBaseDir(stickAngleToBucket(moveAngle, player.baseDir));
    }
    player.moving = moving && !player.dashing;

    updateDash(now); // may override player.x for the duration of a DASH
    // Knockback lockout — deliberately short (a few hundred ms, not a full
    // stun), but while it's active MOVE/AIM/FIRE are ALL suppressed, not
    // just movement: a player who gets knocked back must not be able to
    // keep the pressure on by simply re-aiming and firing again the instant
    // the shove itself finishes resolving.
    const knockbackLocked = now < player.knockbackUntil;
    if (!player.dashing && moving && !knockbackLocked) {
      player.x += vx * player.speed * dt;
      player.y += vy * player.speed * dt;
    }

    // Clamp to screen bounds (keep character fully visible)
    clampPlayerToScreen();

    // Camera + EXIT (PART 21-29) — only meaningful once worldScrollUnlocked()
    // (boss fully dead, portrait, BOSS MODE, not already mid-transition).
    // Reaching the exit is never automatic on boss death: the player must
    // physically walk into this zone themselves.
    if (worldScrollUnlocked()) {
      cameraY = Math.max(-worldExtraAbove, Math.min(0, player.y - H * 0.6));
      const exit = exitWorldPos();
      if (Math.abs(player.x - exit.x) < EXIT_ZONE_W / 2 && Math.abs(player.y - exit.y) < EXIT_ZONE_H / 2) {
        beginStageTransition(now);
      }
    } else {
      cameraY = 0;
    }

    // Firing — direction comes from getAimAngle() (AIM STICK offset applied
    // to the current base facing), never from movement. Suppressed entirely
    // during knockbackLocked, same as MOVE/AIM.
    const wantsFire = !knockbackLocked && (fireHeld || keys.fire);
    if (wantsFire && now - lastFireTime >= FIRE_INTERVAL) {
      lastFireTime = now;
      spawnBullet();
    }

    // SOUTH RELAXED IDLE: any input activity resets the idle clock; it only
    // engages after RELAXED_IDLE_DELAY_MS of total silence while facing
    // south, and drops out the instant any input resumes (checked fresh
    // every frame, not just on a timer).
    const inputActive = moving || aimStickActive || wantsFire || player.dashing;
    if (inputActive) player.lastActivityAt = now;
    player.relaxed = player.baseDir === 'down' && !player.dashing &&
      (now - player.lastActivityAt) >= RELAXED_IDLE_DELAY_MS;

    if (!knockbackLocked) updateAutoAim(now); // AIM is locked (frozen, not reset) for the same window as MOVE/FIRE

    // Update bullets — weak point is checked first (only matters while
    // boss.state === 'defense'), body hurtbox otherwise, then alive barrels.
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // LEFT/RIGHT wall ricochet — mirror reflection (vx flips, vy
      // unchanged), exactly once per bullet. Top/bottom never ricochet.
      if (b.ricochetCount < 1 && (b.x <= 0 || b.x >= W)) {
        b.x = b.x <= 0 ? 0 : W;
        b.vx = -b.vx;
        b.ricochetCount = 1;
        spawnWallSpark(b.x, b.y, b.vx, now);
      }
      if (b.x < -20 || b.x > W + 20 || b.y < cameraY - 20 || b.y > cameraY + H + 20) {
        bullets.splice(i, 1);
        continue;
      }
      let consumed = false;
      if (boss.spawned && boss.state !== 'dead') {
        if (boss.state === 'defense') {
          // Genuine physical hitbox overlap only — never inferred from
          // "same direction as the sprite". getWeakPointScreenPos returns
          // null for a direction with no visible eye (NORTH), so a bullet
          // can never register a weak-point hit while defending that way.
          const wp = getWeakPointScreenPos(boss.defenseDir);
          if (wp && Math.hypot(b.x - wp.x, b.y - wp.y) <= WEAKPOINT_HIT_RADIUS) {
            applyWeakPointHitToBoss(now, b.autoAimedBoss, b.x, b.y, b.vx, b.vy);
            consumed = true;
          }
        }
        if (!consumed && Math.hypot(b.x - boss.x, b.y - boss.y) <= BOSS_HURT_RADIUS) {
          applyBodyHitToBoss(now, b.x, b.y, b.vx, b.vy, b.autoAimedBoss, b.ricochetCount > 0);
          consumed = true;
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
      if (consumed) bullets.splice(i, 1);
    }

    updateBarrels(dt, now);
    updateFlashGrenade(dt, now);
    updateBoss(dt, now);
    updateClawProjectiles(dt, now);
    updateArcClawSlashes(now);
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
  // Its length is the RANGE gauge's aimRangeLen — a purely visual "where am
  // I precisely aiming" control, never bullet travel distance (bullets
  // always fly their own full lifetime regardless — see spawnBullet()).
  // While AUTO AIM is genuinely locked onto something (and the player isn't
  // actively dragging the RANGE slider right now), the guide instead snaps
  // to that target's real distance so the reticle visibly sits on it.
  function drawAimLine() {
    if (!aimStickActive) return;
    const angle = getAimAngle();
    const bx = player.x + Math.cos(angle) * MUZZLE_DIST;
    const by = player.y + Math.sin(angle) * MUZZLE_DIST;
    let guideLen = aimRangeLen;
    if (autoAimActive && autoAimLockedPoint && !rangeSliderActive) {
      guideLen = Math.hypot(autoAimLockedPoint.x - bx, autoAimLockedPoint.y - by);
    }
    const ex = bx + Math.cos(angle) * guideLen;
    const ey = by + Math.sin(angle) * guideLen;

    ctx.save();
    ctx.strokeStyle = autoAimActive ? 'rgba(255,90,80,0.6)' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    drawReticle(ex, ey, autoAimActive);
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
    const stageOn = stage.ready && H >= W;
    ctx.save();
    ctx.translate(0, -cameraY);

    if (stageOn) {
      // Portrait viewport: draw the stage floor image "cover"-style —
      // uniformly scaled (never stretched on one axis only) so it fills the
      // screen, center-cropping only the minimum needed on one axis. Tiled
      // vertically (same real pixels, no distortion) to also cover the
      // extra world space above the original screen once unlocked — this
      // is what gives the world its extra vertical extent post-victory.
      const iw = stage.img.naturalWidth, ih = stage.img.naturalHeight;
      const scale = Math.max(W / iw, H / ih);
      const dw = iw * scale, dh = ih * scale;
      const dx = (W - dw) / 2;
      const baseDy = (H - dh) / 2;
      const topLimit = -worldExtraAbove - dh;
      for (let y = baseDy; y > topLimit; y -= dh) {
        ctx.drawImage(stage.img, dx, y, dw, dh);
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
    for (let i = barrelLandings.length - 1; i >= 0; i--) {
      const l = barrelLandings[i];
      if (now - l.startAt >= BARREL_LANDING_MS) { barrelLandings.splice(i, 1); continue; }
      drawBarrelLanding(l, now);
    }
    for (const e of explosions) drawExplosion(e, now);

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

    // Claw projectiles draw alongside the player's own bullets.
    for (const p of clawProjectiles) drawClawProjectile(p);
    for (const s of arcClawSlashes) drawArcClawSlash(s);

    // Player and boss are painter-sorted by Y so whichever is visually
    // "closer" (further down the screen) draws on top of the other.
    if (boss.spawned && boss.y < player.y) {
      drawBoss(now);
      drawPlayer(now);
    } else {
      drawPlayer(now);
      if (boss.spawned) drawBoss(now);
    }

    // PART 1: the aim line/reticle draw last among game-world content —
    // strictly above the background, barrels, bullets, claw projectiles,
    // player, and boss — so the boss's sprite (or anything else) can never
    // paint over the dashed line or hide the reticle. It stays below the
    // DOM control UI (ACTION/AIM/FIRE/DASH/PAUSE), which is a separate
    // layer entirely and always on top regardless of canvas draw order.
    drawAimLine();

    drawBossHud(now);
    drawBossFeedback(now);
    drawExitZone(now); // no-op until worldScrollUnlocked() (boss fully dead)

    ctx.restore(); // undo the camera translate — everything below is screen-space

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

    // BOSS MODE intro: 3 short, well-separated screen flashes within the
    // first INTRO_FLASH_MS (~700ms total) — a brief pale pulse each, never
    // a rapid/strobing flicker. Drawn as a full-screen overlay here (not
    // inside drawBoss()) since it isn't tied to the boss's own position.
    if (boss.state === 'intro' && boss.cinematicElapsed < INTRO_FLASH_MS) {
      const windows = [[0, 120], [220, 320], [420, 520]];
      for (const [s, e] of windows) {
        if (boss.cinematicElapsed >= s && boss.cinematicElapsed < e) {
          const t = (boss.cinematicElapsed - s) / (e - s);
          const alpha = Math.sin(t * Math.PI) * 0.55;
          ctx.fillStyle = `rgba(235,240,245,${alpha})`;
          ctx.fillRect(0, 0, W, H);
          break;
        }
      }
    }

    // Stage transition fade (PART 26) — a short, simple fade, never a
    // long loading-style sequence; screen-space, on top of everything.
    const stageFadeAlpha = getStageTransitionOverlayAlpha(now);
    if (stageFadeAlpha > 0) {
      ctx.fillStyle = `rgba(6, 8, 10, ${stageFadeAlpha})`;
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

    ctx.restore(); // matches the shake-translate ctx.save() at the top of this function

    // Expired explosion effects are pruned here rather than in update(),
    // purely so a paused game still shows a mid-explosion frame frozen
    // instead of having it vanish while update() isn't running.
    for (let i = explosions.length - 1; i >= 0; i--) {
      if (now - explosions[i].startAt > EXPLOSION_DURATION_MS) explosions.splice(i, 1);
    }
  }

  function drawPlayer(now) {
    let img;
    if (player.dashing) {
      // All 4 cardinal directions have dedicated dash art now.
      img = dashSprites[player.dashDir];
    } else if (player.moving) {
      // Display-only change: ordinary MOVE STICK movement (not a DASH burst)
      // now also shows the direction-matched DASH artwork as its walking
      // pose, instead of the static AIM-pose sprite it used to reuse. Pure
      // rendering — speed/distance/invulnerability/the double-tap DASH
      // trigger itself are all untouched (see updateDash()/player.dashing
      // above, which still takes priority when a real DASH is in progress).
      img = dashSprites[player.baseDir];
    } else if (player.baseDir === 'down' && player.relaxed) {
      img = relaxedSprite.down;
    } else {
      const pose = currentPose(now);
      img = sprites[pose] && sprites[pose][player.baseDir];
    }
    if (img && img.complete && img.naturalWidth > 0) {
      spriteAspect = img.naturalWidth / img.naturalHeight;
      const drawH = SPRITE_DRAW_H;
      const drawW = drawH * spriteAspect;
      ctx.drawImage(img, player.x - drawW / 2, player.y - drawH / 2, drawW, drawH);
    } else {
      // fallback placeholder while sprites load
      ctx.fillStyle = '#888';
      ctx.fillRect(player.x - 20, player.y - 40, 40, 80);
    }
  }

  // ---------- Boss rendering ----------
  function bossFrameName(now) {
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
      // 3-frame cycle (added this batch) — same WALK_FRAME_PERIOD_MS per
      // frame as before, just one more step in the loop rather than a
      // faster flicker, so the walk cadence itself is unchanged.
      const frame = Math.floor(now / WALK_FRAME_PERIOD_MS) % 3;
      if (frame === 0) return 'walk_south_1';
      if (frame === 1) return 'walk_south_2';
      return 'walk_south_3';
    }
    if (key === 'east') return boss.moving ? 'walk_east' : 'east_idle';
    if (key === 'west') return boss.moving ? 'walk_west' : 'west_idle';
    // NORTH has no dedicated walk art — reuse the back-facing idle frame
    // per spec (no new pose may be generated); a tiny vertical bounce
    // stands in for a walk cycle, canvas-side only.
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
    else if (name === 'north_idle') scale = NORTH_IDLE_SCALE;
    else if (name === 'attack_north') scale = NORTH_ATTACK_SCALE;
    else if (name === 'attack_south_release') scale = SOUTH_ATTACK_SCALE;
    if (img && img.complete && img.naturalWidth > 0) {
      const w = BOSS_DRAW_W * scale, h = BOSS_DRAW_H * scale;
      const bottomY = boss.y + BOSS_DRAW_H / 2 + bounce;
      const dx = boss.x - w / 2, dy = bottomY - h;
      if (now < bossHitTintUntil) {
        drawBossWithHitTint(img, dx, dy, w, h, (bossHitTintUntil - now) / BOSS_HIT_TINT_MS);
      } else {
        ctx.drawImage(img, dx, dy, w, h);
      }
    }
  }

  // Brief red hit-tint (see BOSS_HIT_TINT_MS/bossHitTintUntil above) — tints
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

  // All timing here reads boss.cinematicElapsed (cached by updateBossIntro()
  // during update(), which PAUSE already skips) rather than recomputing
  // from `now`, which keeps advancing every frame regardless of PAUSE.
  function drawBossIntro(now) {
    const elapsed = boss.cinematicElapsed;
    const shadowStart = INTRO_FLASH_MS;
    const descendStart = INTRO_FLASH_MS + INTRO_SHADOW_MS;
    const landStart = descendStart + INTRO_DESCEND_MS;

    // Growing ground shadow — appears once the flash ends, deepens through
    // the shadow + descend phases, then holds at full size through landing.
    if (elapsed >= shadowStart) {
      const shadowT = Math.min(1, (elapsed - shadowStart) / (INTRO_SHADOW_MS + INTRO_DESCEND_MS));
      const rx = BOSS_DRAW_W * (0.22 + shadowT * 0.30);
      const ry = rx * 0.30;
      const alpha = 0.18 + shadowT * 0.42;
      ctx.save();
      ctx.translate(W / 2, boss.introTargetY + BOSS_DRAW_H * 0.42);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      grad.addColorStop(0, `rgba(5,5,5,${alpha})`);
      grad.addColorStop(1, 'rgba(5,5,5,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // The CINEMATIC POSE itself only appears once it starts descending.
    const introCin = getCinematicImageInfo();
    if (elapsed >= descendStart && introCin.img.complete && introCin.img.naturalWidth > 0) {
      ctx.drawImage(
        introCin.img,
        boss.x - introCin.w / 2 + introCin.offX,
        boss.y - introCin.h / 2 + introCin.offY,
        introCin.w, introCin.h
      );
    }

    // Landing impact: a brief pale flash at the ground, fading out.
    if (elapsed >= landStart && elapsed < landStart + INTRO_LANDING_MS) {
      const ft = (elapsed - landStart) / INTRO_LANDING_MS;
      ctx.save();
      ctx.globalAlpha = 1 - ft;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.arc(boss.x, boss.introTargetY + BOSS_DRAW_H * 0.3, BOSS_DRAW_W * (0.3 + ft * 0.3), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
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

  // DARK PHASE: GABRIEL's body is intentionally never drawn here — no
  // silhouette, no outline of any color, nothing that could read as a
  // white/gray halo. Only the extracted eye-glow image (see
  // assets/boss/dark_phase_eyes_build_meta.json — cropped straight out of
  // the previously-attached DARK PHASE render, not a Canvas-drawn design),
  // positioned via getDarkPhaseHeadScreenPos()'s same scale/anchor so it
  // always sits exactly on top of boss.x/boss.y as the STALK/CLOSE IN/
  // PAUSE/LUNGE/DISENGAGE AI actually moves them (see updateBossDarkPhase()
  // and its per-substate helpers) — a real glowing point creeping through
  // the dark, not a static effect. During the brief PAUSE telegraph beat
  // right before LUNGE, the SAME image is drawn through a temporary
  // brightness filter — a pixel-value rescale, never a new shape or an
  // added light source. The screen-darken overlay itself is drawn
  // separately, UNDER the player/bullets/this eye (see draw()), so it can
  // go near-total-black without also hiding anything that must stay
  // visible — see darkPhaseOverlayAlpha/updateDarkPhaseOverlay().
  function drawBossDarkPhase(now) {
    if (!(darkPhaseEyesImg.complete && darkPhaseEyesImg.naturalWidth > 0)) return;
    const anchor = getDarkPhaseHeadScreenPos();
    const drawX = anchor.x - DARKPHASE_EYES_DISPLAY_W / 2;
    const drawY = anchor.y - DARKPHASE_EYES_DISPLAY_H / 2;
    ctx.save();
    if (boss.darkPhaseSubState === 'pause') ctx.filter = 'brightness(1.45)';
    ctx.drawImage(darkPhaseEyesImg, drawX, drawY, DARKPHASE_EYES_DISPLAY_W, DARKPHASE_EYES_DISPLAY_H);
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
    let sumX = 0, sumY = 0;
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const px = Math.min(off.width - 1, gx * DYING_CELL_SIZE + (DYING_CELL_SIZE >> 1));
        const py = Math.min(off.height - 1, gy * DYING_CELL_SIZE + (DYING_CELL_SIZE >> 1));
        let a = 0, r = 60, g = 60, b = 66;
        if (data) {
          const idx = (py * off.width + px) * 4;
          a = data[idx + 3];
          if (a > 40) { r = data[idx]; g = data[idx + 1]; b = data[idx + 2]; }
        } else {
          a = 255; // getImageData unavailable — fall back to a solid silhouette-less block field
        }
        if (a <= 40) continue; // transparent background cell — not part of the character
        cells.push({ gx, gy, r, g, b });
        sumX += gx; sumY += gy;
      }
    }
    const cx = cells.length ? sumX / cells.length : cols / 2;
    const cy = cells.length ? sumY / cells.length : rows / 2;
    let maxDist = 1;
    for (const c of cells) maxDist = Math.max(maxDist, Math.hypot(c.gx - cx, c.gy - cy));

    const particles = cells.map((c) => {
      const distFrac = Math.hypot(c.gx - cx, c.gy - cy) / maxDist; // 0 center -> 1 edge
      const dissolveAt = Math.max(0, Math.min(0.85, (1 - distFrac) * 0.55 + Math.random() * 0.25));
      // Mostly upward/outward-ish drift (sand/ash caught in a rising
      // draft), with plenty of per-grain sideways scatter rather than a
      // strict radial-from-center burst.
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      return {
        gx: c.gx, gy: c.gy,
        color: `rgba(${c.r},${c.g},${c.b},`,
        dissolveAt,
        angle,
        speed: 14 + Math.random() * 34,
        spin: (Math.random() - 0.5) * 4,
        grain: 0.55 + Math.random() * 1.1, // fine sand-grain radius, px — independent of the sampling cell size
      };
    });
    boss.dyingParticles = particles;
    boss.dyingParticlesBuilt = true;
  }

  // Real particle dissolve, not a plain opacity fade: the intact sprite is
  // drawn first, then every already-dissolved cell is punched out of it
  // (destination-out) and redrawn as a separate fragment drifting outward/
  // upward and fading — so the body visibly comes apart in pieces over
  // DYING_DURATION_MS instead of just fading transparent in place.
  function drawBossDying(now) {
    if (!boss.dyingParticlesBuilt) buildDyingParticles();
    const dyingDrawCin = getCinematicImageInfo(); // same boss.downFacing as buildDyingParticles() used — stable for the whole sequence
    const frac = Math.min(1, boss.cinematicElapsed / DYING_DURATION_MS);
    const drawX = boss.x - dyingDrawCin.w / 2 + dyingDrawCin.offX;
    const drawY = boss.y - dyingDrawCin.h / 2 + dyingDrawCin.offY;

    ctx.save();
    ctx.globalAlpha = frac > 0.85 ? Math.max(0, (1 - frac) / 0.15) : 1;
    if (dyingDrawCin.img.complete && dyingDrawCin.img.naturalWidth > 0) {
      ctx.drawImage(dyingDrawCin.img, drawX, drawY, dyingDrawCin.w, dyingDrawCin.h);
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    for (const p of boss.dyingParticles) {
      if (frac < p.dissolveAt) continue;
      ctx.fillRect(drawX + p.gx * DYING_CELL_SIZE, drawY + p.gy * DYING_CELL_SIZE, DYING_CELL_SIZE + 1, DYING_CELL_SIZE + 1);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    // Fine sand/ash grains, not squares — each one a tiny circle drifting
    // gently up and sideways, shrinking slightly as it fades. Deliberately
    // NOT a plain opacity fade in place: position genuinely drifts (dx/dy
    // below) and the underlying sprite is actually punched out (above) as
    // each grain releases.
    for (const p of boss.dyingParticles) {
      if (frac < p.dissolveAt) continue;
      const localT = Math.min(1, (frac - p.dissolveAt) / Math.max(0.05, 1 - p.dissolveAt));
      const driftSec = (frac - p.dissolveAt) * (DYING_DURATION_MS / 1000);
      const dx = Math.cos(p.angle) * p.speed * driftSec;
      const dy = Math.sin(p.angle) * p.speed * driftSec - driftSec * 22; // gentle upward drift, not a violent ejection
      const alpha = Math.max(0, 1 - localT);
      const px = drawX + p.gx * DYING_CELL_SIZE + DYING_CELL_SIZE / 2 + dx;
      const py = drawY + p.gy * DYING_CELL_SIZE + DYING_CELL_SIZE / 2 + dy;
      const r = p.grain * (1 - localT * 0.5);
      if (r <= 0.05) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color + '1)';
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawBossHud(now) {
    if (!boss.spawned) return;
    // No HP gauge on screen (removed per spec) — HP/damage/kill logic is
    // all still tracked internally, just not displayed. The WARNING banner
    // is a spawn cue, not a gauge, so it stays.
    const barY = Math.max(10, (H * 0.03));

    if (now < boss.warningUntil) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(255,60,60,${0.55 + 0.45 * Math.abs(Math.sin(now / 150))})`;
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText('WARNING', W / 2, barY + 44);
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(`${boss.name} DETECTED`, W / 2, barY + 64);
      ctx.restore();
    }
  }

  // Small, non-intrusive combat feedback: a metallic spark + ricochet on a
  // blocked hit during DEFENSE (see spawnDefenseRicochet()/
  // drawDefenseRicochets()), and a brighter flash + "WEAK" label at the
  // exact impact point when a genuine damaging hit lands (weak point, or
  // the AUTO-AIM-assisted body-target fallback for a direction with none).
  function drawBossFeedback(now) {
    if (!boss.spawned) return;
    if (now < weakPointFlashUntil) {
      ctx.save();
      ctx.fillStyle = `rgba(255,90,60,${0.5 + 0.5 * Math.abs(Math.sin(now / 35))})`;
      ctx.beginPath();
      ctx.arc(weakPointFlashAt.x, weakPointFlashAt.y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
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
    drawWallSparks(now);
  }

  function loop(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    update(dt, now);
    draw(now);
    requestAnimationFrame(loop);
  }

  spawnBarrels(2 + Math.floor(Math.random() * 3)); // initial BOSS MODE barrels (2-4)
  requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });
})();
