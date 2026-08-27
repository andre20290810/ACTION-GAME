# Stage background asset manifest — 2 source images (batch 1)

Both files below are byte-identical copies of the originally attached
images (verified by md5) — no crop/resize/flip/regeneration applied to
these `source/` copies. The processed, game-ready files built from them
are simple byte-identical copies too (see notes below) and live at
`assets/stage/stage_a_floor.png` / `assets/stage/stage_b_floor.jpg`. The
pre-existing `assets/stage/lab_b03_floor.png` (from an earlier session) is
unaffected and remains the default/first stage in the `STAGES` list in
`game.js`.

## Batch 1 (2 images)

| # | Role | Saved filename | Source dims | md5 |
|---|------|-----------------|-------------|-----|
| 1 | Stage A floor | `stage_a_source.png` | 941x1672 RGB | 92e41d61dc15cdb96ac831eea41f1494 |
| 2 | Stage B floor | `stage_b_source.jpg` | 1008x1792 RGB | 4bfe1ac8a56312cfca539e0e0c4536a5 |

Batch 1 notes:
- Both are used as-is (byte-identical copies at `assets/stage/stage_a_floor.png`
  and `assets/stage/stage_b_floor.jpg`) — no cropping or resizing was needed
  since the in-game scaling is done at runtime in `game.js` (the same
  "cover"-style uniform scale used for the pre-existing lab floor, never
  stretching the aspect ratio on one axis only).
- Registered in the data-driven `STAGES` list in `game.js` alongside the
  pre-existing lab floor, so adding a future stage is just one more list
  entry — no other code needs to change.
- In-game, these are drawn tiled vertically (the same real image repeated,
  never distorted) to build a WORLD taller than the viewport once the boss
  is fully defeated — see the "Stage world / camera / EXIT" section of
  `game.js` for the vertical-scroll/EXIT/stage-transition implementation.
- `stage_a_floor.png` happens to share its exact pixel dimensions
  (941x1672) with the pre-existing `lab_b03_floor.png` — confirmed via
  differing md5 that this is coincidental and the two are genuinely
  different images, not a duplicate.
