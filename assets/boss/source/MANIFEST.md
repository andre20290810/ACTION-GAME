# Boss character asset manifest — all 20 source images (batch 1 + batch 2 + batch 3 + batch 4 + batch 5 + batch 6 + batch 7)

All 20 files below are byte-identical copies of the originally attached
images (verified by md5) — no crop/resize/flip/regeneration applied to
these `source/` copies. The processed, game-ready frames built from them
live in `assets/boss/*.png` (see `assets/boss/sprite_build_meta.json` for
batches 1-2's exact per-frame alignment measurements,
`assets/boss/defense_dirs_build_meta.json` for batch 3's,
`assets/boss/attack_ns_build_meta.json` for batch 5's,
`assets/boss/attack_release_build_meta.json` for batch 6's, and the
ARC CLAW SLASH notes below for batch 7's).

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
