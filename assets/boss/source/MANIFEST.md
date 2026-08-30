# Boss character asset manifest — all 27 source images (batch 1 + batch 2 + batch 3 + batch 4 + batch 5 + batch 6 + batch 7 + batch 8 + batch 9 + batch 10 + batch 11 + batch 12) plus batch 13/14/15/16/17's replacement/addition images (tracked in their own build-meta JSON files, listed inline below)

All 27 files below are byte-identical copies of the originally attached
images (verified by md5) — no crop/resize/flip/regeneration applied to
these `source/` copies. The processed, game-ready frames built from them
live in `assets/boss/*.png` (see `assets/boss/sprite_build_meta.json` for
batches 1-2's exact per-frame alignment measurements,
`assets/boss/defense_dirs_build_meta.json` for batch 3's,
`assets/boss/attack_ns_build_meta.json` for batch 5's,
`assets/boss/attack_release_build_meta.json` for batch 6's,
`assets/boss/attack_south_v2_build_meta.json` for batch 8's (now
superseded — see batch 9), `assets/boss/attack_south_release_build_meta.json`
for batch 9's, and the ARC CLAW SLASH notes below for batch 7's).

## Batch 1 (5 images)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 1 | SOUTH / 南向き IDLE | `boss_south_idle_source.png` | 1546x2176 RGBA | 1823695df459c4fb6f6f5a5730b52265 |
| 2 | EAST / 東向き IDLE | `boss_east_idle_source.png` | 1546x2176 RGBA | fa9589ee1b62866a96286d9d985cf8ef |
| 3 | WEST / 西向き IDLE | `boss_west_idle_source.png` | 1546x2176 RGBA | 4606567abbb9febb779fdba25ce255c9 |
| 4 | NORTH / 北向き IDLE (背面) | `boss_north_idle_source.png` | 1546x2176 RGBA | 7e6732036599a1f33640a87373105f7c |
| 5 | ATTACK / 攻撃の構え | `boss_attack_source.png` | 1546x2176 RGBA | 07eec6a845f164dd7512fe2ba7259a42 |

## Batch 2 (5 images)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 6 | DEFENSE / 防御の構え | `boss_defense_source.png` | 1546x2176 RGBA | c100a1114dbbf104857353b0bcd0c461 |
| 7 | SOUTH / 南向き WALK 1 | `boss_walk_south_1_source.png` | 1200x1800 RGBA | 3e794b2f33421775e188def2b08cde6b |
| 8 | SOUTH / 南向き WALK 2 | `boss_walk_south_2_source.png` | 1200x1800 RGBA | 2f5a357d1e9e218b148c65e38839c302 |
| 9 | EAST / 東向き WALK | `boss_walk_east_source.png` | 1200x1800 RGBA | c780019b532af08043901aec26ecc696 |
| 10 | WEST / 西向き WALK | `boss_walk_west_source.png` | 1200x1800 RGBA | 213bd86b9d1d8d1ee1637c3fd9c0d620 |

## Batch 3 (3 images)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 11 | NORTH / 北向き DEFENSE (背面・防御) | `boss_defense_north_source.jpg` | 944x2080 RGB | d7848a0214edd764e28aa791f293edfd |
| 12 | EAST / 東向き DEFENSE | `boss_defense_east_source.jpg` | 1008x1792 RGB | 30b030e8d333b8fd28e9bee5fddebcd4 |
| 13 | WEST / 西向き DEFENSE | `boss_defense_west_source.jpg` | 1008x1792 RGB | 566f1f744974511dd858b146deead047 |

Batch 3 notes:
- These are JPG photos (not pre-transparent PNGs like batches 1-2) on a
  dark, non-solid gradient background; the character itself is also very
  dark, so a simple color-threshold chroma key would misclassify large
  parts of both. Alpha was extracted via Sobel-gradient-magnitude +
  local-value-tolerance flood-fill from the image borders (treats smoothly
  connected low-variance regions as background regardless of absolute
  brightness, since the character's armor carries visible surface-texture/
  panel-line variance the smooth vignette lacks), followed by
  `scipy.ndimage.label` connected-component filtering to keep only the
  single largest region — this removed JPEG-noise specks and a connected
  ground-shadow blob that the flood-fill alone had left attached, cleanly
  isolating the character (confirmed via green-background composite
  checks before and after).
- Verified visually which photo is EAST vs WEST (not assumed from
  attachment order) by inspecting wing/claw orientation, matching each to
  the existing EAST/WEST idle and walk conventions already used for this
  boss.
- NORTH shows the boss's back — no face/eye is visible in the source photo
  at all — confirmed by direct visual inspection of a zoomed head-region
  crop (only a smooth dome and vein-crack surface detail, no eye), which
  is why `defense_north` has no weak point defined in `game.js`
  (`WEAKPOINT_OFFSETS.north === null`), consistent with the "no
  generative completion" rule: rather than invent a plausible eye
  position, the direction is simply left without one.
- All 3 outputs were scaled to match the existing `defense.png` (south)'s
  own measured on-canvas bbox height (872px) and anchored at the same
  (centerX=350, footY=900) point on the shared 700x920 boss canvas used by
  every other boss frame, so switching between DEFENSE directions in-game
  causes no body-size or foot-position jump. See
  `assets/boss/defense_dirs_build_meta.json` for exact per-image
  source-bbox/scale/paste-offset values.

## Batch 4 (1 image)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 14 | CINEMATIC POSE / 演出専用ポーズ | `boss_cinematic_source.png` | 1190x1317 RGBA | 2747f079707d3829a6ba1e803228abb0 |

Batch 4 notes:
- Used for the intro cinematic (BOSS MODE start), the 30/60/90%-cumulative-
  damage HP-threshold reactions, and the death/dissolve sequence ONLY —
  never as a normal IDLE/WALK/ATTACK/DEFENSE movement frame.
- Already had real per-pixel alpha with its opaque bbox spanning almost
  the entire source canvas (x:1-1187 of 1190, y:3-1314 of 1317), so it was
  saved to `assets/boss/cinematic_pose.png` as a byte-identical copy with
  no cropping needed at all — the only non-generative processing applied
  anywhere is the runtime scale-to-height done in `game.js`
  (`CINEMATIC_SCALE = 1.1`, i.e. ~1.1x the normal boss's on-screen height,
  within the requested 1.0-1.2x band), keeping its own aspect ratio rather
  than forcing it onto the narrower 700x920 movement-sprite canvas (its
  wingspan is wide enough that doing so would clip it).

