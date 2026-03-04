# Social Spots Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When idle agents finish their wander cycle, instead of returning to their seat they walk to a nearby social furniture item (coffee machine, water cooler, vending machine) and wait there — clustering together naturally.

**Architecture:** Add `isSocialSpot` flag to `FurnitureCatalogEntry`. `OfficeState` precomputes a `socialSpotTiles` list (walkable tiles adjacent to placed social furniture). `updateCharacter` receives this list and uses it instead of the seat-rest fallback when the list is non-empty.

**Tech Stack:** TypeScript, React webview (Vite), no new dependencies.

---

### Task 1: Add `isSocialSpot` to types and constants

**Files:**
- Modify: `webview-ui/src/office/types.ts` — add field to `FurnitureCatalogEntry`
- Modify: `webview-ui/src/constants.ts` — add two new timing constants
- Modify: `webview-ui/src/office/types.ts` — add two new fields to `Character`

**Step 1: Add `isSocialSpot` to `FurnitureCatalogEntry`**

In `webview-ui/src/office/types.ts`, after `canPlaceOnWalls?: boolean`, add:

```ts
/** Whether idle agents are attracted to this furniture as a social gathering spot */
isSocialSpot?: boolean
```

**Step 2: Add `socialSpotTimer` and `atSocialSpot` to `Character`**

In `webview-ui/src/office/types.ts`, after `seatTimer: number`, add:

```ts
/** Countdown timer for how long to stay at a social spot (0 = not at a spot) */
socialSpotTimer: number
/** True while the character is waiting at a social spot */
atSocialSpot: boolean
```

**Step 3: Add timing constants**

In `webview-ui/src/constants.ts`, after `SEAT_REST_MAX_SEC`, add:

```ts
export const SOCIAL_SPOT_STAY_MIN_SEC = 20.0
export const SOCIAL_SPOT_STAY_MAX_SEC = 45.0
```

**Step 4: Verify TypeScript compiles**

Run: `cd /home/camillepicolet/projects/pixel-agents && npm run build 2>&1 | head -40`

Expected: build errors because `socialSpotTimer` and `atSocialSpot` are not yet initialized in `createCharacter`. That's fine — we'll fix in the next task.

---

### Task 2: Initialize new Character fields in `createCharacter`

**Files:**
- Modify: `webview-ui/src/office/engine/characters.ts`

**Step 1: Add new fields to `createCharacter` return object**

In `webview-ui/src/office/engine/characters.ts`, in the `createCharacter` function return object (after `seatTimer: 0`), add:

```ts
socialSpotTimer: 0,
atSocialSpot: false,
```

**Step 2: Add imports for new constants**

In `webview-ui/src/office/engine/characters.ts`, add `SOCIAL_SPOT_STAY_MIN_SEC` and `SOCIAL_SPOT_STAY_MAX_SEC` to the existing constants import:

```ts
import {
  WALK_SPEED_PX_PER_SEC,
  WALK_FRAME_DURATION_SEC,
  TYPE_FRAME_DURATION_SEC,
  WANDER_PAUSE_MIN_SEC,
  WANDER_PAUSE_MAX_SEC,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_MOVES_BEFORE_REST_MAX,
  SEAT_REST_MIN_SEC,
  SEAT_REST_MAX_SEC,
  SOCIAL_SPOT_STAY_MIN_SEC,
  SOCIAL_SPOT_STAY_MAX_SEC,
} from '../../constants.js'
```

**Step 3: Verify TypeScript compiles**

Run: `cd /home/camillepicolet/projects/pixel-agents && npm run build 2>&1 | head -40`

Expected: Build succeeds (or only unrelated errors).

**Step 4: Commit**

```bash
cd /home/camillepicolet/projects/pixel-agents
git add webview-ui/src/office/types.ts webview-ui/src/constants.ts webview-ui/src/office/engine/characters.ts
git commit -m "feat: add isSocialSpot flag and Character social spot fields"
```

---

### Task 3: Add `isSocialSpot` to `furnitureCatalog.ts` + hardcoded `COOLER`

**Files:**
- Modify: `webview-ui/src/office/layout/furnitureCatalog.ts`

