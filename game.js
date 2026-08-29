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
  let area2Activated = false;
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
    // SOUTH is a 2-frame cycle now (see south_walk3_build_meta.json) — the
    // old walk_south_3.png file is left on disk but no longer loaded here.
    walk_south_1: 'walk_south_1', walk_south_2: 'walk_south_2',
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
  const STRAIGHT_CLAW_TRIGGER_GUARDS = 5; // 5th consecutive guarded shot triggers it (1-4 do not)
  const STRAIGHT_CLAW_WINDUP_MS = 2000; // straight_claw_windup.png shown; no damage/hit/knockback can occur yet
  const STRAIGHT_CLAW_ATTACK_MS = 400; // straight_claw_release.png shown; the actual straight-line hit travels during this window
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
  const COUNTER_STING_SCALE = 0.90; // real-device feedback: straight_claw_windup/release read too large — 10% smaller, applied to BOTH so windup->release still shows no size jump
  const COUNTER_ARC_CLAW_LIFETIME_MS = ARC_CLAW_LIFETIME_MS / 2; // "2x speed" = half the normal travel time along the SAME bezier geometry — see the 'counterArc' kind in updateArcClawSlashes()
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

  // SECTION C: the walkable world now opens up in TWO stages instead of
  // one — AREA 1 only (pixel-identical to the original single-screen
  // clamp) until area1Cleared, then AREA 2's own full band once it is
  // (C-14/C-15 — the invisible north boundary between the two areas), and
  // finally the small post-clear EXIT-hunting bonus space beyond AREA 2
  // once area2Cleared too (worldScrollUnlocked(), unchanged in spirit from
  // before this batch, just re-gated on the new final win condition).
  function clampPlayerToScreen() {
    const halfW = (SPRITE_DRAW_H * spriteAspect) / 2;
    const halfH = SPRITE_DRAW_H / 2;
    let topY = halfH; // AREA 1 only — identical to the original pre-stage-system clamp
    if (worldScrollUnlocked()) {
      topY = -H - worldExtraAbove + halfH;
    } else if (area1Cleared) {
      topY = -H + halfH;
    }
    player.x = Math.max(halfW, Math.min(W - halfW, player.x));
    player.y = Math.max(topY, Math.min(H - halfH, player.y));
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
  const BOSS_SPEED = 78; // px/sec — 60% of the previous 130 (was too fast to react to). Kept as-is: DARK PHASE's STALK/CLOSE-IN/LUNGE/DISENGAGE speeds below are all derived from this and must not drift.
  // PART 29/30: normal CHASE-state movement only, ×0.90 — a separate
  // constant (not a mutation of BOSS_SPEED itself) so DARK PHASE's own
  // speeds above stay completely untouched. Player MOVE speed is now 192
  // (240×0.80) vs this 70.2, still comfortably faster than GABRIEL.
  const BOSS_CHASE_SPEED = BOSS_SPEED * 0.90;
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
  const WALK_FRAME_PERIOD_MS = 260; // NORTH (3-frame wrap) / EAST / WEST (2-frame alternation) walk-cycle period
  // SOUTH alone gets its own, slower period — it now has only 2 walk
  // frames (see BOSS_FRAME_FILES/south_walk3_build_meta.json). Alternating
  // just 2 static-photo poses reads as a binary on/off flicker rather than
  // a walk with no 3rd frame to smooth the transition, and real-device
  // testing confirmed 1.5x was still too fast to read as walking rather
  // than shimmying — raised further to 2.3x (~600ms/frame).
  const SOUTH_WALK_FRAME_PERIOD_MS = WALK_FRAME_PERIOD_MS * 2.3;
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
  const BOSS_INTRO_LANDING_SHAKE_MS = 700;
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
  const BOSS_INTRO_LANDING_SHAKE_MAG = 16;
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
  // Death (PART 37-42): DOWN pose held briefly -> gradually blackens ->
  // the now-black body crumbles into fine dark sand/ash that falls
  // downward (gravity, not an upward burst) — see buildDyingParticles()/
  // drawBossDying(). Each phase is its own named constant; DYING_DURATION_MS
  // is still the one value everything else (updateBossDying()'s exit
  // check, window.__game's exposed constant) treats as "how long the whole
  // 'dying' state lasts", just derived from the phases below now instead of
  // a single flat number.
  const BOSS_DEFEAT_DOWN_PAUSE_MS = 500;
  const BOSS_DEFEAT_BLACKEN_MS = 700;
  const BOSS_DEFEAT_DISINTEGRATE_MS = 1600;
  const BOSS_DEFEAT_BLACKEN_START = BOSS_DEFEAT_DOWN_PAUSE_MS;
  const BOSS_DEFEAT_BLACKEN_END = BOSS_DEFEAT_BLACKEN_START + BOSS_DEFEAT_BLACKEN_MS;
  const DYING_DURATION_MS = BOSS_DEFEAT_BLACKEN_END + BOSS_DEFEAT_DISINTEGRATE_MS;
  // Fine dark grains fall under a gentle constant acceleration rather than
  // drifting at a fixed speed — reads as real gravity, not a slow float.
  const DEFEAT_PARTICLE_GRAVITY = 260; // px/sec^2
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
    darkPhaseArcAttackKind: 'slash', // 'slash' | 'sting' — which claw attack DARK PHASE's own 'arcclaw' sub-state fires, chosen fresh each time LUNGE ends
    chaseBackoffUntil: 0,
    deadAt: 0,
    warningUntil: 0,
    defenseAimHits: 0, // valid AUTO-AIM-assisted hits landed during the current DEFENSE
    weakPointConsecutiveHits: 0, // ANY valid weak-point damage hit (auto-aimed or manual) landed during the current DEFENSE
    consecutiveGuardedShots: 0, // shots successfully BLOCKED (0 damage) during the current DEFENSE — see applyBodyHitToBoss(); resets to 0 on any non-'defense' state transition, same lifecycle as the two counters above
    straightClawHitSpawned: false, // guards the single spawnStraightClaw()/spawnCounterArcClaw() call per 'straightclaw' state — see bossEnterState()/updateBossStraightClaw()
    counterDir: 'south', // 'south'|'north'|'east'|'west' — captured ONCE at COUNTER ATTACK trigger time from the player's position relative to GABRIEL; picks STING (south) vs COUNTER ARC CLAW (north/east/west) — see applyBodyHitToBoss()/bossFrameName()/updateBossStraightClaw()
    autoAimHitStreak: 0, // ANY valid AUTO-AIM-assisted damage hit, body or weak point, regardless of state — see registerGlobalAutoAimHit()
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

    // BOSS MODE only ever shows this — TRAINING MODE never calls
    // spawnBoss() at all, so it never plays.
    bossEnterState('intro', now);
  }

  function bossIsInCinematic() {
    return boss.state === 'intro' || boss.state === 'threshold' || boss.state === 'dying' || boss.state === 'dead';
  }

  // PART 8: scoped to the boss INTRO sequence specifically (not threshold/
  // dying/dead, which have always left the player free to move) — MOVE/AIM/
  // FIRE/DASH/FLASH/STEALTH are all suppressed for the whole cinematic, so
  // the player stays exactly where PART 1 places them, facing north, until
  // battle actually begins.
  function isBossIntroLocked() {
    return boss.spawned && boss.state === 'intro';
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
  function startBossDarkPhase(now) {
    arcClawSlashes.length = 0; // no lingering attacks from before DARK PHASE began
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
  //               DARKPHASE_ATTACK_RANGE, which is when SLASH or STING
  //               actually fires (picked fresh each time, see
  //               boss.darkPhaseArcAttackKind) — so the attack always fires
  //               from genuinely close range, by construction
  //   arcclaw  -> hold position for the chosen attack's own lifetime (SLASH:
  //               ARC_CLAW_LIFETIME_MS, STING: CLAW_STING_LIFETIME_MS — the
  //               existing attack fully owns its own hit timing either way,
  //               see updateArcClawSlashes())
  //   disengage-> pull back at an angle (not a straight retreat) for a
  //               randomized duration, then loop back to STALK
  // No DEFENSE, no melee, no 3WAY BLADE (removed entirely, PART 9) — ARC
  // CLAW SLASH and CLAW STING are the only attacks this loop ever calls,
  // forever, until FLASH GRENADE ends DARK PHASE (see startBossFlashDown()
  // below).
  function updateBossDarkPhaseStalk(dt, now) {
    // STEALTH (PART 19): DARK PHASE's own AI is no exception — every
    // sub-state here reads GABRIEL's current belief, not necessarily the
    // player's live position, while STEALTH is active.
    const targetPos = getBossTargetPos(now);
    const dx = targetPos.x - boss.x, dy = targetPos.y - boss.y;
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
    const targetPos = getBossTargetPos(now);
    const dx = targetPos.x - boss.x, dy = targetPos.y - boss.y;
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
    const targetPos = getBossTargetPos(now);
    const dx = targetPos.x - boss.x, dy = targetPos.y - boss.y;
    const dist = Math.hypot(dx, dy) || 1;
    boss.x += (dx / dist) * DARKPHASE_LUNGE_SPEED * dt;
    boss.y += (dy / dist) * DARKPHASE_LUNGE_SPEED * dt;
    boss.moving = true;
    if (dist <= DARKPHASE_ATTACK_RANGE) {
      // Only ever reached here, genuinely close — see the range check
      // above — so neither SLASH nor STING can ever fire from far away.
      // DARK PHASE's attack set is SLASH + STING only (PART 8/11) — picked
      // fresh each time LUNGE ends, so it's never the same twice running.
      boss.dir = angleToBucket(Math.atan2(dy, dx));
      boss.darkPhaseSubState = 'arcclaw';
      boss.darkPhaseAttackTimer = 0;
      boss.moving = false;
      boss.darkPhaseArcAttackKind = Math.random() < 0.5 ? 'slash' : 'sting';
      if (boss.darkPhaseArcAttackKind === 'sting') {
        spawnClawSting(now, getClawOrigin(), getBossTargetPos(now));
      } else {
        spawnArcClawSlash(now);
      }
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
    const lifetime = boss.darkPhaseArcAttackKind === 'sting' ? CLAW_STING_LIFETIME_MS : ARC_CLAW_LIFETIME_MS;
    if (boss.darkPhaseAttackTimer >= lifetime) {
      boss.darkPhaseAttackTimer = 0;
      boss.darkPhaseSign = Math.random() < 0.5 ? 1 : -1; // re-rolled for the upcoming DISENGAGE angle
      boss.darkPhaseDisengageMs = DARKPHASE_DISENGAGE_MS_MIN + Math.random() * (DARKPHASE_DISENGAGE_MS_MAX - DARKPHASE_DISENGAGE_MS_MIN);
      boss.darkPhaseSubState = 'disengage';
    }
  }

  function updateBossDarkPhaseDisengage(dt, now) {
    const targetPos = getBossTargetPos(now);
    const dx = targetPos.x - boss.x, dy = targetPos.y - boss.y;
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
      boss.defenseDir = incomingFrom;
      if (autoAimed) {
        boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
        if (checkBossHpMilestones(now)) return; // death or a threshold cinematic took over
        bossDamageBlinkStartAt = now; // "valid hit" feedback — same as a real weak-point hit, not a ricochet
        if (autoAimed) { registerDefenseAimHit(now); registerGlobalAutoAimHit(now); }
        return;
      }
      spawnDefenseRicochet(now, bulletX, bulletY, bulletVx, bulletVy);
      // STRAIGHT CLAW counter (A-2/A-3): counts CONSECUTIVE genuinely-blocked
      // shots (0 damage) during DEFENSE — a real-damage hit anywhere below
      // resets this to 0 via bossEnterState()'s own state !== 'defense'
      // guard the instant DEFENSE ends for any other reason, so the same 5
      // blocks can never be reused across separate DEFENSE windows.
      boss.consecutiveGuardedShots += 1;
      if (boss.consecutiveGuardedShots >= STRAIGHT_CLAW_TRIGGER_GUARDS) {
        // COUNTER ATTACK direction split (SECTION 2/3/4): captured ONCE,
        // right now, from the player's position relative to GABRIEL at the
        // exact instant the counter triggers — never re-evaluated later, so
        // a player who repositions during the windup doesn't change which
        // variant plays. 'down'/'up'/'left'/'right' -> DIR_TO_BOSS_KEY's own
        // south/north/west/east naming, same mapping used everywhere else.
        boss.counterDir = DIR_TO_BOSS_KEY[angleToBucket(Math.atan2(player.y - boss.y, player.x - boss.x))];
        bossEnterState('straightclaw', now); // takes priority over normal AI/DEFENSE's own exit timing
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
    const attackWindowMs = isSouth ? STRAIGHT_CLAW_ATTACK_MS : COUNTER_ARC_CLAW_LIFETIME_MS;
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
    if (boss.state === 'teleport') { updateBossTeleport(dt, now); return; }
    if (boss.state === 'straightclaw') { updateBossStraightClaw(now); return; }
    if (window.__game.freezeBossAI) return; // debug/verification only



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
        vx = dirX * BOSS_CHASE_SPEED;
        vy = dirY * BOSS_CHASE_SPEED;
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

    // SECTION C: clamp relative to the CURRENT area's own screen-sized band
    // (areaTopY(currentArea) .. +H), not always the original [0,H] — without
    // this, an AREA 2 boss (whose Y sits around -H+something) would get
    // pulled straight back down into AREA 1's band by this same clamp every
    // single frame during CHASE movement.
    const areaTop = areaTopY(currentArea);
    boss.x = Math.max(BOSS_DRAW_W * 0.3, Math.min(W - BOSS_DRAW_W * 0.3, boss.x));
    boss.y = Math.max(areaTop + BOSS_DRAW_H * 0.3, Math.min(areaTop + H - BOSS_DRAW_H * 0.3, boss.y));
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
    }
    if (elapsed >= INTRO_TOTAL_MS) {
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
    arcClawSlashes.push({
      kind: 'straightClaw',
      p0: origin, p2: { x: endX, y: endY },
      startedAt: now, hasHit: false,
      x: origin.x, y: origin.y, angle: 0, tangentAngle: angle, trail: [],
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
      const lifetimeMs = isSting ? CLAW_STING_LIFETIME_MS : (isStraightClaw ? STRAIGHT_CLAW_ATTACK_MS : (isCounterArc ? COUNTER_ARC_CLAW_LIFETIME_MS : ARC_CLAW_LIFETIME_MS));
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

      if (!s.hasHit && !isPlayerInvulnerable()) {
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
          playerHitFlashUntil = now + 150;
          // SECTION 6/7: this is the ONLY place either COUNTER variant ever
          // "damages" the player — purely a genuine hitbox-overlap check
          // above (never an automatic hit on COUNTER start/trigger). No
          // LIFE/HP stat exists yet to actually subtract from, so this is
          // just recorded as a future-system placeholder.
          if (isStraightClaw || isCounterArc) {
            player.lastCounterDamage = COUNTER_ATTACK_DAMAGE;
          }
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
    // STRAIGHT CLAW's attack is communicated entirely through GABRIEL's own
    // windup/release body sprite (see bossFrameName()) — this shared
    // slash/sting claw-image VFX is never drawn for it, only its hitbox
    // (updateArcClawSlashes() above) is tracked here.
    if (s.kind === 'straightClaw') return;
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
  // SECTION C: the old single-boss-death win condition is now "both AREA 1
  // AND AREA 2 have been cleared" — area2Cleared already implies area1
  // Cleared (AREA 2 can't even be reached otherwise), so checking it alone
  // is sufficient. Everything downstream (the EXIT zone, the fade-to-next-
  // stage transition) is otherwise completely unchanged from before.
  function worldScrollUnlocked() {
    // SECTION 15-18: no longer restricted to portrait (H >= W) — see the
    // matching note above the currentArea/area1Cleared block in update().
    return gameState.mode === 'boss' && area2Cleared && !stageTransition.active;
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
  function updateStageTransition(now) {
    if (!stageTransition.active) return;
    const elapsed = now - stageTransition.startedAt;
    if (stageTransition.phase === 'out') {
      if (elapsed < STAGE_FADE_MS) return;
      currentStageIndex = pickRandomOtherStage(currentStageIndex);
      cameraY = 0;
      // SECTION C: the next stage always starts back at AREA 1, fully
      // closed up again — same two-area structure repeats fresh each time.
      currentArea = 1;
      area1Cleared = false;
      area2Activated = false;
      area2Cleared = false;
      resetPlayerPosition();
      player.baseDir = 'down';
      player.aimOffsetRaw = 0; player.aimOffset = 0;
      bullets.length = 0; arcClawSlashes.length = 0; explosions.length = 0;
      barrels.length = 0;
      barrelLandings.length = 0;
      spawnBarrels(2 + Math.floor(Math.random() * 3));
      spawnBoss(now); // fresh full-HP boss; plays the existing shake/silence/shadow/landing/south-idle/south-attack intro
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
    // nothing for AUTO AIM to snap onto until it reappears.
    if (boss.spawned && (bossIsInCinematic() || boss.state === 'teleport' || boss.state === 'straightclaw')) return { primary: null, secondary: null };
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
  function resetModeState() {
    resetPlayerPosition();
    player.baseDir = 'down';
    player.aimOffsetRaw = 0;
    player.aimOffset = 0;
    player.dashing = false;
    player.knockbackUntil = 0;
    player.lastActivityAt = performance.now();
    player.relaxed = false;

    bullets.length = 0;
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
    boss.closeRangeInvulnUntil = 0;
    boss.teleportElapsed = 0;
    boss.teleportDest = null;
    teleportBlackoutAlpha = 0; // RESTART snaps the WEAK-POINT-SPAM teleport blackout off instantly too
    boss.lastKnownPlayerX = 0;
    boss.lastKnownPlayerY = 0;
    boss.revealedShotX = null;
    boss.revealedShotY = null;
    boss.consecutiveGuardedShots = 0; // STRAIGHT CLAW guard counter — explicit RESTART reset (A-4)
    boss.straightClawHitSpawned = false;
    boss.counterDir = 'south';
    player.lastCounterDamage = 0;
    resetStealth(); // RESTART/mode switch ends STEALTH and its cooldown outright — the only two things allowed to (PART 21)

    // Stage world/camera/EXIT (PART 21-29) — a RESTART or mode switch always
    // returns to the first/default stage with the world fully closed back up.
    currentStageIndex = 0;
    cameraY = 0;
    stageTransition.active = false;
    stageTransition.phase = null;
    // SECTION C: RESTART/mode switch always returns to AREA 1, fully closed
    // back up (C-28).
    currentArea = 1;
    area1Cleared = false;
    area2Activated = false;
    area2Cleared = false;

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
    dashButton.classList.remove('active');
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

  // Safety net for the RANGE-thumb-residue bug (PART 3): a touch can be
  // interrupted (app backgrounded, OS gesture, incoming call) WITHOUT the
  // specific zone's own touchend/touchcancel ever firing on it — in that
  // case aimStickTouchId/rangeTouchId stay stuck non-null and RANGE (with
  // its thumb) never receives its own hide call at all, no matter how
  // robust hideRangeUI() itself is made. Releasing every held stick/button
  // whenever the page loses visibility/focus guarantees that stuck state
  // can never survive past the interruption.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAllHeldInputs();
  });
  window.addEventListener('blur', releaseAllHeldInputs);

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
    if (boss.spawned && !bossIsInCinematic() && boss.state !== 'teleport') {
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
    if (isBossIntroLocked()) return; // PART 8: facing must stay exactly where the intro placed it
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
    if (isBossIntroLocked()) return; // PART 8
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
    if (flashCooldownRemainingMs > 0) return; // cooldown active: nothing happens at all, not even feedback
    if (!boss.spawned || flashDisabledByCinematic()) return;
    // SECTION 11: COUNTER ATTACK (boss.state === 'straightclaw') is the one
    // state where the distance requirement is deliberately skipped — the
    // player must be able to punish it from anywhere, not just from
    // FLASH_MIN_DISTANCE+ away. Every other state keeps the original
    // "too close" rejection unchanged.
    const counterMode = boss.state === 'straightclaw';
    if (!counterMode) {
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
    if (isBossIntroLocked()) return; // PART 8
    if (stealthCooldownRemainingMs > 0) return; // cooldown active: nothing happens at all, not even feedback
    if (performance.now() < player.stealthUntil) return; // already active
    const now = performance.now();
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

  // Inline-style overrides below are a deliberate belt-and-suspenders on
  // top of the .visible class toggle: relying on the class/CSS-transition
  // alone left a window (confirmed via a stuck AIM-STICK touch id after an
  // interrupted gesture — see the blur/visibilitychange handler further
  // below) where the thumb could still be painted after RANGE was supposed
  // to be gone. Setting opacity/visibility/pointer-events directly always
  // wins over the stylesheet regardless of any in-flight transition or
  // compositing state, so "hidden" is unconditionally true the instant
  // hideRangeUI() runs, on every one of its constituent elements.
  function showRangeUI() {
    rangeZone.classList.add('visible');
    rangeZone.style.opacity = '';
    rangeZone.style.visibility = '';
    rangeZone.style.pointerEvents = '';
  }
  // Always both hides AND resets to default — RANGE must never sit at
  // wherever it was last left once the player's finger comes off AIM STICK.
  function hideRangeUI() {
    rangeZone.classList.remove('visible');
    rangeZone.style.opacity = '0';
    rangeZone.style.visibility = 'hidden';
    rangeZone.style.pointerEvents = 'none';
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
  const MUZZLE_OFFSETS = {
    right: { dx: SPRITE_DRAW_H * 0.503, dy: SPRITE_DRAW_H * -0.253 },
    left: { dx: SPRITE_DRAW_H * -0.506, dy: SPRITE_DRAW_H * -0.321 },
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
    // No canvas muzzle-flash circle — the FIRE sprites already carry their
    // own baked-in flash art; an extra orange dot on top was redundant.
  }

  let playerHitFlashUntil = 0;

  // Exposed for Playwright/manual verification only — not part of gameplay.
  window.__game = {
    player, boss, playerHitCount: 0,
    applyBodyHitToBoss, applyWeakPointHitToBoss, applyExplosionDamageToBoss, bossEnterState,
    getWeakPointScreenPos, arcClawSlashes, spawnArcClawSlash,
    gameState, barrels, explosions, bullets, spawnBarrels, startMode,
    get autoAimActive() { return autoAimActive; },
    getAutoAimTargetPoint, // debug/verification only
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
    HALF_RANGE, clampToHalfRange, BASE_ANGLE, keys, getFinalAimAngle,
    getAimAngle: getFinalAimAngle, // back-compat alias for existing verification scripts — same function, PART 12's new name is getFinalAimAngle
    getCinematicImageInfo, CINEMATIC_SCALE, CINEMATIC_BACK_SCALE, DIR_TO_BOSS_KEY, // debug/verification only
    get barrelRestockPending() { return barrelRestockPending; },
    get barrelRestockRemainingMs() { return barrelRestockRemainingMs; },
    barrelLandings, spawnFallingBarrels, BARREL_FALL_MS, // debug/verification only
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
    // Debug/verification only — STEALTH.
    stealthPress, resetStealth, getBossTargetPos, getStealthEffectStrength,
    STEALTH_DURATION_MS, STEALTH_COOLDOWN_MS,
    get stealthCooldownRemainingMs() { return stealthCooldownRemainingMs; },
    set stealthCooldownRemainingMs(v) { stealthCooldownRemainingMs = v; },
    // Debug/verification only — DARK PHASE.
    startBossDarkPhase, registerGlobalAutoAimHit, getDarkPhaseHeadScreenPos, isAimedAtDarkPhaseHead,
    get darkPhaseOverlayAlpha() { return darkPhaseOverlayAlpha; },
    AUTO_AIM_INVULN_HITS, DARKPHASE_FADE_MS, DARKPHASE_OVERLAY_ALPHA,
    DARKPHASE_ATTACK_RANGE, DARKPHASE_PAUSE_TRIGGER_RANGE, DARKPHASE_HEAD_HIT_RADIUS,
    DARKPHASE_STALK_SPEED, DARKPHASE_CLOSEIN_SPEED, DARKPHASE_LUNGE_SPEED, DARKPHASE_DISENGAGE_SPEED,
    DARKPHASE_STALK_MS_MIN, DARKPHASE_STALK_MS_MAX, DARKPHASE_PAUSE_MS_MIN, DARKPHASE_PAUSE_MS_MAX,
    DARKPHASE_DISENGAGE_MS_MIN, DARKPHASE_DISENGAGE_MS_MAX, DARKPHASE_LUNGE_TIMEOUT_MS,
    isDarkPhaseFlashLocked, // debug/verification only
    canFlashTarget, isAimingAtBoss, isAimedAtBossBody, // debug/verification only — SECTION 9/10/11
    // Debug/verification only — boss INTRO sequence (PART 1-8).
    spawnBoss, isBossIntroLocked,
    BOSS_INTRO_INITIAL_SHAKE_MS, BOSS_INTRO_SILENCE_MS, BOSS_INTRO_SHADOW_REVEAL_MS,
    BOSS_INTRO_LANDING_SHAKE_MS, BOSS_INTRO_POST_LANDING_PAUSE_MS, BOSS_INTRO_SOUTH_IDLE_MS,
    BOSS_INTRO_SOUTH_ATTACK_MS,
    BOSS_INTRO_SHAKE_END, BOSS_INTRO_SILENCE_END, BOSS_INTRO_SHADOW_END,
    BOSS_INTRO_LANDING_SHAKE_END, BOSS_INTRO_POST_PAUSE_END, BOSS_INTRO_SOUTH_IDLE_END,
    get screenShakeMag() { return screenShakeMag; },
    get screenShakeUntil() { return screenShakeUntil; },
    // Debug/verification only — unified muzzle/aim (PART 9-14).
    getMuzzleWorldPosition, MUZZLE_OFFSETS,
    // Debug/verification only — GABRIEL damage blink (PART 35/36).
    get bossDamageBlinkStartAt() { return bossDamageBlinkStartAt; },
    BOSS_DAMAGE_BLINK_COUNT, BOSS_DAMAGE_BLINK_TOTAL_MS, BOSS_HIT_TINT_MS,
    BOSS_CHASE_SPEED, BOSS_SPEED,
    // Debug/verification only — GABRIEL defeat sequence (PART 37-42).
    BOSS_DEFEAT_DOWN_PAUSE_MS, BOSS_DEFEAT_BLACKEN_MS, BOSS_DEFEAT_DISINTEGRATE_MS,
    BOSS_DEFEAT_BLACKEN_START, BOSS_DEFEAT_BLACKEN_END,
    // Debug/verification only — walk-cycle timing (north/south walk frame replacement batch).
    WALK_FRAME_PERIOD_MS, SOUTH_WALK_FRAME_PERIOD_MS,
    // Debug/verification only — STRAIGHT CLAW counterattack (SECTION A).
    STRAIGHT_CLAW_TRIGGER_GUARDS, STRAIGHT_CLAW_WINDUP_MS, STRAIGHT_CLAW_ATTACK_MS, STRAIGHT_CLAW_RECOVERY_MS,
    STRAIGHT_CLAW_KNOCKBACK_DISTANCE, STRAIGHT_CLAW_KNOCKBACK_LOCK_MS,
    // Debug/verification only — COUNTER ATTACK direction split (this batch).
    COUNTER_STING_SCALE, COUNTER_ARC_CLAW_LIFETIME_MS, COUNTER_DAMAGE_MULTIPLIER, COUNTER_ATTACK_DAMAGE,
    // Debug/verification only — AREA 1/AREA 2 vertical stage (SECTION C).
    get currentArea() { return currentArea; },
    get area1Cleared() { return area1Cleared; },
    set area1Cleared(v) { area1Cleared = v; }, // debug/verification only
    get area2Activated() { return area2Activated; },
    get area2Cleared() { return area2Cleared; },
    set area2Cleared(v) { area2Cleared = v; }, // debug/verification only
    CAMERA_FOLLOW_RATE, areaTopY, clampPlayerToScreen,
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

    // Knockback lockout — deliberately short (a few hundred ms, not a full
    // stun), but while it's active MOVE/AIM/FIRE are ALL suppressed, not
    // just movement: a player who gets knocked back must not be able to
    // keep the pressure on by simply re-aiming and firing again the instant
    // the shove itself finishes resolving.
    const knockbackLocked = now < player.knockbackUntil;
    // PART 8: the boss INTRO cinematic locks MOVE/AIM/FIRE completely — the
    // player must stay exactly where/how PART 1 placed them (center-bottom,
    // facing north) for the whole sequence. handleAimStickMove() has its own
    // matching early-return so AIM can't sneak baseDir changes in around
    // this per-frame gate either.
    const introLocked = isBossIntroLocked();

    const moveStickPushed = !introLocked && mag > ACTION_STICK_DEADZONE;
    // PART 9/10: facing follows the AIM STICK whenever it's actively
    // engaged (dragging, or a double-tap snap still locked in) — see
    // handleAimStickMove()/performNearestAutoAimSnap(), which update
    // player.baseDir directly. MOVE STICK only drives facing the rest of
    // the time, exactly as before.
    const aimEngaged = !introLocked && (aimStickActive || now < aimDoubleTapLockUntil);
    if (!aimEngaged && moveStickPushed) {
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
    const isFiringHeld = !knockbackLocked && !introLocked && !moving && (fireHeld || keys.fire);

    updateDash(now); // may override player.x for the duration of a DASH
    if (!player.dashing && moving && !knockbackLocked) {
      player.x += vx * player.speed * dt;
      player.y += vy * player.speed * dt;
    }

    // Clamp to screen bounds (keep character fully visible)
    clampPlayerToScreen();

    // SECTION C: `currentArea` tracks the player's LIVE position every
    // frame (not just a one-time flag) purely so barrel-spawn margins
    // (pickBarrelSpot()) always match whichever band the player is
    // actually standing in, even if they wander back south into AREA 1
    // after AREA 2 has opened up — area2Activated (below) is the real
    // one-time "has AREA 2's own boss been spawned yet" gate.
    // SECTION 15-18: this whole AREA 1/AREA 2 system was previously gated
    // on `H >= W` (portrait only) — but style.css itself documents that
    // "this game is primarily played in landscape" (PART 17), so on a real
    // device in its actual primary orientation, currentArea/area1Cleared/
    // area2Activated never updated at all and the stage never appeared as
    // 2 areas, no matter how thoroughly a portrait-viewport test verified
    // the underlying logic. The camera-scroll math itself (cameraY, the
    // "cover"-style background tiling below) has no dependency on aspect
    // ratio, so removing the orientation restriction is enough — it now
    // runs identically in landscape and portrait.
    if (gameState.mode === 'boss') {
      currentArea = player.y < 0 ? 2 : 1;
      // AREA 1 clear (C-13): its own boss fully dissolved.
      if (!area1Cleared && boss.state === 'dead' && currentArea === 1) {
        area1Cleared = true;
      }
      // AREA 1 -> AREA 2 (C-15/C-16/C-17): the moment the player actually
      // walks north past the seam (world Y 0) for the first time after
      // AREA 1 is cleared, activate AREA 2 exactly once — a fresh boss
      // (C-19: the same GABRIEL, no new AI needed) spawns with its own
      // full intro, inactive until this very moment (C-18) since nothing
      // above ever calls spawnBoss() for AREA 2 before the player arrives.
      if (area1Cleared && !area2Activated && player.y < 0) {
        area2Activated = true;
        bullets.length = 0; arcClawSlashes.length = 0; explosions.length = 0;
        spawnBoss(now); // currentArea is already 2 here, so this spawns/positions relative to AREA 2's own band
        spawnBarrels(2 + Math.floor(Math.random() * 3));
      }
      // AREA 2 clear (C-20): its own boss fully dissolved -> the existing
      // EXIT/stage-transition machinery (unchanged) takes over from here.
      if (!area2Cleared && boss.state === 'dead' && currentArea === 2) {
        area2Cleared = true;
      }
    }

    // Camera + EXIT (PART 21-29, extended by SECTION C) — smooth-follows
    // the player vertically through AREA 1 -> AREA 2 -> (once
    // worldScrollUnlocked()) the small post-clear EXIT-hunting bonus space,
    // clamped so it never scrolls past whichever band is currently unlocked
    // (C-10). Reaching the EXIT is never automatic on boss death: the
    // player must physically walk into that zone themselves, exactly as
    // before this batch.
    if (gameState.mode === 'boss' && !stageTransition.active) {
      let minCameraY;
      if (worldScrollUnlocked()) minCameraY = -H - worldExtraAbove;
      else if (area1Cleared) minCameraY = -H;
      else minCameraY = 0; // AREA 1 only — camera stays pinned exactly like the original single-screen layout
      const targetCameraY = Math.max(minCameraY, Math.min(0, player.y - H * 0.6));
      // Exponential smoothing (C-9): closes (1 - e^(-RATE*dt)) of the
      // remaining distance each frame — framerate-independent, and fast
      // enough (RATE=6) that the player is never left stranded off-screen.
      cameraY += (targetCameraY - cameraY) * Math.min(1, CAMERA_FOLLOW_RATE * dt);
      cameraY = Math.max(minCameraY, Math.min(0, cameraY)); // C-10: never past whichever band is currently unlocked
      if (worldScrollUnlocked()) {
        const exit = exitWorldPos();
        if (Math.abs(player.x - exit.x) < EXIT_ZONE_W / 2 && Math.abs(player.y - exit.y) < EXIT_ZONE_H / 2) {
          beginStageTransition(now);
        }
      }
    } else {
      cameraY = 0;
    }

    // Firing — direction comes from getFinalAimAngle() (the AIM STICK's own
    // absolute angle while aiming, else the current base facing), never
    // from movement. Suppressed entirely during knockbackLocked, same as
    // MOVE/AIM.
    const wantsFire = isFiringHeld;
    if (wantsFire && now - lastFireTime >= FIRE_INTERVAL) {
      lastFireTime = now;
      spawnBullet();
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
      b.x += b.vx * dt;
      b.y += b.vy * dt;
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
      // as if it weren't spawned.
      if (boss.spawned && boss.state !== 'dead' && boss.state !== 'teleport') {
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
      if (consumed) bullets.splice(i, 1);
    }

    updateBarrels(dt, now);
    updateFlashGrenade(dt, now);
    updateStealth(dt, now);
    updateBoss(dt, now);
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
    const angle = getFinalAimAngle();
    // PART 12: the guide starts from the EXACT SAME point spawnBullet() uses
    // — never player-center, never its own independent radial calc — so
    // east/west (whose muzzle is a fixed sprite-relative point, not a
    // rotating radial one) can never visually diverge from the real bullet
    // spawn again.
    const muzzle = getMuzzleWorldPosition(angle);
    const bx = muzzle.x, by = muzzle.y;
    let guideLen = aimRangeLen;
    if (autoAimActive && autoAimLockedPoint && !rangeSliderActive) {
      guideLen = Math.hypot(autoAimLockedPoint.x - bx, autoAimLockedPoint.y - by);
    }
    const ex = bx + Math.cos(angle) * guideLen;
    const ey = by + Math.sin(angle) * guideLen;

    // PART 15-18 / SECTION 9-13: whenever the current AIM target IS
    // GABRIEL (isAimingAtBoss() — DARK PHASE's head, a normal/COUNTER body
    // lock, or COUNTER's raw-aim-ray check), red means EXACTLY "a FLASH
    // thrown right now would hit" — canFlashTarget() is the SAME predicate
    // flashPress() checks, so the two can never disagree. Aimed at
    // something else entirely (a barrel, or nothing) keeps the original,
    // unrelated AUTO AIM red/white feedback — FLASH has no opinion there.
    const aimedAtBoss = isAimingAtBoss();
    const isLocked = aimedAtBoss ? canFlashTarget() : autoAimActive;
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
      const iw = stage.img.naturalWidth, ih = stage.img.naturalHeight;
      const scale = Math.max(W / iw, H / ih);
      const dw = iw * scale, dh = ih * scale;
      const dx = (W - dw) / 2;
      const baseDy = (H - dh) / 2;
      // SECTION C: the tiled column now needs to reach past AREA 2's own
      // full screen-height band (H) as well as the further post-clear EXIT
      // bonus space beyond it — same single background asset the whole
      // way up, never a different image per area (C-2/C-3/C-7).
      const topLimit = -H - worldExtraAbove - dh;
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

    ctx.restore(); // matches the shake-translate ctx.save() at the top of this function

    // Expired explosion effects are pruned here rather than in update(),
    // purely so a paused game still shows a mid-explosion frame frozen
    // instead of having it vanish while update() isn't running.
    for (let i = explosions.length - 1; i >= 0; i--) {
      if (now - explosions[i].startAt > EXPLOSION_DURATION_MS) explosions.splice(i, 1);
    }
  }

  // ---------- STEALTH metallic-blue-tint compositing ----------
  // No new image files, and the real sprite files on disk are never
  // touched — this draws WHATEVER sprite drawPlayer() would normally show
  // (movement/DASH/FIRE/idle, any of the 4 directions) through an offscreen
  // canvas: (1) draw the sprite normally, (2) tint ONLY its own already-
  // opaque pixels a cold metallic blue via `source-atop` (a no-op
  // everywhere the sprite itself is transparent, so the surrounding
  // canvas/background is never touched), (3) add a fine per-pixel noise
  // texture — also confined to the sprite's own opaque pixels via the same
  // source-atop trick — regenerated every STEALTH_NOISE_PERIOD_MS so it
  // reads as "the cloaking surface is faintly glitching", not a smooth
  // color, (4) draw that composited result onto the main canvas at a
  // reduced globalAlpha. Both the tint strength and the alpha are blended
  // by `strength` (0-1, from getStealthEffectStrength()) so STEALTH's
  // ~150ms start/end fade reads as a smooth color+alpha shift, never a
  // snap — see drawPlayer() below for where `strength` comes from.
  const stealthCompositeCanvas = document.createElement('canvas');
  const stealthCompositeCtx = stealthCompositeCanvas.getContext('2d');
  const STEALTH_TINT_RGB = '110, 175, 230'; // metallic/cold blue — PART 32 replaces the old neon green entirely
  const STEALTH_TINT_MAX_ALPHA = 0.72; // strong enough to read as a clear metallic-blue tint at full strength, still sheer enough that armor/face detail shows through (never a flat single-color silhouette)
  // 20 percentage points more transparent than the previous 0.60 (not a
  // fixed value) — Math.max(0, previous - 0.20), per instruction.
  const STEALTH_ALPHA_ACTIVE_PREVIOUS = 0.60;
  const STEALTH_ALPHA_ACTIVE = Math.max(0, STEALTH_ALPHA_ACTIVE_PREVIOUS - 0.20);
  const STEALTH_NOISE_PERIOD_MS = 90; // how often the noise speckle pattern re-rolls — a short period, not a per-frame flicker
  const STEALTH_NOISE_COUNT = 16; // small grain count per refresh, kept light on CPU/GPU
  // Faint optical-camouflage-style outline glow, layered on top of the
  // existing body tint (not a replacement for it) — a canvas shadowBlur/
  // shadowColor halo drawn around the sprite's own opaque silhouette, kept
  // deliberately subtle (moderate blur radius, capped alpha) so it never
  // reads as neon or blows out into flat white.
  const STEALTH_GLOW_COLOR_RGB = '150, 205, 255'; // slightly brighter/cooler than the body tint, so the glow reads as light coming FROM the silhouette, not just more of the same fill
  const STEALTH_GLOW_BLUR_PX = 12;
  const STEALTH_GLOW_ALPHA_MAX = 0.65; // capped well under 1 — a faint halo, never a solid white/blue blob
  let stealthNoiseAt = -Infinity;
  let stealthNoiseSpecks = [];
  // Debug/verification only — declared after window.__game's own literal
  // above, so appended here rather than inside it (same pattern as
  // window.__game.playerFrame below).
  window.__game.STEALTH_ALPHA_ACTIVE = STEALTH_ALPHA_ACTIVE;
  window.__game.STEALTH_ALPHA_ACTIVE_PREVIOUS = STEALTH_ALPHA_ACTIVE_PREVIOUS;
  window.__game.STEALTH_TINT_RGB = STEALTH_TINT_RGB;
  window.__game.STEALTH_GLOW_COLOR_RGB = STEALTH_GLOW_COLOR_RGB;
  window.__game.STEALTH_GLOW_BLUR_PX = STEALTH_GLOW_BLUR_PX;
  window.__game.STEALTH_GLOW_ALPHA_MAX = STEALTH_GLOW_ALPHA_MAX;

  function rollStealthNoise(cw, ch) {
    const specks = [];
    for (let i = 0; i < STEALTH_NOISE_COUNT; i++) {
      const bright = Math.random() < 0.55;
      specks.push({
        x: Math.random() * cw,
        y: Math.random() * ch,
        size: 1 + Math.random() * 1.4, // 1-2.4px — fine grain, never blocky
        bright,
        alpha: bright ? 0.22 + Math.random() * 0.30 : 0.18 + Math.random() * 0.24,
      });
    }
    // A single short horizontal scanline glitch, only some rolls — a subtle
    // flicker accent, not a constant strobing bar.
    if (Math.random() < 0.4) {
      const ly = Math.random() * ch;
      const lw = ch > 0 ? (cw * (0.2 + Math.random() * 0.35)) : 0;
      const lx = Math.random() * Math.max(1, cw - lw);
      specks.push({ scanline: true, x: lx, y: ly, w: lw, alpha: 0.14 + Math.random() * 0.16 });
    }
    return specks;
  }

  function drawPlayerWithStealthTint(img, dx, dy, w, h, strength, now) {
    const cw = Math.max(1, Math.round(w));
    const ch = Math.max(1, Math.round(h));
    if (stealthCompositeCanvas.width !== cw || stealthCompositeCanvas.height !== ch) {
      stealthCompositeCanvas.width = cw;
      stealthCompositeCanvas.height = ch;
    }
    if (now - stealthNoiseAt >= STEALTH_NOISE_PERIOD_MS) {
      stealthNoiseAt = now;
      stealthNoiseSpecks = rollStealthNoise(cw, ch);
    }
    const sctx = stealthCompositeCtx;
    sctx.clearRect(0, 0, cw, ch);
    sctx.globalCompositeOperation = 'source-over';
    sctx.drawImage(img, 0, 0, cw, ch);
    sctx.globalCompositeOperation = 'source-atop';
    sctx.fillStyle = `rgba(${STEALTH_TINT_RGB}, ${STEALTH_TINT_MAX_ALPHA * strength})`;
    sctx.fillRect(0, 0, cw, ch);
    // Fine noise texture (source-atop keeps it confined to the sprite's own
    // opaque pixels — it can never bleed onto the background), scaled by
    // the same fade `strength` so it never appears before/after the color
    // tint itself does.
    for (const s of stealthNoiseSpecks) {
      const a = s.alpha * strength;
      if (a <= 0) continue;
      if (s.scanline) {
        sctx.fillStyle = `rgba(215,235,255,${a})`;
        sctx.fillRect(s.x, s.y, s.w, 1);
      } else {
        sctx.fillStyle = s.bright ? `rgba(205,225,255,${a})` : `rgba(5,12,28,${a})`;
        sctx.fillRect(s.x, s.y, s.size, s.size);
      }
    }
    sctx.globalCompositeOperation = 'source-over';

    ctx.save();
    // 1 at strength=0 (fully normal/opaque) -> STEALTH_ALPHA_ACTIVE at strength=1.
    ctx.globalAlpha = 1 - (1 - STEALTH_ALPHA_ACTIVE) * strength;
    // Faint outline glow: shadowBlur/shadowColor build a halo from the
    // sprite's own opaque silhouette (canvas shadow follows alpha, not a
    // separate shape) — scaled by `strength` so it fades in/out with
    // everything else and never appears as a snap. Cleared automatically
    // by ctx.restore() below, so normal (non-STEALTH) draws are never
    // affected — see PART 4/B-4: no residue once STEALTH ends.
    ctx.shadowColor = `rgba(${STEALTH_GLOW_COLOR_RGB}, ${STEALTH_GLOW_ALPHA_MAX * strength})`;
    ctx.shadowBlur = STEALTH_GLOW_BLUR_PX * strength;
    ctx.drawImage(stealthCompositeCanvas, dx, dy, w, h);
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
      const stealthStrength = getStealthEffectStrength(now);
      if (stealthStrength > 0) {
        drawPlayerWithStealthTint(img, dx, dy, drawW, drawH, stealthStrength, now);
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
      // The windup telegraph is shared by every direction (only 1 windup
      // image exists, and it's just a generic "charging up" pose). What
      // changes is the RELEASE/recovery pose: boss.counterDir === 'south'
      // keeps the original front-facing STING pose (straight_claw_release);
      // north/east/west instead reuse the EXISTING per-direction ARC CLAW
      // SLASH attack pose (SECTION 4) — the STING pose only reads correctly
      // when GABRIEL is facing the player, i.e. player south of it.
      const elapsed = now - boss.stateEnteredAt;
      if (elapsed < STRAIGHT_CLAW_WINDUP_MS) return 'straight_claw_windup';
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
      // 2-frame alternation (1->2->1->2...) at SOUTH_WALK_FRAME_PERIOD_MS
      // (~50% slower than WALK_FRAME_PERIOD_MS, since only 2 frames exist
      // now — see BOSS_FRAME_FILES/south_walk3_build_meta.json).
      return (Math.floor(now / SOUTH_WALK_FRAME_PERIOD_MS) % 2 === 0) ? 'walk_south_1' : 'walk_south_2';
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
    // SECTION 3: real-device feedback said the STING windup/release images
    // read too large — 10% smaller (COUNTER_STING_SCALE), applied to BOTH
    // so the windup->release transition still shows no size jump. Scaling
    // via this same shared mechanism scales from the sprite's own BOTTOM
    // edge (see the comment above), so the ground anchor/attack position
    // are unaffected — only the drawn height/width shrink. attack_north/
    // attack_east_release/attack_west_release (shown instead of these for
    // a north/east/west COUNTER ATTACK — see bossFrameName()) keep their
    // own existing scale untouched, matching how they already look during
    // a normal ARC CLAW SLASH attack.
    else if (name === 'straight_claw_windup' || name === 'straight_claw_release') scale = COUNTER_STING_SCALE;
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
      const img = bossSprites.south_idle;
      if (img && img.complete && img.naturalWidth > 0) {
        const scale = SOUTH_WALK_SCALE; // south_idle's own established display scale — same size it lands at
        const w = BOSS_DRAW_W * scale, h = BOSS_DRAW_H * scale;
        const t = (elapsed - BOSS_INTRO_SILENCE_END) / BOSS_INTRO_SHADOW_REVEAL_MS;
        drawBossSilhouette(img, boss.x - w / 2, bottomY - h, w, h, t);
      }
    } else if (elapsed >= BOSS_INTRO_SHADOW_END && elapsed < BOSS_INTRO_SOUTH_IDLE_END) {
      const img = bossSprites.south_idle;
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

  // DARK PHASE: GABRIEL's body is intentionally never drawn here — no
  // silhouette, no outline of any color, nothing that could read as a
  // white/gray halo. Only the direction-appropriate head image (see
  // assets/boss/darkphase_heads_build_meta.json — each one alpha-cropped
  // straight out of its own attached photo, never a Canvas-drawn design),
  // positioned via getDarkPhaseHeadScreenPos()'s same scale/anchor so it
  // always sits exactly on top of boss.x/boss.y as the STALK/CLOSE IN/
  // PAUSE/LUNGE/DISENGAGE AI actually moves them (see updateBossDarkPhase()
  // and its per-substate helpers) — a real head creeping through the dark,
  // not a static effect. During the brief PAUSE telegraph beat right before
  // LUNGE, the SAME image is drawn through a temporary brightness filter —
  // a pixel-value rescale, never a new shape or an added light source. The
  // screen-darken overlay itself is drawn separately, UNDER the
  // player/bullets/this head (see draw()), so it can go near-total-black
  // without also hiding anything that must stay visible — see
  // darkPhaseOverlayAlpha/updateDarkPhaseOverlay().
  function drawBossDarkPhase(now) {
    const anchor = getDarkPhaseHeadScreenPos(); // same single anchor point for every direction — never moves independently of this
    const dirKey = DIR_TO_BOSS_KEY[boss.dir]; // 'north' | 'south' | 'east' | 'west'
    const img = darkPhaseHeadImgs[dirKey];
    const m = DARKPHASE_HEAD_METRICS[dirKey];
    if (!img || !m || !img.complete || img.naturalWidth <= 0) return;
    ctx.save();
    if (boss.darkPhaseSubState === 'pause') ctx.filter = 'brightness(1.45)';
    // Anchor on the image's OWN eye/head-center offset (not its bbox
    // center), so the visible eye (or, for north's eyeless back-of-head
    // photo, its equivalent head-center point) lands exactly on the same
    // point isAimedAtDarkPhaseHead() checks against, whichever direction is
    // showing.
    const drawX = anchor.x - m.eyeOffsetScaledX;
    const drawY = anchor.y - m.eyeOffsetScaledY;
    ctx.drawImage(img, drawX, drawY, m.displayW, m.displayH);
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
    let maxRow = 1;
    for (const c of cells) maxRow = Math.max(maxRow, c.gy);

    const particles = cells.map((c) => {
      // PART 39/40: dissolve order now follows the real silhouette's own
      // rows top-to-bottom (rowFrac 0 at the very top, 1 at the feet) —
      // NOT distance-from-center — so the body visibly crumbles from the
      // head down, matching "上から下へ崩壊", with a little per-grain
      // jitter so the boundary reads as ragged erosion, not a hard line.
      const rowFrac = c.gy / maxRow;
      const dissolveAt = Math.max(0, Math.min(0.85, rowFrac * 0.70 + Math.random() * 0.25));
      // PART 41: mostly straight down (gravity), only a little left/right
      // scatter — the opposite of the old mostly-upward burst.
      const angle = Math.PI / 2 + (Math.random() - 0.5) * 1.0;
      // PART 41: black to dark-gray grains — not the sprite's own sampled
      // color — since by the time anything is falling, the body itself has
      // already fully blackened (see drawBossBlackenTint()/BOSS_DEFEAT_
      // BLACKEN_* above).
      const shade = Math.floor(Math.random() * 34);
      return {
        gx: c.gx, gy: c.gy,
        color: `rgba(${shade},${shade},${shade},`,
        dissolveAt,
        angle,
        speed: 10 + Math.random() * 26,
        spin: (Math.random() - 0.5) * 4,
        grain: 0.55 + Math.random() * 1.1, // fine sand-grain radius, px — independent of the sampling cell size
      };
    });
    boss.dyingParticles = particles;
    boss.dyingParticlesBuilt = true;
  }

  // PART 37-42: DOWN pose (static, full color) -> gradual blackening
  // (drawBossBlackenTint()) -> real particle disintegration of the now-
  // black silhouette, its pieces falling downward under gravity — not a
  // plain opacity fade in place, and not an upward burst. The intact
  // (blackened) sprite is drawn first each frame, then every already-
  // dissolved cell is punched out of it (destination-out) and redrawn as a
  // separate falling fragment, so the body visibly comes apart in pieces.
  function drawBossDying(now) {
    if (!boss.dyingParticlesBuilt) buildDyingParticles();
    const dyingDrawCin = getCinematicImageInfo(); // same boss.downFacing as buildDyingParticles() used — stable for the whole sequence
    if (!dyingDrawCin.img.complete || dyingDrawCin.img.naturalWidth <= 0) return;
    const elapsed = boss.cinematicElapsed;
    const drawX = boss.x - dyingDrawCin.w / 2 + dyingDrawCin.offX;
    const drawY = boss.y - dyingDrawCin.h / 2 + dyingDrawCin.offY;

    if (elapsed < BOSS_DEFEAT_BLACKEN_START) {
      // PART 38: a brief static hold on the ordinary, full-color DOWN pose
      // before anything starts changing.
      ctx.drawImage(dyingDrawCin.img, drawX, drawY, dyingDrawCin.w, dyingDrawCin.h);
      return;
    }
    if (elapsed < BOSS_DEFEAT_BLACKEN_END) {
      // PART 39: normal color -> near-black, staged.
      const blackT = (elapsed - BOSS_DEFEAT_BLACKEN_START) / BOSS_DEFEAT_BLACKEN_MS;
      drawBossBlackenTint(dyingDrawCin.img, drawX, drawY, dyingDrawCin.w, dyingDrawCin.h, blackT);
      return;
    }

    const disintegrateElapsed = elapsed - BOSS_DEFEAT_BLACKEN_END;
    const frac = Math.min(1, disintegrateElapsed / BOSS_DEFEAT_DISINTEGRATE_MS);

    ctx.save();
    ctx.globalAlpha = frac > 0.85 ? Math.max(0, (1 - frac) / 0.15) : 1;
    drawBossSilhouette(dyingDrawCin.img, drawX, drawY, dyingDrawCin.w, dyingDrawCin.h, 1); // fully blackened by now
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    for (const p of boss.dyingParticles) {
      if (frac < p.dissolveAt) continue;
      ctx.fillRect(drawX + p.gx * DYING_CELL_SIZE, drawY + p.gy * DYING_CELL_SIZE, DYING_CELL_SIZE + 1, DYING_CELL_SIZE + 1);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    // Fine sand/ash grains, not squares — each one a tiny circle falling
    // under gravity (accelerating, not a fixed drift speed) and shrinking
    // slightly as it fades. Deliberately NOT a plain opacity fade in place:
    // position genuinely falls (dx/dy below) and the underlying sprite is
    // actually punched out (above) as each grain releases.
    const disintegrateSec = BOSS_DEFEAT_DISINTEGRATE_MS / 1000;
    for (const p of boss.dyingParticles) {
      if (frac < p.dissolveAt) continue;
      const localT = Math.min(1, (frac - p.dissolveAt) / Math.max(0.05, 1 - p.dissolveAt));
      const driftSec = (frac - p.dissolveAt) * disintegrateSec;
      const dx = Math.cos(p.angle) * p.speed * driftSec;
      const dy = Math.sin(p.angle) * p.speed * driftSec + 0.5 * DEFEAT_PARTICLE_GRAVITY * driftSec * driftSec;
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
