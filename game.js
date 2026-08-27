(() => {
  'use strict';

  // ---------- Canvas setup ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  let W = 0, H = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 100));
  resize();

  // ---------- Stage background ----------
  // Decorative floor image only — no collision is derived from it, the
  // player still moves freely across the whole canvas as before. Used for
  // portrait/tall viewports (where its aspect ratio fits well); landscape
  // keeps the original dark grid background rather than force-fitting a
  // tall image into a wide screen.
  const stageBg = new Image();
  let stageBgReady = false;
  stageBg.onload = () => { stageBgReady = true; };
  stageBg.src = 'assets/stage/lab_b03_floor.png';

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
    // 'attack' (generic) is still used for EAST/WEST — no dedicated art
    // exists for those yet. NORTH/SOUTH each got their own dedicated
    // attack render this round; see bossFrameName()'s 'attack' branch.
    attack: 'attack', attack_south: 'attack_south', attack_north: 'attack_north',
    defense_south: 'defense', defense_north: 'defense_north', defense_east: 'defense_east', defense_west: 'defense_west',
    // The on-disk walk_east.png/walk_west.png pair has its content swapped
    // from its filename (walk_east.png is actually the left/west-facing
    // render and vice versa — confirmed by visual comparison against the
    // correctly-labeled east_idle/west_idle pair). Rather than touch the
    // image files, the logical keys below simply load the other file.
    walk_south_1: 'walk_south_1', walk_south_2: 'walk_south_2', walk_east: 'walk_west', walk_west: 'walk_east',
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

  // ---------- Boss CINEMATIC POSE (intro / HP-threshold / death only) ----------
  // A separate, standalone image — never mixed into the normal IDLE/WALK/
  // ATTACK/DEFENSE frame set above, never used as a movement sprite. Used
  // as-is (its bbox already spans almost the entire source canvas, so no
  // extra crop was needed) at its own aspect ratio rather than forced onto
  // the narrower 700x920 movement-sprite canvas, since its wings are
  // spread wide enough that doing so would clip them.
  const cinematicPoseImg = new Image();
  cinematicPoseImg.src = 'assets/boss/cinematic_pose.png';
  const CINEMATIC_ASPECT = 1190 / 1317; // the source image's own W/H
  const CINEMATIC_SCALE = 1.1; // ~1.0-1.2x the normal boss size, per spec
  const CINEMATIC_DRAW_H = BOSS_DRAW_H * CINEMATIC_SCALE;
  const CINEMATIC_DRAW_W = CINEMATIC_DRAW_H * CINEMATIC_ASPECT;

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
  const HALF_RANGE = Math.PI / 4; // +-45 degrees (90-degree total aim wedge)

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
    dashDir: 'right', // 'right' | 'left' | 'up' | 'down'
    dashStartAt: -Infinity,
    dashFromX: 0,
    dashFromY: 0,
    dashDistance: 0,
    dashBuffered: false, // a DASH press received near the end of the current DASH
    dashChainCount: 0, // dashes used in the current chain (max DASH_CHAIN_MAX)
    facingLockUntil: 0, // briefly holds baseDir after a completed 2-dash chain reversal
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
  }

  function setBaseDir(dir) {
    if (dir === player.baseDir) return;
    forceSetBaseDir(dir);
  }

  function clampPlayerToScreen() {
    const halfW = (SPRITE_DRAW_H * spriteAspect) / 2;
    const halfH = SPRITE_DRAW_H / 2;
    player.x = Math.max(halfW, Math.min(W - halfW, player.x));
    player.y = Math.max(halfH, Math.min(H - halfH, player.y));
  }

  // ---------- DASH (4 directions, max 2 chained) ----------
  const DASH_DURATION_MS = 800;
  const DASH_DISTANCE_FRAC = 0.20; // 20% of screen width — within the 15-25% target
  const RELAXED_IDLE_DELAY_MS = 400;
  const DASH_CHAIN_MAX = 2; // at most 2 dashes per chain — a 3rd request is refused
  const FACING_LOCK_MS = 200; // briefly holds the post-chain reversed facing against stick input
  const OPPOSITE_DIR = { up: 'down', down: 'up', left: 'right', right: 'left' };

  function tryStartDash(now) {
    if (player.dashing) return;
    if (player.dashChainCount >= DASH_CHAIN_MAX) return; // chain already used up
    // Direction is always the player's current facing — all 4 cardinal
    // directions have dedicated dash art now, so no fallback is needed.
    const dir = player.baseDir;
    player.dashing = true;
    player.dashDir = dir;
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
  function requestDash(now) {
    if (!player.dashing) {
      tryStartDash(now);
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
      if (buffered) {
        tryStartDash(now); // chain immediately, no cooldown gap
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
    const progress = dashTravelProgress(elapsed / DASH_DURATION_MS);
    if (player.dashDir === 'up') {
      player.y = player.dashFromY - player.dashDistance * progress;
    } else if (player.dashDir === 'down') {
      player.y = player.dashFromY + player.dashDistance * progress;
    } else {
      const sign = player.dashDir === 'right' ? 1 : -1;
      player.x = player.dashFromX + sign * player.dashDistance * progress;
    }
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
  const WALK_FRAME_PERIOD_MS = 260; // south 2-frame alternation period
  const NORTH_BOUNCE_AMPLITUDE = 4; // px, decorative only (no NORTH walk art)

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
  const DYING_CELL_SIZE = 10; // px, sampled at the cinematic sprite's on-screen size
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
    x: 0, y: 0,
    spawned: false,
    state: 'inactive', // inactive | chase | attack | defense | guardbreak | recover | dead
    dir: 'down', // shared player-style bucket key; mapped to north/south/east/west for movement/attack facing
    defenseDir: 'south', // 'north'|'south'|'east'|'west' — which DEFENSE sprite/weak-point is active; set from incoming fire, independent of `dir`
    moving: false,
    hp: BOSS_HP_MAX,
    stateEnteredAt: 0,
    attackHitApplied: false,
    attackProjectileSpawned: false,
    chaseBackoffUntil: 0,
    deadAt: 0,
    warningUntil: 0,
    defenseAimHits: 0, // valid AUTO-AIM-assisted hits landed during the current DEFENSE
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
    // The GUARD BREAK counter only ever means something mid-DEFENSE — reset
    // it the instant any other state (fresh DEFENSE included, since this
    // covers entering it too) is entered so a stale count never survives.
    if (state !== 'defense') boss.defenseAimHits = 0;
    // Cinematic phases track their own progress by accumulating `dt` inside
    // update() (which PAUSE already skips entirely) rather than by
    // `now - stateEnteredAt` — the latter would jump forward by however
    // long a real-world PAUSE lasted the instant it resumes, effectively
    // skipping the rest of the cinematic instead of continuing it.
    if (state === 'intro' || state === 'threshold' || state === 'dying') {
      boss.cinematicElapsed = 0;
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
    boss.defenseDir = 'south';
    boss.moving = false;
    boss.warningUntil = now + 1500;
    boss.defenseAimHits = 0;
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
    triggerScreenShake(now, 5, 150);
    bossEnterState('threshold', now);
  }

  function startBossDying(now) {
    clawProjectiles.length = 0; // no lingering attack hazards during the death cinematic
    boss.dyingParticlesBuilt = false;
    boss.dyingParticles = [];
    bossEnterState('dying', now);
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
    const incomingFrom = OPPOSITE_COMPASS[velocityToCompass(bulletVx, bulletVy)];
    if (boss.state === 'defense') {
      boss.defenseDir = incomingFrom;
      if (autoAimed) {
        boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
        if (checkBossHpMilestones(now)) return; // death or a threshold cinematic took over
        weakPointFlashUntil = now + 220; // "valid hit" feedback — same as a real weak-point hit, not a ricochet
        weakPointFlashAt = { x: bulletX, y: bulletY };
        registerDefenseAimHit(now);
        return;
      }
      spawnDefenseRicochet(now, bulletX, bulletY, bulletVx, bulletVy);
      return;
    }
    boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
    if (checkBossHpMilestones(now)) return;
    boss.defenseDir = incomingFrom;
    bossEnterState('defense', now);
  }

  // The weak point always takes genuine physical hits regardless of AUTO
  // AIM (a manually-aimed precision shot still works, unchanged from
  // before) — but only an AUTO-AIM-assisted weak-point hit also counts
  // toward GUARD BREAK, same rule as the body-target fallback above.
  function applyWeakPointHitToBoss(now, autoAimed) {
    if (!boss.spawned || boss.state !== 'defense') return;
    boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
    weakPointFlashUntil = now + 220;
    const wp = getWeakPointScreenPos(boss.defenseDir);
    if (wp) weakPointFlashAt = wp;
    if (checkBossHpMilestones(now)) return; // death or a threshold cinematic took over
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
        bossEnterState('attack', now);
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
    } else if (boss.state === 'attack') {
      const elapsed = now - boss.stateEnteredAt;
      if (elapsed >= BOSS_ATTACK_WINDUP_MS) {
        if (!boss.attackProjectileSpawned) {
          boss.attackProjectileSpawned = true;
          spawnClawProjectile(now);
        }
        if (elapsed < BOSS_ATTACK_WINDUP_MS + BOSS_ATTACK_ACTIVE_MS && !boss.attackHitApplied) {
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
      if (elapsed >= BOSS_ATTACK_WINDUP_MS + BOSS_ATTACK_ACTIVE_MS) {
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
      if (now - boss.stateEnteredAt >= GUARD_BREAK_PAUSE_MS) {
        boss.dir = angleToBucket(Math.atan2(player.y - boss.y, player.x - boss.x));
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
      if (p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) {
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

  // ---------- Game mode / PAUSE ----------
  const gameState = {
    mode: 'boss', // 'boss' | 'training'
    paused: false, // game starts running in BOSS MODE, same as before PAUSE existed
  };
  let modeStartTime = performance.now();

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
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = marginX + Math.random() * (W - marginX * 2);
      const y = marginTop + Math.random() * (H - marginTop - marginBottom);
      if (isNearUIZone(x, y)) continue;
      if (Math.hypot(x - W / 2, y - H / 2) < 70) continue; // player spawn
      if (Math.hypot(x - W / 2, y - Math.max(BOSS_DRAW_H * 0.55, H * 0.16)) < 90) continue; // boss spawn
      let tooClose = false;
      for (const b of barrels) {
        if (b.alive && Math.hypot(x - b.x, y - b.y) < BARREL_DRAW_H * 3) { tooClose = true; break; }
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
      barrels.push({ x: spot.x, y: spot.y, alive: true, respawnAt: 0 });
    }
  }

  const explosions = [];
  const EXPLOSION_DURATION_MS = 600; // 0-100 flash, 100-300 fireball, 300-600 sparks/debris/smoke decay
  const BARREL_DAMAGE = BULLET_DAMAGE * 15; // ~15 normal shots worth, per spec's 10-20x range — unchanged
  const TRAINING_RESPAWN_MIN_MS = 800, TRAINING_RESPAWN_MAX_MS = 1500;

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
    if (gameState.mode === 'training') {
      barrel.respawnAt = now + TRAINING_RESPAWN_MIN_MS + Math.random() * (TRAINING_RESPAWN_MAX_MS - TRAINING_RESPAWN_MIN_MS);
    }
  }

  function updateBarrels(now) {
    for (const b of barrels) {
      if (!b.alive && b.respawnAt && now >= b.respawnAt) {
        const spot = pickBarrelSpot();
        b.x = spot.x; b.y = spot.y; b.alive = true; b.respawnAt = 0;
      }
    }
  }

  function drawBarrel(b) {
    if (!barrelImg.complete || barrelImg.naturalWidth === 0) return;
    const aspect = barrelImg.naturalWidth / barrelImg.naturalHeight;
    const h = BARREL_DRAW_H, w = h * aspect;
    ctx.drawImage(barrelImg, b.x - w / 2, b.y - h / 2, w, h);
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

  function applyExplosionDamageToBoss(amount, now) {
    if (!boss.spawned || bossIsInCinematic()) return;
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
  // clamped through the exact same +-45 deg function as manual aim, so it
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
    autoAimActive = false;
    autoAimTargetIsBoss = false;
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
    player.dashChainCount = 0;
    player.facingLockUntil = 0;
    player.lastActivityAt = performance.now();
    player.relaxed = false;

    bullets.length = 0;
    clawProjectiles.length = 0;
    explosions.length = 0;

    boss.spawned = false;
    boss.state = 'inactive';
    boss.hp = BOSS_HP_MAX;

    modeStartTime = performance.now();
    spawnBarrels(2 + Math.floor(Math.random() * 3)); // 2-4
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
    dashButton.classList.remove('active');
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
  let aimStickTouchId = null;
  let aimStickMouseDown = false;
  let aimStickActive = false; // whether to draw the dotted prediction line
  const AIM_DEADZONE_PX = 6;

  function aimStickReset() {
    aimStickTouchId = null;
    aimStickMouseDown = false;
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

    // Knob visually stops at the same +-45 deg wall as the raw input, so
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

  // ---------- DASH button ----------
  // A separate DOM element from FIRE, so a distinct touch on it never
  // collides with FIRE's own touch identifier — same independent-zone
  // pattern already used for ACTION STICK / AIM STICK / FIRE.
  const dashZone = document.getElementById('dash-zone');
  const dashButton = document.getElementById('dash-button');
  const dashArrowEl = document.getElementById('dash-arrow');

  function dashPress(e) {
    e.preventDefault();
    dashButton.classList.add('active');
    requestDash(performance.now());
  }
  function dashRelease(e) {
    if (e) e.preventDefault();
    dashButton.classList.remove('active');
  }
  // Listeners live on the zone (the actual touch hit area), not the smaller
  // visual button inside it — see #dash-zone/#dash-button sizing in
  // style.css. A tap anywhere in the zone still reaches this handler
  // because the button is its descendant and the event bubbles.
  dashZone.addEventListener('touchstart', dashPress, { passive: false });
  dashZone.addEventListener('touchend', dashRelease, { passive: false });
  dashZone.addEventListener('touchcancel', dashRelease, { passive: false });
  dashZone.addEventListener('mousedown', dashPress);
  window.addEventListener('mouseup', dashRelease);

  // Plain text arrow glyphs only (no color emoji), matching the
  // military/SF UI style. DASH's actual direction is always the player's
  // current base facing (tryStartDash() reads player.baseDir directly), so
  // showing player.baseDir here can never drift from where DASH will go.
  const DASH_ARROW = { up: '↑', down: '↓', left: '←', right: '→' };
  let lastDashArrowDir = null;

  function updateDashButtonUI(now) {
    // Dim only while the current DASH is actually running (no more added
    // cooldown afterward — it's ready again the instant this clears).
    dashButton.classList.toggle('cooldown', player.dashing);
    // Only touch the DOM when the direction actually changes, not every
    // frame, to avoid needless layout/text churn.
    if (player.baseDir !== lastDashArrowDir) {
      lastDashArrowDir = player.baseDir;
      dashArrowEl.textContent = DASH_ARROW[player.baseDir];
    }
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
  const AIM_LINE_LEN = 240; // shared by the aim line and AUTO AIM's reticle-tip check
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
    });
    // No canvas muzzle-flash circle — the FIRE sprites already carry their
    // own baked-in flash art; an extra orange dot on top was redundant.
  }

  let playerHitFlashUntil = 0;

  // Exposed for Playwright/manual verification only — not part of gameplay.
  window.__game = {
    player, boss, playerHitCount: 0,
    applyBodyHitToBoss, applyWeakPointHitToBoss, applyExplosionDamageToBoss, bossEnterState,
    getWeakPointScreenPos, clawProjectiles,
    gameState, barrels, explosions, spawnBarrels, startMode,
    get autoAimActive() { return autoAimActive; },
    get autoAimTargetIsBoss() { return autoAimTargetIsBoss; },
    MUZZLE_DIST, AIM_LINE_LEN, AUTO_AIM_RADIUS,
    // Debug/verification only — boss cinematic sequences.
    bossIsInCinematic, checkBossHpMilestones, startBossThreshold, startBossDying,
    BOSS_PHASE_THRESHOLDS, INTRO_TOTAL_MS, THRESHOLD_CINEMATIC_MS, DYING_DURATION_MS,
    DEFENSE_GUARD_BREAK_HITS, BARREL_EXPLOSION_RADIUS, BOSS_HURT_RADIUS,
  };

  // ---------- Main loop ----------
  let lastTime = performance.now();

  function update(dt, now) {
    if (gameState.paused) return; // PAUSE freezes everything: no movement, AI, bullets, timers
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
    if (!player.dashing && moving) {
      player.x += vx * player.speed * dt;
      player.y += vy * player.speed * dt;
    }

    // Clamp to screen bounds (keep character fully visible)
    clampPlayerToScreen();

    // Firing — direction comes from getAimAngle() (AIM STICK offset applied
    // to the current base facing), never from movement
    const wantsFire = fireHeld || keys.fire;
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

    updateDashButtonUI(now);
    updateAutoAim(now);

    // Update bullets — weak point is checked first (only matters while
    // boss.state === 'defense'), body hurtbox otherwise, then alive barrels.
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) {
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
            applyWeakPointHitToBoss(now, b.autoAimedBoss);
            consumed = true;
          }
        }
        if (!consumed && Math.hypot(b.x - boss.x, b.y - boss.y) <= BOSS_HURT_RADIUS) {
          applyBodyHitToBoss(now, b.x, b.y, b.vx, b.vy, b.autoAimedBoss);
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

    updateBarrels(now);
    updateBoss(dt, now);
    updateClawProjectiles(dt, now);
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
  function drawAimLine() {
    if (!aimStickActive) return;
    const angle = getAimAngle();
    const bx = player.x + Math.cos(angle) * MUZZLE_DIST;
    const by = player.y + Math.sin(angle) * MUZZLE_DIST;
    const ex = bx + Math.cos(angle) * AIM_LINE_LEN;
    const ey = by + Math.sin(angle) * AIM_LINE_LEN;

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

    // background
    if (stageBgReady && H >= W) {
      // Portrait viewport: draw the lab-floor stage image "cover"-style —
      // uniformly scaled (never stretched on one axis only) so it fills
      // the screen, center-cropping only the minimum needed on one axis.
      const iw = stageBg.naturalWidth, ih = stageBg.naturalHeight;
      const scale = Math.max(W / iw, H / ih);
      const dw = iw * scale, dh = ih * scale;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      ctx.drawImage(stageBg, dx, dy, dw, dh);
      // Light darkening overlay only, drawn on the canvas — the source
      // image file itself is never modified — so the character, bullets
      // and aim reticle stay legible against the bright metal floor.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fillRect(0, 0, W, H);
    } else {
      // Landscape (or image not yet loaded): unchanged original background.
      ctx.fillStyle = '#131416';
      ctx.fillRect(0, 0, W, H);

      // subtle ground grid for spatial reference (minimal, non-intrusive)
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      const grid = 64;
      for (let gx = (W / 2) % grid; gx < W; gx += grid) {
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
      }
      for (let gy = (H / 2) % grid; gy < H; gy += grid) {
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
      }
    }

    // Barrels sit on the ground, above the background but below the
    // characters (drawn next), same as an ordinary game object.
    for (const b of barrels) if (b.alive) drawBarrel(b);
    for (const e of explosions) drawExplosion(e, now);

    // bullets
    for (const b of bullets) drawBullet(b);

    // Claw projectiles draw alongside the player's own bullets.
    for (const p of clawProjectiles) drawClawProjectile(p);

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
    if (boss.state === 'attack') {
      // boss.dir is set to face the player at the exact moment ATTACK
      // begins (see the CHASE->ATTACK and GUARD BREAK->ATTACK transitions),
      // so it's already "where the player was relative to the boss when
      // the attack started" — exactly what picks the sprite here. NORTH/
      // SOUTH get their own dedicated art; EAST/WEST keep the existing
      // generic 'attack' render (no dedicated art for those directions yet).
      const atkKey = DIR_TO_BOSS_KEY[boss.dir];
      if (atkKey === 'north') return 'attack_north';
      if (atkKey === 'south') return 'attack_south';
      return 'attack';
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
      const frame = Math.floor(now / WALK_FRAME_PERIOD_MS) % 2;
      return frame === 0 ? 'walk_south_1' : 'walk_south_2';
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

    const name = bossFrameName(now);
    window.__game.bossFrame = name; // debug/verification only
    const img = bossSprites[name];
    let bounce = 0;
    if (boss.moving && DIR_TO_BOSS_KEY[boss.dir] === 'north') {
      bounce = Math.sin(now / 120) * NORTH_BOUNCE_AMPLITUDE;
    }
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(
        img,
        boss.x - BOSS_DRAW_W / 2,
        boss.y - BOSS_DRAW_H / 2 + bounce,
        BOSS_DRAW_W, BOSS_DRAW_H
      );
    }
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
    if (elapsed >= descendStart && cinematicPoseImg.complete && cinematicPoseImg.naturalWidth > 0) {
      ctx.drawImage(
        cinematicPoseImg,
        boss.x - CINEMATIC_DRAW_W / 2,
        boss.y - CINEMATIC_DRAW_H / 2,
        CINEMATIC_DRAW_W, CINEMATIC_DRAW_H
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
    if (cinematicPoseImg.complete && cinematicPoseImg.naturalWidth > 0) {
      ctx.drawImage(
        cinematicPoseImg,
        boss.x - CINEMATIC_DRAW_W / 2,
        boss.y - CINEMATIC_DRAW_H / 2,
        CINEMATIC_DRAW_W, CINEMATIC_DRAW_H
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

  // Samples the CINEMATIC POSE image (as actually drawn on-screen, so
  // colors/silhouette match exactly) into a grid of small opaque cells —
  // built once per death via boss.dyingParticlesBuilt. Outer/edge cells get
  // an earlier dissolveAt than central ones, so the body visibly peels
  // apart from the outside in rather than dissolving uniformly.
  function buildDyingParticles() {
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.ceil(CINEMATIC_DRAW_W));
    off.height = Math.max(1, Math.ceil(CINEMATIC_DRAW_H));
    const octx = off.getContext('2d');
    if (cinematicPoseImg.complete && cinematicPoseImg.naturalWidth > 0) {
      octx.drawImage(cinematicPoseImg, 0, 0, off.width, off.height);
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
      const angle = Math.atan2(c.gy - cy, c.gx - cx) + (Math.random() - 0.5) * 0.6;
      return {
        gx: c.gx, gy: c.gy,
        color: `rgba(${c.r},${c.g},${c.b},`,
        dissolveAt,
        angle,
        speed: 30 + Math.random() * 70,
        spin: (Math.random() - 0.5) * 4,
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
    const frac = Math.min(1, boss.cinematicElapsed / DYING_DURATION_MS);
    const drawX = boss.x - CINEMATIC_DRAW_W / 2;
    const drawY = boss.y - CINEMATIC_DRAW_H / 2;

    ctx.save();
    ctx.globalAlpha = frac > 0.85 ? Math.max(0, (1 - frac) / 0.15) : 1;
    if (cinematicPoseImg.complete && cinematicPoseImg.naturalWidth > 0) {
      ctx.drawImage(cinematicPoseImg, drawX, drawY, CINEMATIC_DRAW_W, CINEMATIC_DRAW_H);
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    for (const p of boss.dyingParticles) {
      if (frac < p.dissolveAt) continue;
      ctx.fillRect(drawX + p.gx * DYING_CELL_SIZE, drawY + p.gy * DYING_CELL_SIZE, DYING_CELL_SIZE + 1, DYING_CELL_SIZE + 1);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    for (const p of boss.dyingParticles) {
      if (frac < p.dissolveAt) continue;
      const localT = Math.min(1, (frac - p.dissolveAt) / Math.max(0.05, 1 - p.dissolveAt));
      const driftSec = (frac - p.dissolveAt) * (DYING_DURATION_MS / 1000);
      const dx = Math.cos(p.angle) * p.speed * driftSec;
      const dy = Math.sin(p.angle) * p.speed * driftSec - driftSec * 40; // drifts upward over time
      const alpha = Math.max(0, 1 - localT);
      const px = drawX + p.gx * DYING_CELL_SIZE + DYING_CELL_SIZE / 2 + dx;
      const py = drawY + p.gy * DYING_CELL_SIZE + DYING_CELL_SIZE / 2 + dy;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color + '1)';
      ctx.translate(px, py);
      ctx.rotate(p.spin * driftSec);
      const size = (DYING_CELL_SIZE - 1) * (1 - localT * 0.4);
      ctx.fillRect(-size / 2, -size / 2, size, size);
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
      ctx.fillText('BOSS DETECTED', W / 2, barY + 64);
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
      ctx.fillStyle = 'rgba(255,230,120,0.95)';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('WEAK', weakPointFlashAt.x, weakPointFlashAt.y - 22);
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