**Step 1: Add `isSocialSpot` to `LoadedAssetData` catalog interface**

In the `LoadedAssetData` interface, after `canPlaceOnWalls?: boolean`, add:

```ts
isSocialSpot?: boolean
```

**Step 2: Propagate flag in `buildDynamicCatalog`**

In the `.map()` callback inside `buildDynamicCatalog`, after `...(asset.canPlaceOnWalls ? { canPlaceOnWalls: true } : {})`, add:

```ts
...(asset.isSocialSpot ? { isSocialSpot: true } : {}),
```

**Step 3: Mark the hardcoded `COOLER` as a social spot**

In the `FURNITURE_CATALOG` array, update the `COOLER` entry:

```ts
{ type: FurnitureType.COOLER, label: 'Cooler', footprintW: 1, footprintH: 1, sprite: COOLER_SPRITE, isDesk: false, category: 'misc', isSocialSpot: true },
```

**Step 4: Verify TypeScript compiles**

Run: `cd /home/camillepicolet/projects/pixel-agents && npm run build 2>&1 | head -40`

Expected: Build succeeds.

**Step 5: Commit**

```bash
cd /home/camillepicolet/projects/pixel-agents
git add webview-ui/src/office/layout/furnitureCatalog.ts
git commit -m "feat: propagate isSocialSpot flag through furniture catalog"
```

---