## Batch 5 (2 images)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 15 | SOUTH ATTACK | `boss_attack_south_source.png` | 1213x1944 RGBA | b6154a4444f5a172a265825991c9124f |
| 16 | NORTH ATTACK | `boss_attack_north_source.png` | 1182x1774 RGBA | d0f70ab0fa2677ebbfaad8ac7da97bb7 |

Batch 5 notes:
- SOUTH ATTACK replaces the generic `attack.png` for the SOUTH facing only
  — `attack.png` itself is untouched on disk and still used as-is for
  EAST/WEST (no dedicated art exists for those directions). NORTH ATTACK
  is a wholly new direction; no NORTH attack art existed before this
  batch, and it was never derived from SOUTH by flipping — both are
  independent renders used exactly as supplied.
- Both already had real per-pixel alpha with the opaque bbox spanning
  almost the entire source canvas, so only a uniform rescale + anchor-paste
  (no crop) was needed. Built onto the same shared 700x920 boss canvas at
  the same (centerX=350, footY=900) anchor and the same 873px target body
  height used by every other frame on that canvas (measured directly off
  the existing `attack.png`/`defense.png`), so switching into/out of
  ATTACK from either direction causes no body-size or foot-position jump.
  See `assets/boss/attack_ns_build_meta.json` for the exact per-image
  source-bbox/scale/paste-offset values.
- ATTACK direction is selected from `boss.dir` (already computed toward
  the player at the exact instant ATTACK begins, via the existing CHASE->
  ATTACK and GUARD BREAK->ATTACK transitions) — up->NORTH ATTACK,
  down->SOUTH ATTACK, left/right unchanged (generic `attack.png`).

## Batch 6 (3 images)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 17 | SOUTH ATTACK (blade-release) | `boss_attack_south_release_source.png` | 1076x1866 RGBA | 13fca4f73ee112b37ed6d8c5df90703e |
| 18 | WEST ATTACK (blade-release) | `boss_attack_west_release_source.png` | 1156x1795 RGBA | dbb3c8ae2e96f748d947fa44c5d3b598 |
| 19 | EAST ATTACK (blade-release) | `boss_attack_east_release_source.png` | 1242x1654 RGBA | 15fc4f61babb4df3e4275d69ab664f73 |

Batch 6 notes:
- Direction labels were taken as authoritative from the user's explicit
  instruction, not inferred from the images' own visual content or
  filename conventions: the user stated outright which attached image is
  WEST and which is EAST, overriding any visual read of left/right facing.
- These 3 images are the NEW dedicated blade-release ATTACK art for SOUTH/
  EAST/WEST. The previously-active attack art for those directions —
  `boss_attack_south_source.png` (batch 5, was `attack_south.png`) for
  SOUTH, and the old generic `attack.png` for EAST/WEST — was NOT deleted
  or replaced; it was repurposed as the new PRE_ATTACK (wind-up) pose for
  those same 3 directions (`preattack_south`/`preattack_east`/
  `preattack_west` in `game.js`, drawn at 113% scale). NORTH keeps its
  own single-image attack (`boss_attack_north_source.png`, batch 5)
  entirely unchanged — it has no PRE_ATTACK phase.
- All 3 already had real per-pixel alpha with the opaque bbox spanning
  almost the entire source canvas, so only a uniform rescale + anchor-paste
  (no crop) was needed onto the same shared 700x920 boss canvas, at the
  same (centerX=350, footY=900) anchor and the same 873px target body
  height used by every other frame on that canvas — comparing actual
  character bounding boxes (head/shoulders/torso/waist/legs), not raw
  pixel dimensions — so switching PRE_ATTACK -> ATTACK causes no
  body-size or foot-position jump. See
  `assets/boss/attack_release_build_meta.json` for the exact per-image
  source-bbox/scale/paste-offset values (scale 0.4691/0.4874/0.5294 for
  south/west/east respectively; no horizontal clamping needed for any).

## Batch 7 (1 image)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 20 | ARC CLAW SLASH projectile | `arc_claw_slash_source.png` | 1249x1337 RGBA | 3d0102334214be0b98b7f830e9903f92 |

