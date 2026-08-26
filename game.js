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

  // ---------- Sprite loading ----------
  const DIRS = ['left', 'leftdiag', 'front', 'rightdiag', 'right'];
  const POSES = ['idle', 'aim', 'fire'];
  const sprites = {};
  let spritesReady = 0;
  const spritesTotal = DIRS.length * POSES.length;

  POSES.forEach((pose) => {
    sprites[pose] = {};
    DIRS.forEach((dir) => {
      const img = new Image();
      img.src = `assets/alexandre/${pose}_${dir}.png`;
      img.onload = () => { spritesReady++; };
      sprites[pose][dir] = img;
    });
  });

  // ---------- Player state ----------
  const player = {
    x: 0,
    y: 0,
    speed: 240, // px/sec
    facingAngle: 0, // radians, 0 = right, continuous
    facingDir: 'front', // discrete sprite bucket
    moving: false,
  };

  function resetPlayerPosition() {
    player.x = W / 2;
    player.y = H / 2;
  }
  resetPlayerPosition();

  const SPRITE_DRAW_H = 116; // on-screen character height in px (was 140, x0.83)
  let spriteAspect = 304 / 344;

  // The source reference sheet only mirrors the pure "left" column for the
  // IDLE pose; every other left-facing column (idle_leftdiag, and all of
  // aim/fire's left + leftdiag) is actually drawn facing right in the PNG
  // itself. For those keys we flip the canvas draw instead of the asset.
  const FLIP_FOR_LEFT = new Set(['idle_leftdiag', 'aim_left', 'aim_leftdiag', 'fire_left', 'fire_leftdiag']);
  // Fraction (0-1) of the sprite canvas width where each frame's own anchor
  // (body center of mass) sits — matches the alignment baked into the PNGs,
  // so flipping about this line keeps the character from jumping sideways.
  const SPRITE_ANCHOR_X_FRAC = 0.44167717269913337;

  // ---------- Direction bucket mapping ----------
  // angle: 0 = right, positive = clockwise (down), using atan2(dy, dx) with screen dy-down positive
  function angleToBucket(angle) {
    let deg = angle * 180 / Math.PI;
    // normalize to [-180, 180]
    deg = ((deg + 180) % 360 + 360) % 360 - 180;
    const a = Math.abs(deg);
    if (a <= 22.5) return 'right';
    if (a <= 67.5) return 'rightdiag'; // covers up-right and down-right (deg>0 is down here)
    if (a <= 112.5) return 'front'; // near-vertical (up or down)
    if (a <= 157.5) return 'leftdiag';
    return 'left';
  }

  // ---------- Virtual joystick ----------
  const stickZone = document.getElementById('stick-zone');
  const stickKnob = document.getElementById('stick-knob');
  let stickTouchId = null;
  let stickVec = { x: 0, y: 0 }; // normalized -1..1

  function stickReset() {
    stickTouchId = null;
    stickVec.x = 0;
    stickVec.y = 0;
    stickKnob.style.transform = 'translate(0px, 0px)';
  }

  function handleStickMove(clientX, clientY) {
    const rect = stickZone.getBoundingClientRect();
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
    stickVec.x = nx;
    stickVec.y = ny;
    stickKnob.style.transform = `translate(${nx * maxR * 0.7}px, ${ny * maxR * 0.7}px)`;
  }

  stickZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (stickTouchId !== null) return;
    const t = e.changedTouches[0];
    stickTouchId = t.identifier;
    handleStickMove(t.clientX, t.clientY);
  }, { passive: false });

  stickZone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === stickTouchId) {
        handleStickMove(t.clientX, t.clientY);
      }
    }
  }, { passive: false });

  function stickTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === stickTouchId) {
        stickReset();
      }
    }
  }
  stickZone.addEventListener('touchend', stickTouchEnd, { passive: false });
  stickZone.addEventListener('touchcancel', stickTouchEnd, { passive: false });

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

  // Prevent default touch scroll/zoom anywhere on the game UI
  document.addEventListener('touchmove', (e) => { e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturestart', (e) => { e.preventDefault(); });

  // ---------- Bullets ----------
  const bullets = [];
  const BULLET_SPEED = 620;
  const FIRE_INTERVAL = 170; // ms
  let lastFireTime = -Infinity;

  function spawnBullet() {
    const muzzleDist = SPRITE_DRAW_H * 0.46;
    const bx = player.x + Math.cos(player.facingAngle) * muzzleDist;
    const by = player.y + Math.sin(player.facingAngle) * muzzleDist;
    bullets.push({
      x: bx,
      y: by,
      vx: Math.cos(player.facingAngle) * BULLET_SPEED,
      vy: Math.sin(player.facingAngle) * BULLET_SPEED,
      born: performance.now(),
    });
    muzzleFlashUntil = performance.now() + 60;
    muzzleFlashX = bx;
    muzzleFlashY = by;
  }

  let muzzleFlashUntil = 0;
  let muzzleFlashX = 0, muzzleFlashY = 0;

  // ---------- Main loop ----------
  let lastTime = performance.now();

  function update(dt, now) {
    const kb = getKeyboardVec();
    let vx = stickVec.x + kb.x;
    let vy = stickVec.y + kb.y;
    const mag = Math.hypot(vx, vy);
    if (mag > 1) { vx /= mag; vy /= mag; }

    const moving = mag > 0.05;
    player.moving = moving;

    if (moving) {
      player.x += vx * player.speed * dt;
      player.y += vy * player.speed * dt;
      player.facingAngle = Math.atan2(vy, vx);
      player.facingDir = angleToBucket(player.facingAngle);
    }

    // Clamp to screen bounds (keep character fully visible)
    const halfW = (SPRITE_DRAW_H * spriteAspect) / 2;
    const halfH = SPRITE_DRAW_H / 2;
    player.x = Math.max(halfW, Math.min(W - halfW, player.x));
    player.y = Math.max(halfH, Math.min(H - halfH, player.y));

    // Firing
    const wantsFire = fireHeld || keys.fire;
    if (wantsFire && now - lastFireTime >= FIRE_INTERVAL) {
      lastFireTime = now;
      spawnBullet();
    }

    // Update bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) {
        bullets.splice(i, 1);
      }
    }
  }

  function currentPose(now) {
    const wantsFire = fireHeld || keys.fire;
    if (wantsFire || now - lastFireTime < 90) return 'fire';
    if (player.moving) return 'aim';
    return 'idle';
  }

  function draw(now) {
    ctx.clearRect(0, 0, W, H);

    // background
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

    // bullets
    ctx.fillStyle = '#ffcf6b';
    for (const b of bullets) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

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

    // player sprite
    const pose = currentPose(now);
    const dir = player.facingDir;
    const img = sprites[pose] && sprites[pose][dir];
    if (img && img.complete && img.naturalWidth > 0) {
      spriteAspect = img.naturalWidth / img.naturalHeight;
      const drawH = SPRITE_DRAW_H;
      const drawW = drawH * spriteAspect;
      const drawX = player.x - drawW / 2;
      const drawY = player.y - drawH / 2;
      const flip = (dir === 'left' || dir === 'leftdiag') && FLIP_FOR_LEFT.has(`${pose}_${dir}`);
      if (flip) {
        const anchorScreenX = drawX + drawW * SPRITE_ANCHOR_X_FRAC;
        ctx.save();
        ctx.translate(anchorScreenX, 0);
        ctx.scale(-1, 1);
        ctx.translate(-anchorScreenX, 0);
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        ctx.restore();
      } else {
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
      }
    } else {
      // fallback placeholder while sprites load
      ctx.fillStyle = '#888';
      ctx.fillRect(player.x - 20, player.y - 40, 40, 80);
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