### Task 4: Compute `socialSpotTiles` in `OfficeState`

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`

**Context:** `OfficeState` already has `walkableTiles`, `tileMap`, `blockedTiles`, `layout.furniture`. We need to compute tiles adjacent to social furniture and expose them to `updateCharacter`.

**Step 1: Add `socialSpotTiles` field to `OfficeState`**

After `walkableTiles: Array<{ col: number; row: number }>` field declaration, add:

```ts
socialSpotTiles: Array<{ col: number; row: number }> = []
```

**Step 2: Add `rebuildSocialSpotTiles()` private method**

After the `relocateCharacterToWalkable` method, add:

```ts
/** Recompute tiles adjacent to placed social furniture (coffee machine, cooler, etc.) */
private rebuildSocialSpotTiles(): void {
  const result: Array<{ col: number; row: number }> = []
  const seen = new Set<string>()
  for (const item of this.layout.furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry?.isSocialSpot) continue
    // Check all tiles surrounding the footprint
    for (let dr = -1; dr <= entry.footprintH; dr++) {
      for (let dc = -1; dc <= entry.footprintW; dc++) {
        // Skip tiles that are part of the footprint itself
        if (dr >= 0 && dr < entry.footprintH && dc >= 0 && dc < entry.footprintW) continue
        const col = item.col + dc
        const row = item.row + dr
        const key = `${col},${row}`
        if (!seen.has(key) && isWalkable(col, row, this.tileMap, this.blockedTiles)) {
          seen.add(key)
          result.push({ col, row })
        }
      }
    }
  }
  this.socialSpotTiles = result
}
```

**Step 3: Call `rebuildSocialSpotTiles()` in constructor and `rebuildFromLayout`**

In the constructor, after `this.walkableTiles = getWalkableTiles(...)`, add:
```ts
this.rebuildSocialSpotTiles()
```

In `rebuildFromLayout`, after `this.walkableTiles = getWalkableTiles(...)`, add:
```ts
this.rebuildSocialSpotTiles()
```

**Step 4: Pass `socialSpotTiles` to `updateCharacter` in `update()`**

In `OfficeState.update()`, the `withOwnSeatUnblocked` call passes arguments to `updateCharacter`. Update the call to include `this.socialSpotTiles`:

```ts
this.withOwnSeatUnblocked(ch, () =>
  updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles, this.socialSpotTiles)
)
```

**Step 5: Verify TypeScript compiles**

Run: `cd /home/camillepicolet/projects/pixel-agents && npm run build 2>&1 | head -40`

Expected: Type error on `updateCharacter` signature mismatch (we haven't updated the function yet). That's expected.

**Step 6: Commit**

```bash
cd /home/camillepicolet/projects/pixel-agents
git add webview-ui/src/office/engine/officeState.ts
git commit -m "feat: compute socialSpotTiles in OfficeState"
```

---

### Task 5: Update `updateCharacter` FSM to use social spots

**Files:**
- Modify: `webview-ui/src/office/engine/characters.ts`

**Context:** Currently in the `IDLE` state, when `wanderCount >= wanderLimit && ch.seatId`, the agent returns to its seat. We replace this with a social spot visit when `socialSpotTiles` is non-empty.

Additionally, we need a new mini-state: when `ch.atSocialSpot === true` and `ch.state === CharacterState.IDLE`, we count down `socialSpotTimer` instead of wandering.

**Step 1: Update `updateCharacter` signature**

Change:
```ts
export function updateCharacter(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
```

To:
```ts
export function updateCharacter(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  socialSpotTiles: Array<{ col: number; row: number }> = [],
): void {
```

**Step 2: Handle `atSocialSpot` timer in IDLE state**

In the `IDLE` case, at the very beginning (before `ch.frame = 0`), add:

```ts
// If waiting at a social spot, count down timer
if (ch.atSocialSpot) {
  ch.frame = 0
  if (ch.isActive) {
    // Agent became active — leave social spot immediately
    ch.atSocialSpot = false
    ch.socialSpotTimer = 0
    // Pathfind to seat (handled by the isActive block below)
  } else {
    ch.socialSpotTimer -= dt
    if (ch.socialSpotTimer > 0) break // still waiting
    // Done waiting — clear flag, resume normal wandering
    ch.atSocialSpot = false
    ch.socialSpotTimer = 0
    ch.wanderCount = 0
    ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
    ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
    break
  }
}
```

**Step 3: Replace the "return to seat" block with social spot logic**

Find the existing block in IDLE case:
```ts
// Check if we've wandered enough — return to seat for a rest
if (ch.wanderCount >= ch.wanderLimit && ch.seatId) {
  const seat = seats.get(ch.seatId)
  if (seat) {
    const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
      break
    }
  }
}
```

Replace with:
```ts
// Check if we've wandered enough
if (ch.wanderCount >= ch.wanderLimit) {
  // Prefer going to a social spot if any are available
  if (socialSpotTiles.length > 0) {
    const target = socialSpotTiles[Math.floor(Math.random() * socialSpotTiles.length)]
    const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, tileMap, blockedTiles)
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
      ch.atSocialSpot = true  // flag: destination is a social spot
      break
    }
    // No path to any social spot — fall through to seat rest
  }
  // No social spots or no path: return to seat for rest
  if (ch.seatId) {
    const seat = seats.get(ch.seatId)
    if (seat) {
      const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
      if (path.length > 0) {
        ch.path = path
        ch.moveProgress = 0
        ch.state = CharacterState.WALK
        ch.frame = 0
        ch.frameTimer = 0
        break
      }
    }
  }
}
```

**Step 4: Handle social spot arrival in WALK state**

In the `WALK` case, in the `ch.path.length === 0` block (path complete), find where it transitions when `!ch.isActive` (the idle arrived at seat). The `atSocialSpot` flag needs to be handled before the seat-check.

Find:
```ts
if (ch.isActive) {
  if (!ch.seatId) {
    // No seat — type in place
    ch.state = CharacterState.TYPE
  } else {
    const seat = seats.get(ch.seatId)
    if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
      ch.state = CharacterState.TYPE
      ch.dir = seat.facingDir
    } else {
      ch.state = CharacterState.IDLE
    }
  }
} else {
  // Check if arrived at assigned seat — sit down for a rest before wandering again
```

Before the `} else {` block, add the social spot arrival handling inside the `else` section. Replace:
```ts
} else {
  // Check if arrived at assigned seat — sit down for a rest before wandering again
  if (ch.seatId) {
    const seat = seats.get(ch.seatId)
    if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
```

With:
```ts
} else {
  // Arrived at social spot — start the wait timer
  if (ch.atSocialSpot) {
    ch.state = CharacterState.IDLE
    ch.socialSpotTimer = randomRange(SOCIAL_SPOT_STAY_MIN_SEC, SOCIAL_SPOT_STAY_MAX_SEC)
    ch.frame = 0
    ch.frameTimer = 0
    break
  }
  // Check if arrived at assigned seat — sit down for a rest before wandering again
  if (ch.seatId) {
    const seat = seats.get(ch.seatId)
    if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
```

**Step 5: Clear `atSocialSpot` when agent becomes active mid-walk**

In the WALK case, at the end (the re-path block when `ch.isActive && ch.seatId`), also clear the flag:

```ts
// If became active while wandering (or heading to social spot), repath to seat
if (ch.isActive && ch.seatId) {
  ch.atSocialSpot = false  // add this line
  ch.socialSpotTimer = 0   // add this line
  const seat = seats.get(ch.seatId)
  ...
```

**Step 6: Build and check**

Run: `cd /home/camillepicolet/projects/pixel-agents && npm run build 2>&1 | head -50`

Expected: Build succeeds with no errors.

**Step 7: Commit**

```bash
cd /home/camillepicolet/projects/pixel-agents
git add webview-ui/src/office/engine/characters.ts
git commit -m "feat: idle agents visit social spots instead of returning to seat"
```

---

### Task 6: Update `asset-manager.html` to expose `isSocialSpot`

**Files:**
- Modify: `scripts/asset-manager.html`
- Modify: `scripts/5-export-assets.ts`

**Context:** The asset manager is the browser UI used to tag furniture properties. It already has checkboxes for `isDesk`, `canPlaceOnSurfaces`, `canPlaceOnWalls`. We add one for `isSocialSpot`.

**Step 1: Find the `canPlaceOnWalls` checkbox in `asset-manager.html`**

Search for `canPlaceOnWalls` in `scripts/asset-manager.html`. It will be inside a properties panel with similar checkboxes. Add immediately after the `canPlaceOnWalls` row:

```html
<label><input type="checkbox" id="prop-isSocialSpot"> Social Spot</label>
```

(Match the exact surrounding HTML structure — look at how `canPlaceOnWalls` is done and copy the pattern.)

**Step 2: Wire up the checkbox in the JS**

In the same file, find where `canPlaceOnWalls` is read/written in the JS (look for `prop-canPlaceOnWalls`). Add the same pattern for `prop-isSocialSpot`:

- When loading an asset's properties: `document.getElementById('prop-isSocialSpot').checked = asset.isSocialSpot || false`
- When saving: `asset.isSocialSpot = document.getElementById('prop-isSocialSpot').checked || undefined`

**Step 3: Update `5-export-assets.ts` to export the flag**

In `scripts/5-export-assets.ts`, find where `canPlaceOnWalls` is included in the exported JSON entry. Add the same for `isSocialSpot`:

```ts
...(asset.isSocialSpot ? { isSocialSpot: true } : {}),
```

**Step 4: Build**

Run: `cd /home/camillepicolet/projects/pixel-agents && npm run build 2>&1 | head -30`

Expected: Build succeeds.

**Step 5: Commit**

```bash
cd /home/camillepicolet/projects/pixel-agents
git add scripts/asset-manager.html scripts/5-export-assets.ts
git commit -m "feat: add isSocialSpot checkbox to asset-manager"
```

---

### Task 7: Manual smoke test

**No code changes — verification only.**

**Step 1: Build extension**

```bash
cd /home/camillepicolet/projects/pixel-agents && npm run build
```

**Step 2: Open Extension Dev Host**

Press F5 in VS Code to launch the Extension Development Host.

**Step 3: Verify with COOLER**

1. Open Pixel Agents panel
2. Add 2-3 agents
3. Open Layout Editor, place a COOLER furniture item somewhere on the floor
4. Save and close editor
5. Wait for agents to finish a wander cycle (they wander 3-6 tiles then should walk toward the cooler)
6. Verify: agents walk to a tile adjacent to the cooler and stop there for ~20-45 seconds
7. Verify: multiple agents can cluster near the same cooler
8. Verify: when an agent's Claude terminal becomes active, they immediately leave and walk to their seat

**Step 4: Verify fallback (no social furniture)**

1. Remove all social furniture from layout
2. Verify agents still return to their seat after wandering (old behavior intact)

**Step 5: Commit if all looks good**

No additional commit needed — the feature is complete.