Batch 7 notes:
- This one is NOT part of the shared 700x920 boss-body canvas used by every
  frame above — it's a standalone projectile/attack-effect sprite, drawn
  and rotated independently at its own aspect ratio (see the "ARC CLAW
  SLASH" section of `game.js`).
- The source file already arrived with real per-pixel alpha (soft
  anti-aliased edges, not a hard cutout) — the white background was
  already keyed out, with the silver claw, its highlights, and the
  speed-line brush strokes all still intact. Verified by compositing the
  untouched source over both a solid green and a solid black test
  background before adoption (no leftover white fringing/haloing at the
  edges, no accidental holes punched through the highlights or speed
  lines). No additional color-key/background-removal step was applied on
  top of that.
- The only processing applied for the game-ready file
  (`assets/boss/attacks/arc_claw_slash.png`, 1246x1334) was a crop of the
  ~2px fully-transparent margin down to the opaque content's own bounding
  box — measured directly off the alpha channel: (2,3)-(1247,1336) of the
  1249x1337 source canvas.
- The claw-tip <-> wrist/base direction (needed at runtime to line the
  sprite's own rotation up with its current direction of travel) was
  measured objectively via PCA of the cropped image's opaque-pixel mask
  (the long axis of the elongated claw+speed-line silhouette), not by eye:
  ~135.19deg at zero canvas rotation, ~44.81deg after a horizontal mirror
  (used for the slash's counter-clockwise variant, since only one hand
  orientation exists in the source art).
- Status: ACTIVE (this image IS the ARC CLAW SLASH attack body). Batch 8
  temporarily switched the attack's rendering to a procedural Canvas-VFX-only
  crescent and stopped referencing this file; batch 9 restored the
  image-based rendering (per explicit user instruction that the claw image
  itself must be the attack's real body, with the crescent kept only as an
  auxiliary trail effect) using this exact same already-cropped file and the
  PCA orientation constants above, unchanged. See batch 9 notes below.

## Batch 8 (1 image, reused for two roles)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 21 | SOUTH ATTACK v2 (release) + CINEMATIC POSE v2 | `attack_south_v2_source.png` | 1176x1636 RGBA | ab5149a53f450865723103600718e217 |

Batch 8 notes:
- One newly attached image, explicitly reused by the user's instruction for
  two separate roles: the new SOUTH ATTACK (blade-release) pose AND the new
  CINEMATIC POSE. Both game-ready outputs below are built from the same
  byte-identical source (verified by md5); the source copy is kept once, in
  `attack_south_v2_source.png`, rather than duplicated under two filenames.
- **SOUTH ATTACK v2** → `assets/boss/attack_south_release.png` (replaced the
  batch-6 SOUTH release art at the time). Built onto the
  shared 700x920 boss canvas, anchored at (350,900), scale 0.55, paste
  offset (25,2) — measured from body landmarks (head-top y=284, feet-bottom
  y=1633, center_x=592 on the 1176x1636 source), not raw bbox height, since
  the fully-spread wingtips inflate the raw bbox well past the actual body
  extent. Fitting the complete image with zero clipping at this scale
  produces a body height on canvas of ~742px, a bit under the shared 873px
  convention; `SOUTH_ATTACK_SCALE = 1.1766` in `game.js` applied the same
  bottom-anchored render-time multiplier pattern already used by
  `SOUTH_WALK_SCALE`/`PRE_ATTACK_SCALE`/`NORTH_IDLE_SCALE` to restore the
  on-screen body size to match every other direction, with no jump when
  entering/leaving ATTACK. Full measurements in
  `assets/boss/attack_south_v2_build_meta.json`.
  **Status: SUPERSEDED.** This same photograph is also what
  `cinematic_pose.png` uses (see below), so SOUTH ATTACK and the CINEMATIC
  POSE ended up visually reading as "the same picture" — the user flagged
  this as SOUTH ATTACK appearing to show the CINEMATIC image. Batch 9
  replaced `attack_south_release.png` with a genuinely different supplied
  photograph dedicated to SOUTH ATTACK only; this batch-8 build is left on
  disk (build meta + this note) purely as history, not deleted, per this
  project's asset-retirement convention. See batch 9 below.
- SOUTH's PRE_ATTACK phase was removed entirely per this batch's spec (SOUTH
  is now the only direction that still telegraphs, and it does so by
  reusing this same new release-moment image at its own scale/timing rather
  than a distinct wind-up pose — no separate PRE_ATTACK art exists for
  SOUTH any more). EAST/WEST no longer telegraph at all (their PRE_ATTACK
  phase and batch-6 wind-up art usage were removed from `game.js`
  entirely — ATTACK fires immediately for both).
- **CINEMATIC POSE v2** → `assets/boss/cinematic_pose.png` (replaces the
  batch-4 image; the batch-4 file is no longer used in-game). Same
  byte-identical copy, no cropping needed (matching the batch-4 precedent —
  this source, too, already has real per-pixel alpha spanning nearly the
  full canvas). `CINEMATIC_ASPECT` updated to this image's own 1176/1636
  ratio; `CINEMATIC_SCALE` retuned from 0.77 to 0.90 of the normal boss's
  own on-screen draw height (`BOSS_DRAW_H`), landing in the requested
  85-95% band and confirmed via Playwright screenshot comparison against
  the normal IDLE/ATTACK sprite at the same on-screen position. The same
  scale is used uniformly for every cinematic event (first appearance,
  30/60/90% HP thresholds, and death) — there was never any per-event
  scale variation in the code to begin with.
- **Retired at the time (later reinstated — see batch 9): `assets/boss/
  attacks/arc_claw_slash.png`** (batch 7) and its source copy. ARC CLAW
  SLASH's rendering was reworked from an image sprite to a procedural Canvas
  VFX crescent (two mirrored quadratic Bézier curves with a silver-to-white
  gradient fill) per this batch's explicit "no new image generation — use
  Canvas VFX" instruction. The files were left on disk (not deleted) per
  this project's asset-retirement convention, which is exactly why batch 9
  could bring them straight back into active use with no reprocessing.

## Batch 9 (1 image)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 22 | SOUTH ATTACK v3 (final) | `attack_south_release_source.png` | 1377x2378 RGBA | 7a8fee2727bbc6a0155cba2b055ccfca |

Batch 9 notes:
- Two images were attached this batch: the 1st (md5
  `3d0102334214be0b98b7f830e9903f92`) is byte-identical to the EXISTING
  batch-7 `arc_claw_slash_source.png` — i.e. the same claw art already on
  disk, re-supplied to confirm/re-authorize its use as the ARC CLAW SLASH
  attack body (see batch 7's "Status: ACTIVE" note above; no new file was
  saved for it, no reprocessing needed). The 2nd (this row) is a genuinely
  new photograph, used exclusively for SOUTH ATTACK.
- **Root cause of the "SOUTH ATTACK shows the CINEMATIC POSE image" report:**
  not a code-level asset mix-up — `attack_south_release.png` and
  `cinematic_pose.png` were always two separate files loaded through two
  separate `Image` objects/keys (`BOSS_FRAME_FILES.attack_south_release` vs
  `cinematicPoseImg.src`), never cross-referenced anywhere in `game.js`.
  The actual cause was a content choice in the previous batch: both roles
  were built from the SAME single attached photograph (batch 8's
  `attack_south_v2_source.png`, reused for both per that batch's own explicit
  instruction), so the two frames depicted visually near-identical artwork —
  reasonably read by the user as "the same picture showing up in both
  places." This batch fixes it at the content level: SOUTH ATTACK now uses
  its own dedicated photograph (this row), while `cinematic_pose.png` keeps
  the batch-8 image untouched, unmodified, and exclusively for the
  intro/milestone/death cinematic roles.
- Real per-pixel alpha, opaque bbox spans nearly the entire 1377x2378 source
  canvas (x:1-1373, y:5-2374). Body landmarks measured directly off the
  alpha channel (head band restricted to x:430-640 to exclude the raised
  claw arm and the wings): head_top_y=268, feet_bottom_y=2374 (the lowest
  opaque pixel overall, a foot claw tip), center_x≈557.7 (head/torso
  centroid, x:430-640 band, y:268-450).
- Built onto the same shared 700x920 boss canvas, anchor (350,900): unlike
  earlier attack batches, the BINDING constraint here was canvas HEIGHT, not
  width — this pose's full bbox (wingtip to lowest claw, 2369px tall in the
  source) is proportionally taller relative to its own body than earlier
  renders, so fitting it with zero clipping required scale=0.378 rather than
  a width-limited scale. paste_xy=(139,3). Resulting landmark (head-to-feet)
  body height on canvas: ~796px — already close to SOUTH_WALK's own
  effective on-screen size, which is why `SOUTH_ATTACK_SCALE` only needed a
  modest independent value (1.10, matching `SOUTH_WALK_SCALE`, and NOT
  shared with `CINEMATIC_SCALE`) to read as the same size as SOUTH IDLE/WALK
  rather than the older ~873px attack-frame convention (confirmed via
  Playwright screenshot: SOUTH IDLE / SOUTH WALK / SOUTH ATTACK / CINEMATIC
  all crop to essentially the same on-screen footprint at the same anchor
  point, with SOUTH ATTACK reading neither oversized nor undersized).
  `preattack_south` (SOUTH's own telegraph pose) reuses this same file with
  its own `PRE_ATTACK_SCALE`, likewise retuned to 1.10 to match. Full
  measurements in `assets/boss/attack_south_release_build_meta.json`.

## Batch 10 (1 image)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 23 | DOWN/CINEMATIC — back-facing (NORTH/EAST/WEST) | `cinematic_pose_back_source.png` | 1314x1692 RGBA | 6107883f729c3756a5bcfe4568d01125 |

Batch 10 notes:
- User-supplied as "IMG_4691.jpeg"; the actual uploaded bytes are a PNG
  (RGBA), so both the source archive copy and the game-ready file were
  saved with a `.png` extension rather than relabeling the real format —
  content is otherwise a byte-identical, unmodified copy of what was
  attached (verified by md5).
- **Role, strictly scoped**: used ONLY when GABRIEL enters a DOWN/CINEMATIC
  sequence (intro, 30/60/90% HP milestones, DYING, or FLASH GRENADE's
  FLASH DOWN) while facing anything other than SOUTH. It is NEVER used for
  normal IDLE/WALK/ATTACK/DEFENSE. SOUTH-facing DOWN continues to use the
  existing front image (`cinematic_pose.png`, batch 8) unchanged.
  `boss.downFacing` is captured exactly once, at the moment each such
  sequence begins (`startBossThreshold()`/`startBossDying()`/
  `startBossFlashDown()`; a fresh boss spawn/intro defaults it to
  `'south'`), and never re-evaluated mid-sequence even if `boss.dir`
  changes underneath it — see `getCinematicImageInfo()` in `game.js`.
- Game-ready file `assets/boss/cinematic_pose_back.png` is a byte-identical
  copy, no cropping needed (its opaque bbox already spans nearly the whole
  1314x1692 canvas: x:2-1310, y:4-1688) — same precedent as the front
  CINEMATIC image never needing a crop either. Drawn at its own aspect
  ratio, never forced onto the shared 700x920 movement-sprite canvas.
- Body landmarks measured off the alpha channel (head band x:520-680 to
  exclude the wing and trailing claw arm): head_top_y=351,
  feet_bottom_y=1688 (lowest opaque pixel overall, a foot), center_x≈597.4.
- **Size-matched to the front image, not just canvas-height-matched**: the
  front and back photographs fill very different fractions of their own
  canvases (front body spans 82.5% of its canvas height; back spans 79.0%
  of its own), so `game.js` derives `CINEMATIC_BACK_SCALE` from
  `CINEMATIC_SCALE * (frontBodyFrac / backBodyFrac)` rather than reusing
  `CINEMATIC_SCALE` directly — this is what makes the two images' ACTUAL
  body heights match on screen. `CINEMATIC_FRONT_OFFSET_X/Y` are 0 (the
  front image's own existing, already-shipped anchor is the baseline);
  `CINEMATIC_BACK_OFFSET_X/Y` are computed from the two images' own
  center_x/feet_bottom_y fractions so the back image's body landmark lands
  at the exact same on-screen position the front image's would — no
  foot-position or left/right jump when the DOWN facing switches between
  front and back. Confirmed via Playwright screenshot: SOUTH/NORTH/EAST/
  WEST DOWN all crop to the same on-screen footprint at the same anchor.
  Full measurements in `assets/boss/cinematic_pose_back_build_meta.json`.

Batch 11 — DARK PHASE silhouette (`dark_phase.png`):
- Source: a single new attached render (black GABRIEL silhouette, glowing
  red eyes, white background), canvas 1152x1728. Raw upload preserved
  byte-for-byte at `assets/boss/source/dark_phase_source.png` (verified via
  md5, not a PIL re-save, to avoid any recompression drift).
- Used EXCLUSIVELY as GABRIEL's DARK PHASE combat sprite — never mixed
  into IDLE/WALK/ATTACK/DEFENSE, and never mixed into the separate front/
  back DOWN/CINEMATIC pair above.
- **Cleanup — non-generative alpha reconstruction, no AI redraw**: the
  supplied alpha channel was a hard binary 0/255 mask produced by a naive
  white-threshold on a flattened white-background render, so many opaque
  edge pixels kept a light/gray blended-toward-white RGB color, reading as
  a visible white/gray fringe or halo once composited over anything but
  white (0.36% of nominally-opaque pixels had brightness > 200,
  concentrated along the wing/claw edges). Fixed with a deterministic
  per-pixel formula (no manual retouching, no synthesized content):
  redness = R - max(G,B); pixels with redness > 15 (the glowing eyes) kept
  fully opaque with original RGB untouched. All other originally-opaque
  pixels are treated as a black-foreground/white-background blend and
  inverted: recovered alpha = clamp(255 - brightness, 0, 255), RGB forced
  to (0,0,0) — mathematically the inverse of a black-on-white blend, so a
  near-white fringe pixel correctly resolves to near-0 alpha instead of a
  light gray rim, and a genuine antialiased edge grades smoothly to
  transparent black instead of showing a white cutout line. Originally
  fully-transparent pixels are zeroed regardless of stray RGB. Verified by
  compositing over solid dark navy/magenta/mid-gray test backgrounds and
  visually confirming zero white/gray fringe anywhere, including the many
  small wing-feather/claw tips, with the red eye glow fully preserved.
  Full method + verification notes: `assets/boss/dark_phase_build_meta.json`.
- Body landmarks (alpha-channel scan of the cleaned image, head band
  x:540-660 matching the red-eye bbox 557-646 with margin for
  head_top_y/center_x; feet_bottom_y is the lowest opaque row overall):
  head_top_y=231, feet_bottom_y=1654, center_x≈603.9.
- **Size-matched to the front CINEMATIC image's own body-fill fraction**
  (same method as `CINEMATIC_BACK_SCALE`): `DARKPHASE_SCALE = CINEMATIC_SCALE
  * (CINEMATIC_FRONT_BODY_FRAC / DARKPHASE_BODY_FRAC)`, so DARK PHASE reads
  at roughly the same on-screen body size as GABRIEL's normal battle
  sprites (this is a combat state, not a smaller dramatic cutscene pose
  like the DOWN/CINEMATIC family). Drawn centered on boss.x/y, no per-axis
  offset needed (single image, no second facing to align against).
- **Superseded twice by later revisions**: GABRIEL's body is no longer
  drawn AT ALL during DARK PHASE. A first revision (Batch 12) replaced it
  with a Canvas-drawn radial-gradient eye VFX; a second, later revision
  replaced THAT in turn with `dark_phase_eyes.png` — a crop EXTRACTED
  directly from this same `dark_phase_source.png` (see the dedicated note
  right below this one, and `assets/boss/dark_phase_eyes_build_meta.json`).
  `dark_phase.png`/`dark_phase_build_meta.json` (the full silhouette-body
  asset) are left on disk as-is (harmless, unreferenced) rather than
  deleted, in case a future revision wants the silhouette pose back.
  `source/dark_phase_source.png` itself is still very much in active use —
  it's the direct source for `dark_phase_eyes.png` below.

Follow-up to Batch 11 — DARK PHASE eye-only extraction (`dark_phase_eyes.png`,
no new source image; reuses `dark_phase_source.png` above):
- Per an explicit later revision, DARK PHASE's visible "glow" was changed
  from a Canvas-drawn radial gradient (an invented design) to a crop
  EXTRACTED directly from `dark_phase_source.png` — the same previously-
  attached render, no new upload. Reuses the exact same redness
  classification already verified for `dark_phase.png` (`redness = R -
  max(G,B) > 15`), but instead of recoloring the remaining (non-glow)
  pixels into an opaque black silhouette, EVERY non-glow pixel — the
  original white background AND the black body/wings alike — is set fully
  transparent. Result: 7303 glow pixels, bbox x:[554,648] y:[289,405] in
  the 1152x1728 source canvas, cropped with a 20px margin to
  `dark_phase_eyes.png` (135x157px, saved at native crop resolution, no
  resize/stretch at save time). No white/gray halo is possible by
  construction (every non-glow pixel is alpha=0, not partially blended).
  Full method: `assets/boss/dark_phase_eyes_build_meta.json`.
- In-game, the SAME anchor point (the crop's own bbox center, mapped
  through `DARKPHASE_SCALE`'s body-accurate projection onto boss.x/boss.y)
  drives BOTH where the glow is drawn and the FLASH head-aim hit-test, so
  they can never drift apart — see `getDarkPhaseHeadScreenPos()` in
  `game.js`. The DRAWN size is a separate, deliberate judgment call
  (`DARKPHASE_EYES_DISPLAY_H=46px`, aspect-preserving) since the body-
  accurate projection alone would render the crop at only ~10-12px tall —
  correct anatomically, but too small to read as "glowing eyes in the
  dark" during actual play.

Batch 12 — SOUTH WALK 3-frame animation + SOUTH IDLE (`walk_south_1/2/3.png`,
`south_idle.png`):
- Sources: 3 new attached renders (GABRIEL walking, south-facing), native
  sizes 1105x1731 / 1125x1714 / 1158x1751. Raw uploads preserved byte-for-
  byte at `assets/boss/source/south_walk_frame1/2/3_source.png` (verified
  via md5, not a PIL re-save).
- Frame 1 is used for BOTH `walk_south_1.png` AND `south_idle.png` (byte-
  identical copies of the same processed canvas) per explicit instruction
  that SOUTH IDLE and SOUTH WALK's first frame share the exact same image/
  scale/anchor, so an IDLE<->WALK transition never jumps in size or position.
- **Cleanup — white-background unblend, no AI redraw**: same class of issue
  as the DARK PHASE image (Batch 11) but a different fix, since this
  character has genuine bright silver/white wing content (a "reddish
  pixels stay opaque" trick doesn't apply to a non-monochrome design).
  Bucketing edge pixels (alpha in (3,250)) by alpha value showed mean
  brightness climbing from ~98 (alpha 200-250) up to ~230 (alpha 3-30) — the
  signature of a flatten-over-white-then-rethreshold pipeline that never
  un-premultiplied the RGB. Fixed via the standard, deterministic "un-
  premultiply against a known white background" formula: for every pixel
  with alpha>0, true color `F = clip((RGB - (1-alpha/255)*255) / (alpha/255),
  0, 255)`; alpha itself was already a reasonable matte and is kept as-is;
  alpha==0 pixels are zeroed. Re-bucketing after the fix showed brightness
  roughly flat (~50-90) across the mid/high alpha range instead of climbing
  toward white — confirmed visually with zoomed composites over dark-navy
  test backgrounds (no fringe on the many wing-feather tips) and again in
  the actual in-game screenshots. Full method: `assets/boss/south_walk_build_meta.json`.
- **Landmark-based scale/anchor matching, not raw pixel dimensions**: each
  source's own head_top_y (topmost opaque pixel within columns >35% of its
  width, which excludes the wing — entirely left-of-center in this pose),
  head_center_x (midpoint of that topmost row), and feet_bottom_y (lowest
  opaque row overall) were measured, then scaled/positioned onto the
  EXISTING shared 700x920 boss canvas so the result matches the
  already-shipped `walk_south_1.png`/`walk_south_2.png`'s own measured body
  span (770px) and anchor (center_x=365, feet_bottom_y=899.5) — i.e. this
  batch preserves the PRE-EXISTING on-screen SOUTH WALK size, not an
  arbitrary new one. Verified on the final canvases: all 4 files land
  within 2px of the target on every axis. Full per-image measurements/
  scale/offset: `assets/boss/south_walk_build_meta.json`.
- Animation: `bossFrameName()` now cycles walk_south_1 -> 2 -> 3 -> 1... via
  `Math.floor(now / WALK_FRAME_PERIOD_MS) % 3` (same per-frame period as
  the old 2-frame cycle, just one more step — the walking cadence itself is
  unchanged).
- DARK PHASE never draws south_idle/walk_south_* (or any other normal
  battle sprite) — see `drawBossDarkPhase()`, which only ever draws the
  glowing-eye VFX regardless of GABRIEL's underlying `boss.dir`/movement.

Notes:
- Verified visually (not assumed) that EAST images face screen-right with
  the wing trailing to the left/back, and WEST images face screen-left
  with the wing trailing right/back, for both the IDLE and WALK pairs —
  each direction uses its own dedicated render, no image was flipped to
  stand in for the other.
- NORTH shows the boss's back (no dedicated NORTH walk render was
  supplied); per the "no generative completion" rule, NORTH movement
  reuses `north_idle` with a small canvas-side vertical bounce instead of
  fabricating a walk frame.
- Batch-1 images share one source canvas (1546x2176) with the character
  already centered and foot-aligned across poses; batch-2 walk images
  share a second, differently-scaled source canvas (1200x1800), also
  internally centered/foot-aligned. The two groups were normalized to a
  common body scale by matching each source canvas's own foot-to-top
  content span (see `assets/boss/sprite_build_meta.json` and the report
  given to the user) — necessarily an approximation given the wings'
  variable spread per pose, disclosed to the user rather than presented
  as exact.

Batch 13 — SOUTH WALK 3-frame REPLACEMENT (`walk_south_1/2/3.png`) + EAST/WEST
ATTACK release-frame REPLACEMENT (`attack_east_release.png`,
`attack_west_release.png`), plus a SOUTH-only ping-pong walk-cycle change:

- SOUTH WALK: 3 new source images (`assets/boss/source/south_walk2_frame1/2/3_raw.png`,
  1130-1196 x 1736-1790, genuine straight alpha, no white-fringe cleanup
  needed) replace the previous batch's `walk_south_1/2/3.png` one-for-one
  (frame N of the new attachment set = `walk_south_N.png`, no reordering).
  `south_idle.png`/`south_attack*`/`defense_*` are explicitly NOT touched —
  `south_idle.png` still holds the PREVIOUS batch's frame-1 image, so IDLE
  and the new WALK frame 1 are no longer byte-identical (an accepted,
  explicitly-instructed seam, not an oversight).
- Landmark-based scale/anchor, reusing the PREVIOUS batch's own target
  constants (body span 770px, center_x=365, feet_bottom_y=899.5) so the
  new art lands at the exact same on-canvas size as what it replaces.
  Verified within 1px of target and of each other across all 3 frames.
  Full measurements: `assets/boss/south_walk2_build_meta.json`.
- Animation change: `bossFrameName()`'s SOUTH branch now cycles
  1 -> 2 -> 3 -> 2 -> 1 -> 2 -> 3 -> 2 -> 1... (ping-pong, period 4 over
  `[1,2,3,2]`) instead of the previous plain 1 -> 2 -> 3 -> 1 wrap-around —
  SOUTH only; NORTH/EAST/WEST keep their original wrap-around cycles.
  `WALK_FRAME_PERIOD_MS` (frame interval) itself is unchanged.
- EAST/WEST ATTACK: 2 new source images (`assets/boss/source/
  attack_east_release2_raw.png` 1017x2033, `attack_west_release2_raw.png`
  925x1957) replace `attack_east_release.png`/`attack_west_release.png`.
  Verified each new source's own claw/wing side matches its predecessor's
  orientation (east: claw-right/wing-left; west: claw-left/wing-right) —
  no flip used, each direction kept its own dedicated image.
  Landmark-matched (head/feet, not raw bbox) to each OLD image's own
  measured body span/anchor on the shared canvas, since the new art's
  wing/claw proportions differ from the old art's. attack_east_release
  needed the resized image's top ~25px (wing feather tips only) clipped to
  fit the canvas without shrinking the body match; attack_west_release
  needed no clipping. Verified within a few px of the old reference on
  head_top_y/feet_bottom_y; head_center_x differs by ~4-12px, attributable
  to the new head being tilted at a different angle in the new pose, not a
  scale error. Full measurements: `assets/boss/attack_ew_release2_build_meta.json`.
- Attack timing/hitbox/damage/range/duration/cooldown/AI/direction logic
  in `game.js` is unchanged — only the two image files were replaced,
  under their existing filenames.

Batch 14 — NORTH WALK 3-frame REPLACEMENT (`walk_north_1/2/3.png`) + SOUTH
WALK REPLACEMENT AND FRAME-COUNT REDUCTION (`walk_south_1/2.png`, 2 frames
instead of 3), STRAIGHT CLAW attack explicitly deferred to a later batch:

- NORTH WALK: 3 new source images (`assets/boss/source/north_walk2_frame1/2/3_raw.png`,
  1120-1199 x 1823-1926) replace `walk_north_1/2/3.png` one-for-one. All 3
  carried the same white-background-composite alpha bug seen in earlier
  batches (brightness climbing toward white as alpha drops); fixed with the
  same deterministic un-premultiply-against-white formula, confirmed flat
  brightness across mid/high alpha and no visible fringe on a dark-bg
  composite afterward. `north_idle.png`/`attack_north.png`/`defense_north.png`
  are explicitly NOT touched.
- NORTH landmark-matched (head_top_y/head_center_x/feet_bottom_y, wing
  excluded via column range) to the CURRENTLY SHIPPED walk_north_1/2/3's own
  measured size (re-verified directly on those files, which itself matched
  the older north_walk2_build_meta.json's target within 1-2px) — same target
  constants reused (body span 718, center_x=337, feet_bottom_y=900).
  Verified within 1px of target and of each other across all 3 frames. One
  frame needed a 4px top crop (wing-tip only) to fit the canvas. Full
  measurements: `assets/boss/north_walk3_build_meta.json`.
- NORTH animation is UNCHANGED — still plain 1 -> 2 -> 3 -> 1 wrap via
  `WALK_FRAME_PERIOD_MS` (unchanged value); only the 3 images were replaced.
- SOUTH WALK: 2 new source images (`assets/boss/source/south_walk3_frame1/2_raw.png`,
  1127-1199 x 1746-1757, genuine straight alpha, no fringe fix needed)
  replace the previous batch's 3-frame `walk_south_1/2/3.png` with a
  2-frame `walk_south_1/2.png`. `walk_south_3.png` is left on disk but is
  no longer referenced anywhere (removed from `BOSS_FRAME_FILES`) — not
  deleted, since deletion wasn't requested. `south_idle.png`/`south_attack*`/
  `defense_*` are explicitly NOT touched.
- SOUTH landmark-matched to the immediately-preceding south-walk batch's own
  target (body span 770, center_x=365, feet_bottom_y=899.5), re-verified on
  those shipped files before overwriting them. Verified within 1px of
  target and of each other across both frames. Full measurements:
  `assets/boss/south_walk3_build_meta.json`.
- SOUTH animation changed from the previous batch's period-4 ping-pong
  ([1,2,3,2]) to a plain 2-frame alternation (1 -> 2 -> 1 -> 2 ...), and now
  runs on a NEW dedicated constant `SOUTH_WALK_FRAME_PERIOD_MS =
  WALK_FRAME_PERIOD_MS * 1.5` (~50% slower than NORTH/EAST/WEST) so
  alternating only 2 frames doesn't read as an unnaturally fast flicker.
  `WALK_FRAME_PERIOD_MS` itself (NORTH/EAST/WEST) is unchanged.
- STRAIGHT CLAW attack images/logic are explicitly deferred to the next
  batch, per instruction — nothing attack-related beyond the already-shipped
  EAST/WEST release frames was touched here.
- This batch was intentionally left UNCOMMITTED in the working tree per
  explicit instruction (more images/logic — the STRAIGHT CLAW attack — are
  coming in a follow-up batch before commit/push).

Batch 15 — GABRIEL STRAIGHT CLAW counterattack: 2 new dedicated images
(`assets/boss/straight_claw_windup.png`, `straight_claw_release.png`),
committed together with batch 14's previously-uncommitted north/south walk
work plus this same turn's STEALTH visual and 2-area stage changes:

- 2 new source images (`assets/boss/source/straight_claw_windup_raw.png`,
  1151x2051; `assets/boss/source/straight_claw_release_raw.png`, 1260x2020)
  processed into a single non-directional windup/release pose pair, used
  regardless of GABRIEL's facing when the counter triggers (only 2 images
  were supplied, not a per-direction set) — the attack's actual direction is
  computed independently from GABRIEL's position to the player's locked
  position at release, decoupled from which way this sprite visually faces.
- `straight_claw_windup_raw.png` carried no white-fringe issue (edge
  brightness roughly flat across the alpha range) and was used as-is.
  `straight_claw_release_raw.png` carried the same white-background-composite
  alpha bug seen in earlier batches (brightness climbing from ~97 at high
  alpha to ~220 at low alpha); fixed with the same deterministic
  un-premultiply-against-white formula used throughout this project,
  confirmed flat afterward with no residual fringe on a dark-bg composite.
  The unblended intermediate was not persisted separately, matching this
  project's established convention.
- Neither image's silhouette matches the simple "wing entirely on one side"
  shape used for walk/idle art — both have an elaborate crest/wing structure
  that also reaches upward near the head, so the automated single-column-
  threshold head-detection method used elsewhere was unreliable here (it
  kept latching onto a feather/crest tip instead of the actual helmet dome).
  The helmet dome's topmost point was instead located by manual visual
  inspection for both images, then verified by directly transforming each
  image's own chosen landmark point through its own computed scale+offset
  (not a generic re-scan) and confirming the result lands on the dome.
- Reused the existing front-facing GABRIEL body-size target (body span
  770.0, center_x 365.0, feet_bottom_y 899.5 — the same reference used for
  south_walk/south_idle), since both new images are front-facing full-body
  poses. Both landed within 0.5px of this target and of each other on
  computed head_top_y/center_x, and both shipped at feet_bottom_y=899
  (target 899.5) — confirming no size/position jump between windup and
  release. release's placement math wanted to place its own top ~138px
  above the canvas (its wing/crest extends further above the head relative
  to body height than windup's does); rather than shrinking the body to fit
  the wing, the resized image's top 138px was cropped instead (verified by
  direct coordinate transform that head/body/limbs/claw all stay
  comfortably below the crop line) — only the very top of the flared wing
  crest is trimmed. Full measurements: `assets/boss/straight_claw_build_meta.json`.
- No AI generation/regeneration/completion/alternate-pose-generation/
  mirror-substitution/cross-direction-generation was used anywhere in this
  batch — only crop/resize/transparent-padding/alpha-cleanup/edge-cleanup/
  source-rect-adjustment/scale-adjustment/anchor-adjustment, applied to the
  2 attached source images themselves.
- Existing attacks (normal CLAW, ARC CLAW SLASH, DARK PHASE attack,
  DEFENSE) are unmodified — STRAIGHT CLAW is a fully separate, additional
  boss state (`boss.state === 'straightclaw'`) with its own dedicated
  timing/hitbox/knockback constants (see `game.js`'s `STRAIGHT_CLAW_*`
  constants and `updateBossStraightClaw()`/`spawnStraightClaw()`).

Batch 16 — GABRIEL north defense replacement, south walk restored to 3
frames, STING release edge-clip fix, north COUNTER windup swap, and a
separate windup-only scale constant:

- NORTH DEFENSE: 1 new source image (`north_defense_raw.png`, 1280x1910,
  no white/black-fringe alpha bug found, used as-is) replaces
  `assets/boss/defense_north.png` only — `north_idle`/`north_walk_*` are
  untouched. Landmark-matched against the PRE-replacement `defense_north.png`'s
  own measured body span/head/feet (re-derived via a narrow ±column band
  around canvas-center chosen specifically to land on the head crown while
  avoiding the wing spikes on both sides of this symmetric back-view pose —
  a wider band first mis-caught a spike). scale=0.4566294919454771,
  paste_offset=(58,30), no clipping needed.
- SOUTH WALK: reverted from batch 14's 2-frame `walk_south_1/2.png` back to
  a 3-frame cycle. 3 new source images (`south_walk_frame1/2/3_raw.png`,
  1205x1780 / 1166x1709 / 1130x1737) replace `walk_south_1/2/3.png` (the
  `walk_south_3` entry, present on disk but unreferenced since batch 14, is
  wired back into `BOSS_FRAME_FILES`). All 3 raw sources carried a
  black-background-composite alpha bug (the mirror image of the more common
  white-composite one — brightness rises from ~13 near alpha 0 toward
  ~85-95 near full alpha instead of being flat) and were fixed with the
  matching un-premultiply-against-black formula
  (`rgb / max(alpha/255, epsilon)`, clipped to 0-255) before compositing.
  Landmark priority follows this batch's own instruction order: primary
  alignment anchor is each frame's own camera-left knee (native pixel
  coords frame1=(615,1170) frame2=(585,1100) frame3=(535,1110), located by
  iterative manual marker placement since the robe visually merges both
  legs at knee height, defeating automated column-centroid detection),
  secondarily the shared ground/feet-bottom-y and head-top-y targets
  (matched to the pre-replacement south_walk/south_idle reference: body
  span 770, feet_bottom_y 899.5) — each frame gets its own individually
  tuned scale (0.4895/0.4920/0.4898) since the 3 source photos aren't at
  the same apparent character size. Final per-frame paste offsets: frame1
  (3,30), frame2 (16,61), frame3 (42,50) — chosen so all 3 frames' knee
  canvas-x positions land within ~4px of each other. Verified via anaglyph
  silhouette-diff overlays showing solid full-overlap across head/torso/
  waist/upper-legs between consecutive frames, differences confined to
  outer limbs/hem/wingtips (genuine walk-cycle motion only). Animation is a
  plain forward loop (1 -> 2 -> 3 -> 1 -> ...), not ping-pong, on
  `SOUTH_WALK_FRAME_PERIOD_MS = WALK_FRAME_PERIOD_MS * 1.15` (batch 14's
  `* 2.3` slowdown, added to compensate for having only 2 frames, is no
  longer appropriate now that 3 real frames exist). NORTH's own walk
  period/logic is untouched.
- STING RELEASE EDGE-CLIP FIX: `straight_claw_release.png` rebuilt again
  from the SAME `straight_claw_release_raw.png` used in batch 15 (which
  still needed its white-composite un-premultiply fix re-applied — the fix
  was only ever baked into the shipped PNG, not the raw source). Root
  cause of the reported edge cutoff: batch 15 centered this asset on its
  `head_center_x` landmark, but this pose's claw reaches much further to
  one side than its wing reaches to the other, so a landmark-centered
  placement pushed the claw tip past the fixed 700px canvas edge
  (recomputed: old paste_x=85 would place the right edge at ~731.6, ~31.6px
  past the 700-wide canvas — confirmed the real-device report was
  accurate). Fixed by centering on the FULL opaque-pixel bounding box's
  balanced left/right margins instead of the single head-center landmark
  (`paste_x = (700 - (bbox_right+bbox_left)*scale)/2`), at the SAME
  scale=0.514362 as before (COUNTER_STING_SCALE=0.90 unchanged, per
  instruction not to shrink further) — new paste_x=26. Top-crop
  (clip_top=138) is unchanged from batch 15 and still keeps the claw's own
  topmost point well clear of the crop line. `straight_claw_windup.png` is
  byte-identical to batch 15 — not touched.
- COUNTER WINDUP +10% SCALE: rather than baking a larger size into
  `straight_claw_windup.png`'s pixels (which would be inconsistent with
  every other "N% larger/smaller" adjustment in this project, all
  implemented as a runtime draw-time multiplier), added a new independent
  constant `COUNTER_WINDUP_SCALE = COUNTER_STING_SCALE * 1.10` (0.99) used
  only for the windup-phase sprite; `COUNTER_STING_SCALE` (0.90) is
  unchanged and still used only for the release-phase sprite. Both scale
  from the sprite's own bottom edge (`dy = bottomY - h`), so ground-anchor
  is preserved automatically for any scale change.
- NORTH COUNTER WINDUP SWAP: for `boss.counterDir === 'north'` only, the
  windup-phase frame now returns `'north_idle'` instead of the shared
  `straight_claw_windup` sprite (`bossFrameName()`'s `'straightclaw'`
  branch) — south/east/west continue sharing the one windup image
  unchanged. Everything else about north COUNTER (5-block trigger,
  invulnerability, 2x ARC CLAW speed, damage-only-on-hit, 1.3x multiplier,
  FLASH-cancel->flashdown) is untouched.
- AIM muzzle-origin calibration fix (unrelated to the image work above,
  same batch): `MUZZLE_OFFSETS.right`/`.left` (the fixed-point offsets used
  only for east/west, since north/south already use the angle-based radial
  `MUZZLE_DIST` formula) were re-measured directly against the actual
  opaque-pixel bounding box of the currently-shipped `right_aim.png`/
  `left_aim.png` sprites — the previous values read a few px past the
  visible barrel tip (`right: dx 0.503->0.459, dy -0.253->-0.287`; `left:
  dx -0.506->-0.450, dy -0.321->-0.315`, all as a fraction of
  `SPRITE_DRAW_H`). `getMuzzleWorldPosition()` was already the single
  shared function used by both `spawnBullet()` and `drawAimLine()` before
  this batch — no architectural change was needed, only this numeric
  recalibration.
- No AI generation/regeneration/completion/alternate-pose-generation/
  mirror-substitution/design-change was used anywhere in this batch — only
  crop/resize/transparent-padding/alpha-cleanup/edge-cleanup/source-rect-
  adjustment/scale-adjustment/offset-adjustment/anchor-adjustment, applied
  to the attached source images themselves.

Batch 17 — south COUNTER STING top-edge fix (no new source images; rebuilt
from the same `straight_claw_release_raw.png` used in batches 15/16):

- Real-device feedback reported the STING release image's TOP edge (the
  flared wing crest above the head) was clipped, in addition to the
  left/right clipping already fixed in batch 16. Root cause: batch 16's
  scale (0.514362, matching the shared 770px front-facing body-span
  reference used by every other GABRIEL front pose) implies a total
  top-of-wingcrest-to-feet span of ~1031px — taller than the entire fixed
  920px-tall boss canvas at ANY vertical position, so no repositioning
  alone could avoid clipping the top at that scale; batch 16's own
  clip_top_px=138 was papering over exactly this.
  `COUNTER_STING_SCALE` (the runtime 0.90 draw-time multiplier) is
  untouched — only the internal composition scale used when baking this
  one PNG changed, per instruction ("must fix the draw region/bounding
  box, not shrink the existing runtime scale as a shortcut").
- Measured the raw source's real opaque bounding box directly (after
  re-applying the established un-premultiply-against-white fix):
  left=3, right=1256, top=11, bottom=2016 (native 1260x2020). Solved for
  the largest scale that (a) keeps feet_bottom_y anchored at the same
  899.5 target every other south-facing pose shares (no anchor jump) and
  (b) leaves at least a 10px transparent margin above the topmost opaque
  pixel: scale=0.443640897755611 (down from batch 16's 0.514362 — the claw
  and body read a little smaller within the canvas than the other
  front-facing poses, an unavoidable consequence of this one pose's
  unusually tall wing crest relative to its own body, given cropping was
  explicitly forbidden and the canvas height is fixed).
- Re-centered horizontally using the same full-opaque-bbox-balanced method
  batch 16 introduced (not the single head-center landmark): paste_x
  recomputed at the new scale to 70.73, landing the bbox at
  left=72/right=628 (700-wide canvas, ~72px margin each side).
- Verified the full rebuilt canvas: opaque bbox left=72 right=628 top=10
  bottom=899 — comfortably inside the 700x920 canvas on every edge,
  confirmed against both a white and dark background composite (no
  residual fringe from the un-premultiply fix, no clipping anywhere).
- `straight_claw_windup.png` is untouched.
