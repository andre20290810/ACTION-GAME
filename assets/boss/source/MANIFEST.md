# Boss character asset manifest — all 10 source images (batch 1 + batch 2)

All 10 files below are byte-identical copies of the originally attached
images (verified by md5) — no crop/resize/flip/regeneration applied to
these `source/` copies. The processed, game-ready frames built from them
live in `assets/boss/*.png` (see `assets/boss/sprite_build_meta.json` for
the exact per-frame alignment measurements).

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
