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
  const dashSprites = { right: new Image(), left: new Image() };
  dashSprites.right.src = 'assets/alexandre/right_dash.png';
  dashSprites.left.src = 'assets/alexandre/left_dash.png';
  const relaxedSprite = { down: new Image() };
  relaxedSprite.down.src = 'assets/alexandre/down_relaxed.png';

  // ---------- Boss sprite loading ----------
  // 10 pre-aligned frames (built offline from the 10 supplied renders via
  // alpha-crop + uniform rescale + foot-baseline/center-of-mass anchoring
  // onto one shared 700x920 canvas — see assets/boss/sprite_build_meta.json
  // for the exact per-frame measurements). No AI regeneration/redraw; only
  // crop/resize/pad/translate was applied to the original pixels.
  const BOSS_FRAME_NAMES = [
    'south_idle', 'east_idle', 'west_idle', 'north_idle', 'attack', 'defense',
    'walk_south_1', 'walk_south_2', 'walk_east', 'walk_west',
  ];
  const bossSprites = {};
  let bossSpritesReady = 0;
  BOSS_FRAME_NAMES.forEach((name) => {
    const img = new Image();
    img.src = `assets/boss/${name}.png`;
    img.onload = () => { bossSpritesReady++; };
    bossSprites[name] = img;
  });
  const BOSS_CANVAS_W = 700, BOSS_CANVAS_H = 920; // shared aligned canvas size
  const BOSS_DRAW_H = SPRITE_DRAW_H * 1.5; // ~1.5x player height
  const BOSS_DRAW_W = BOSS_DRAW_H * (BOSS_CANVAS_W / BOSS_CANVAS_H);

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

  // Screen-space meaning is fixed regardless of internal representation:
  // up=true up, right=true right, down=true down, left=true left.
  const BASE_ANGLE = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
  const HALF_RANGE = Math.PI / 4; // +-45 degrees (90-degree total aim wedge)

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
    aimOffset: 0,      // radians relative to BASE_ANGLE[baseDir], within +-HALF_RANGE
    moving: false,
    // DASH: horizontal-only burst move, independent of baseDir/aim.
    lastHorizontalDir: 'right', // 'right' | 'left' — last non-zero horizontal ACTION STICK input
    dashing: false,
    dashDir: 'right',
    dashStartAt: -Infinity,
    dashFromX: 0,
    dashDistance: 0,
    dashCooldownUntil: 0,
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

  function setBaseDir(dir) {
    if (dir === 'left' || dir === 'right') player.lastHorizontalDir = dir;
    if (dir === player.baseDir) return;
    player.baseDir = dir;
    // The base facing just changed — snap aim back to its center immediately
    // rather than carrying over an offset computed for the old direction.
    player.aimOffset = 0;
    aimStickKnob.style.transform = 'translate(0px, 0px)';
  }

  function clampPlayerToScreen() {
    const halfW = (SPRITE_DRAW_H * spriteAspect) / 2;
    const halfH = SPRITE_DRAW_H / 2;
    player.x = Math.max(halfW, Math.min(W - halfW, player.x));
    player.y = Math.max(halfH, Math.min(H - halfH, player.y));
  }

  // ---------- DASH (right/left only) ----------
  const DASH_DURATION_MS = 800;
  const DASH_COOLDOWN_MS = 1200;
  const DASH_DISTANCE_FRAC = 0.20; // 20% of screen width — within the 15-25% target
  const RELAXED_IDLE_DELAY_MS = 400;

  function tryStartDash(now) {
    if (player.dashing || now < player.dashCooldownUntil) return;
    // Direction priority per spec: current horizontal ACTION STICK bucket
    // if there is one, otherwise the last horizontal direction recorded —
    // NORTH/SOUTH facing never blocks a DASH.
    const dir = (player.baseDir === 'left' || player.baseDir === 'right')
      ? player.baseDir : player.lastHorizontalDir;
    player.dashing = true;
    player.dashDir = dir;
    player.dashStartAt = now;
    player.dashFromX = player.x;
    player.dashDistance = W * DASH_DISTANCE_FRAC;
    player.lastActivityAt = now;
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
      player.dashCooldownUntil = now + DASH_COOLDOWN_MS;
      return;
    }
    const progress = dashTravelProgress(elapsed / DASH_DURATION_MS);
    const sign = player.dashDir === 'right' ? 1 : -1;
    player.x = player.dashFromX + sign * player.dashDistance * progress;
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
  const BOSS_HP_MAX = 1000;
  const BOSS_SPEED = 130; // px/sec — slower than the player's 240
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
  const WALK_FRAME_PERIOD_MS = 260; // south 2-frame alternation period
  const NORTH_BOUNCE_AMPLITUDE = 4; // px, decorative only (no NORTH walk art)
  const PLAYER_HIT_RADIUS = 22;

  // Claw-projectile ranged attack, fired once per ATTACK cycle.
  const CLAW_PROJECTILE_SPEED = 340; // slower than the player's 620 bullets — dodgeable
  const CLAW_PROJECTILE_HIT_RADIUS = 14;

  // Weak point: the large red eye on the DEFENSE-pose mask, measured
  // directly on assets/boss/defense.png's 700x920 canvas (color-cluster
  // detection, centroid ~(344.6, 215.5), confirmed visually — see the
  // report for the marked-up crop). Converted to a boss-relative screen
  // offset using the same single uniform scale the sprite itself is drawn
  // with, so it tracks boss.x/boss.y and BOSS_DRAW_H exactly.
  const WEAKPOINT_CANVAS_X = 344.6, WEAKPOINT_CANVAS_Y = 215.5;
  const WEAKPOINT_HIT_RADIUS = 16; // screen px — generous for touch, still eye-only not head-wide

  const DIR_TO_BOSS_KEY = { up: 'north', down: 'south', left: 'west', right: 'east' };

  const boss = {
    x: 0, y: 0,
    spawned: false,
    state: 'inactive', // inactive | chase | attack | defense | recover | dead
    dir: 'down', // shared player-style bucket key; mapped to north/south/east/west for assets
    moving: false,
    hp: BOSS_HP_MAX,
    stateEnteredAt: 0,
    attackHitApplied: false,
    attackProjectileSpawned: false,
    chaseBackoffUntil: 0,
    deadAt: 0,
    warningUntil: 0,
  };

  function bossEnterState(state, now) {
    boss.state = state;
    boss.stateEnteredAt = now;
    if (state === 'attack') {
      boss.attackHitApplied = false;
      boss.attackProjectileSpawned = false;
    }
  }

  function spawnBoss(now) {
    boss.x = W / 2;
    boss.y = Math.max(BOSS_DRAW_H * 0.55, H * 0.16); // appear near the top
    boss.spawned = true;
    boss.hp = BOSS_HP_MAX;
    boss.dir = 'down';
    boss.moving = false;
    boss.warningUntil = now + 1500;
    bossEnterState('chase', now);
  }

  function getWeakPointScreenPos() {
    const scale = BOSS_DRAW_H / BOSS_CANVAS_H; // uniform scale, aspect preserved
    return {
      x: boss.x + (WEAKPOINT_CANVAS_X - BOSS_CANVAS_W / 2) * scale,
      y: boss.y + (WEAKPOINT_CANVAS_Y - BOSS_CANVAS_H / 2) * scale,
    };
  }

  let bossBlockFlashUntil = 0;
  let weakPointFlashUntil = 0;
  let weakPointFlashAt = { x: 0, y: 0 };

  // A shot landing on the body/wings/claws/mask while the boss is NOT
  // already defending applies normal damage once, then instantly forces
  // DEFENSE — sustained fire can never freely melt the body hurtbox.
  // While already in DEFENSE, body hits are fully blocked (0 damage, not
  // reduced); only applyWeakPointHitToBoss() can still hurt it.
  function applyBodyHitToBoss(now) {
    if (!boss.spawned || boss.state === 'dead') return;
    if (boss.state === 'defense') {
      bossBlockFlashUntil = now + 120;
      return;
    }
    boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
    if (boss.hp <= 0) {
      boss.state = 'dead';
      boss.deadAt = now;
      return;
    }
    bossEnterState('defense', now);
  }

  function applyWeakPointHitToBoss(now) {
    if (!boss.spawned || boss.state !== 'defense') return;
    boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
    weakPointFlashUntil = now + 220;
    const wp = getWeakPointScreenPos();
    weakPointFlashAt = wp;
    if (boss.hp <= 0) {
      boss.state = 'dead';
      boss.deadAt = now;
    }
  }

  function updateBoss(dt, now) {
    if (!boss.spawned) {
      if (now - gameStartTime >= BOSS_SPAWN_DELAY_MS) spawnBoss(now);
      return;
    }
    if (boss.state === 'dead') return;
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

  // ---------- Boss claw projectile (ranged ATTACK payload) ----------
  // Fired once per ATTACK cycle, aimed at the player's position at the
  // exact instant it spawns — no homing, trajectory is fixed forever after.
  const clawProjectiles = [];

  function spawnClawProjectile(now) {
    const facing = BASE_ANGLE[boss.dir];
    // Spawn near the claw: a forward offset from boss center, roughly
    // where the melee hitbox also sits.
    const sx = boss.x + Math.cos(facing) * (BOSS_DRAW_W * 0.32);
    const sy = boss.y + Math.sin(facing) * (BOSS_DRAW_W * 0.32);
    const angle = Math.atan2(player.y - sy, player.x - sx);
    clawProjectiles.push({
      x: sx, y: sy,
      vx: Math.cos(angle) * CLAW_PROJECTILE_SPEED,
      vy: Math.sin(angle) * CLAW_PROJECTILE_SPEED,
      angle,
    });
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
  function drawClawProjectile(p) {
    const len = 26, halfW = 4;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    const grad = ctx.createLinearGradient(-len * 0.9, 0, len * 0.5, 0);
    grad.addColorStop(0, 'rgba(30,30,34,0)');
    grad.addColorStop(0.45, 'rgba(95,98,108,0.6)');
    grad.addColorStop(1, 'rgba(230,232,238,0.95)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(len * 0.5, 0);
    ctx.lineTo(len * 0.05, -halfW);
    ctx.lineTo(-len * 0.9, -halfW * 0.25);
    ctx.lineTo(-len * 0.9, halfW * 0.25);
    ctx.lineTo(len * 0.05, halfW);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(15,15,18,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

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
    player.aimOffset = clampToHalfRange(rawAngle, center);

    // Knob visually stops at the same +-45 deg wall as the actual aim,
    // so the limit is felt physically, not just applied invisibly.
    const clampedAngle = center + player.aimOffset;
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
  fireButton.addEventListener('touchstart', fireStart, { passive: false });
  fireButton.addEventListener('touchend', fireEnd, { passive: false });
  fireButton.addEventListener('touchcancel', fireEnd, { passive: false });
  fireButton.addEventListener('mousedown', fireStart);
  window.addEventListener('mouseup', fireEnd);

  // ---------- DASH button ----------
  // A separate DOM element from FIRE, so a distinct touch on it never
  // collides with FIRE's own touch identifier — same independent-zone
  // pattern already used for ACTION STICK / AIM STICK / FIRE.
  const dashButton = document.getElementById('dash-button');

  function dashPress(e) {
    e.preventDefault();
    dashButton.classList.add('active');
    tryStartDash(performance.now());
  }
  function dashRelease(e) {
    if (e) e.preventDefault();
    dashButton.classList.remove('active');
  }
  dashButton.addEventListener('touchstart', dashPress, { passive: false });
  dashButton.addEventListener('touchend', dashRelease, { passive: false });
  dashButton.addEventListener('touchcancel', dashRelease, { passive: false });
  dashButton.addEventListener('mousedown', dashPress);
  window.addEventListener('mouseup', dashRelease);

  function updateDashButtonUI(now) {
    const dir = (player.baseDir === 'left' || player.baseDir === 'right')
      ? player.baseDir : player.lastHorizontalDir;
    dashButton.textContent = dir === 'right' ? 'DASH ▶' : '◀ DASH';
    const onCooldown = player.dashing || now < player.dashCooldownUntil;
    dashButton.classList.toggle('cooldown', onCooldown);
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
    });
    muzzleFlashUntil = performance.now() + 60;
    muzzleFlashX = bx;
    muzzleFlashY = by;
  }

  let muzzleFlashUntil = 0;
  let muzzleFlashX = 0, muzzleFlashY = 0;
  let playerHitFlashUntil = 0;

  // Exposed for Playwright/manual verification only — not part of gameplay.
  window.__game = {
    player, boss, playerHitCount: 0,
    applyBodyHitToBoss, applyWeakPointHitToBoss, bossEnterState,
    getWeakPointScreenPos, clawProjectiles,
  };

  // ---------- Main loop ----------
  const gameStartTime = performance.now();
  let lastTime = gameStartTime;

  function update(dt, now) {
    const kb = getKeyboardVec();
    let vx = actionStickVec.x + kb.x;
    let vy = actionStickVec.y + kb.y;
    const mag = Math.hypot(vx, vy);
    if (mag > 1) { vx /= mag; vy /= mag; }

    const moving = mag > 0.05;
    if (moving) {
      const moveAngle = Math.atan2(vy, vx);
      setBaseDir(angleToBucket(moveAngle));
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

    // Update bullets — weak point is checked first (only matters while
    // boss.state === 'defense'), body hurtbox otherwise.
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) {
        bullets.splice(i, 1);
        continue;
      }
      if (!boss.spawned || boss.state === 'dead') continue;
      if (boss.state === 'defense') {
        const wp = getWeakPointScreenPos();
        if (Math.hypot(b.x - wp.x, b.y - wp.y) <= WEAKPOINT_HIT_RADIUS) {
          applyWeakPointHitToBoss(now);
          bullets.splice(i, 1);
          continue;
        }
      }
      if (Math.hypot(b.x - boss.x, b.y - boss.y) <= BOSS_HURT_RADIUS) {
        applyBodyHitToBoss(now);
        bullets.splice(i, 1);
      }
    }

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
  // Replaces the old plain filled dot.
  function drawReticle(x, y) {
    const r = 7;
    const gap = 2;
    const tick = 4;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
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

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
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
    const lineLen = 240;
    const ex = bx + Math.cos(angle) * lineLen;
    const ey = by + Math.sin(angle) * lineLen;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    drawReticle(ex, ey);
  }

  function draw(now) {
    ctx.clearRect(0, 0, W, H);

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

    drawAimLine();

    // bullets
    for (const b of bullets) drawBullet(b);

    // muzzle flash
    if (now < muzzleFlashUntil) {
      ctx.save();
      ctx.translate(muzzleFlashX, muzzleFlashY);
      ctx.fillStyle = 'rgba(255, 210, 120, 0.9)';
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

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

    drawBossHud(now);
    drawBossFeedback(now);

    if (now < playerHitFlashUntil) {
      ctx.fillStyle = 'rgba(220, 30, 30, 0.18)';
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawPlayer(now) {
    let img;
    if (player.dashing) {
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
    if (boss.state === 'attack') return 'attack';
    if (boss.state === 'defense') return 'defense';
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
    if (boss.state === 'dead') {
      const fadeMs = 1200;
      const t = now - boss.deadAt;
      if (t > fadeMs) return;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / fadeMs);
      const img = bossSprites[DIR_TO_BOSS_KEY[boss.dir] + '_idle'] || bossSprites.south_idle;
      if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, boss.x - BOSS_DRAW_W / 2, boss.y - BOSS_DRAW_H / 2, BOSS_DRAW_W, BOSS_DRAW_H);
      }
      ctx.restore();
      return;
    }

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

  function drawBossHud(now) {
    if (!boss.spawned) return;
    // Simple top-of-screen HP bar; kept clear of the bottom-anchored
    // ACTION/AIM/FIRE controls entirely, so it never overlaps existing UI.
    const barW = Math.min(320, W * 0.7);
    const barH = 14;
    const barX = (W - barW) / 2;
    const barY = Math.max(10, (H * 0.03));
    const pct = Math.max(0, boss.hp / BOSS_HP_MAX);

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(barX - 3, barY - 3, barW + 6, barH + 6);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = boss.state === 'defense' ? 'rgba(120,180,255,0.9)' : 'rgba(220,40,40,0.9)';
    ctx.fillRect(barX, barY, barW * pct, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(barX, barY, barW, barH);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BOSS', W / 2, barY - 6);
    ctx.restore();

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

  // Small, non-intrusive combat feedback: a blocked-hit spark on the body
  // during DEFENSE, and a brighter flash + "WEAK" label right on the eye
  // when the weak point is actually hit.
  function drawBossFeedback(now) {
    if (!boss.spawned) return;
    if (now < bossBlockFlashUntil) {
      ctx.save();
      ctx.fillStyle = 'rgba(140,190,255,0.5)';
      ctx.beginPath();
      ctx.arc(boss.x, boss.y, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
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
  }

  function loop(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    update(dt, now);
    draw(now);
    requestAnimationFrame(loop);
  }

  requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });
})();
