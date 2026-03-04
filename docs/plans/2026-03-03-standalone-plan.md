# Pixel Agents Standalone Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a standalone web app (2 files: `standalone/server.ts` + `standalone/index.html`) that monitors Claude Code JSONL sessions and displays agents as pixel art characters in a browser.

**Architecture:** Bun server watches `~/.claude/projects/` for JSONL files, parses events, broadcasts via WebSocket. Single HTML file with inline JS renders everything on canvas — porting the extension's pure game engine code (sprites, FSM, pathfinding, renderer) directly.

**Tech Stack:** Bun (server runtime, zero deps), vanilla HTML/JS/Canvas 2D (client, zero deps)

---

## Task 1: Create the Server (`standalone/server.ts`)

**Files:**
- Create: `standalone/server.ts`

The server is ~350 lines. It uses `Bun.serve()` for HTTP + WebSocket, with no external dependencies.

### Step 1: Write the server

Port logic from `src/fileWatcher.ts`, `src/transcriptParser.ts`, `src/timerManager.ts`, and `src/constants.ts`. Strip all VS Code types and replace `webview.postMessage()` with WebSocket broadcast.

Key architectural decisions:
- Use `Bun.serve()` with `fetch` handler for HTTP and `websocket` handler for WS
- Single `Map<string, AgentState>` keyed by JSONL file path (not by agent ID — simpler for standalone since we don't have terminals)
- Agent IDs are auto-incrementing integers starting at 1
- On WS connect, send `{ type: "snapshot", agents: [...] }` with all current agents

The server must implement:

**1. HTTP handler:**
- `GET /` → serve `index.html` from same directory (use `Bun.file()`)
- `GET /ws` → upgrade to WebSocket

**2. JSONL scanning (every 1s interval):**
- Read `~/.claude/projects/` (all subdirs, or specific `--project` hash)
- For each `.jsonl` file not already tracked:
  - If `mtime < 30s` and `size > 0` → new active session → create agent, broadcast `agent_created`
  - Else → skip (old session)
- For each tracked agent: call `readNewLines()` (incremental byte-offset read)
- For inactive agents (`mtime > 120s`) → broadcast `agent_removed`, cleanup

**3. JSONL parsing** — port `processTranscriptLine()` from `src/transcriptParser.ts`:
- `record.type === 'assistant'` with `tool_use` blocks → broadcast `tool_start` per tool
- `record.type === 'user'` with `tool_result` blocks → broadcast `tool_done` (300ms delay)
- `record.type === 'user'` with text content → broadcast `agent_active` (new user prompt)
- `record.type === 'system'` + `subtype === 'turn_duration'` → broadcast `agent_waiting`, clear all tools
- `record.type === 'progress'` → handle sub-agent tool_use/tool_result inside nested data.message.message.content
- `bash_progress` / `mcp_progress` → restart permission timer

**4. Permission detection** — port from `src/timerManager.ts`:
- When a non-exempt tool starts, set a 7s timer
- If timer fires and non-exempt tools are still active → broadcast `agent_permission`
- Cancel timer when new data arrives or tool completes
- Exempt tools: `Task`, `AskUserQuestion`

**5. Tool status formatting** — port `formatToolStatus()`:
```
Read → "Reading <basename>"
Edit → "Editing <basename>"
Write → "Writing <basename>"
Bash → "Running: <cmd truncated 30 chars>"
Glob → "Searching files"
Grep → "Searching code"
Task → "Subtask: <desc truncated 40 chars>"
WebSearch → "Searching the web"
Other → "Using <toolName>"
```

**6. CLI args:**
```
bun run standalone/server.ts [--project <hash>] [--port <number>]
```
Default port: 4242. Default: scan all project subdirs.

**Agent state shape** (per tracked JSONL):
```typescript
interface AgentState {
  id: number
  jsonlFile: string
  projectDir: string
  fileOffset: number
  lineBuffer: string
  activeToolIds: Set<string>
  activeToolStatuses: Map<string, string>
  activeToolNames: Map<string, string>
  activeSubagentToolIds: Map<string, Set<string>>
  activeSubagentToolNames: Map<string, Map<string, string>>
  isWaiting: boolean
  permissionSent: boolean
  hadToolsInTurn: boolean
  folderName: string
}
```

**WebSocket message shapes** (server → client):
```typescript
// On connect
{ type: "snapshot", agents: Array<{ id, sessionFile, folderName, isWaiting, tools: Array<{toolId, status}>, permissionWait }> }

// Events
{ type: "agent_created", id, sessionFile, folderName }
{ type: "tool_start", agentId, toolId, toolName, status }
{ type: "tool_done", agentId, toolId }
{ type: "agent_waiting", agentId }
{ type: "agent_active", agentId }
{ type: "agent_permission", agentId }
{ type: "agent_permission_clear", agentId }
{ type: "subagent_tool_start", agentId, parentToolId, toolId, toolName, status }
{ type: "subagent_tool_done", agentId, parentToolId, toolId }
{ type: "subagent_clear", agentId, parentToolId }
{ type: "agent_removed", id }
```

### Step 2: Verify server starts

Run: `cd standalone && bun run server.ts`
Expected: "Pixel Agents server listening on http://localhost:4242" + starts scanning

### Step 3: Commit

```bash
git add standalone/server.ts
git commit -m "feat: add standalone server for JSONL watching and WebSocket broadcast"
```

---

## Task 2: Client — HTML Shell + Constants + Types (`standalone/index.html`)

**Files:**
- Create: `standalone/index.html`

Start the HTML file with the skeleton and all constants/types needed by the game engine.

### Step 1: Write the HTML shell with constants and types

```html
<!DOCTYPE html>
<html>
<head>
  <title>Pixel Agents</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a2e; overflow: hidden; }
    canvas { display: block; image-rendering: pixelated; }
    #overlay { position: fixed; top: 8px; right: 8px; color: #8888aa;
               font-family: monospace; font-size: 12px; pointer-events: none; }
    #status { position: fixed; bottom: 8px; left: 8px; color: #8888aa;
              font-family: monospace; font-size: 11px; pointer-events: none; }
  </style>
</head>
<body>
  <canvas id="office"></canvas>
  <div id="overlay"></div>
  <div id="status"></div>
  <script>
  // === CONSTANTS ===
  // (port from webview-ui/src/constants.ts — only the values needed for view-only mode)
  ```

Port these constants from `webview-ui/src/constants.ts`:
- Grid: `TILE_SIZE=16`, `DEFAULT_COLS=20`, `DEFAULT_ROWS=11`
- Character animation: `WALK_SPEED_PX_PER_SEC=48`, `WALK_FRAME_DURATION_SEC=0.15`, `TYPE_FRAME_DURATION_SEC=0.3`, `WANDER_PAUSE_MIN/MAX_SEC`, `WANDER_MOVES_BEFORE_REST_MIN/MAX`, `SEAT_REST_MIN/MAX_SEC`, `SOCIAL_SPOT_STAY_MIN/MAX_SEC`
- Matrix effect: all `MATRIX_*` constants
- Rendering: `CHARACTER_SITTING_OFFSET_PX=6`, `CHARACTER_Z_SORT_OFFSET=0.5`, `OUTLINE_Z_SORT_OFFSET=0.001`, `SELECTED/HOVERED_OUTLINE_ALPHA`, `BUBBLE_FADE_DURATION_SEC=0.5`, `BUBBLE_SITTING_OFFSET_PX=10`, `BUBBLE_VERTICAL_OFFSET_PX=24`, `FALLBACK_FLOOR_COLOR='#808080'`
- Game logic: `MAX_DELTA_TIME_SEC=0.1`, `WAITING_BUBBLE_DURATION_SEC=2.0`, `DISMISS_BUBBLE_FAST_FADE_SEC=0.3`, `INACTIVE_SEAT_TIMER_MIN/RANGE_SEC`, `PALETTE_COUNT=6`, `HUE_SHIFT_MIN_DEG=45`, `HUE_SHIFT_RANGE_DEG=271`, `CHARACTER_HIT_HALF_WIDTH=8`, `CHARACTER_HIT_HEIGHT=24`
- Zoom: `ZOOM_MIN=1`, `ZOOM_MAX=10`, `ZOOM_DEFAULT_DPR_FACTOR=2`
- Camera: `CAMERA_FOLLOW_LERP=0.1`, `CAMERA_FOLLOW_SNAP_THRESHOLD=0.5`

Port type objects (as `const` objects, same as extension — no TypeScript enums):
- `TileType = { WALL:0, FLOOR_1:1, ..., VOID:8 }`
- `CharacterState = { IDLE:'idle', WALK:'walk', TYPE:'type' }`
- `Direction = { DOWN:0, LEFT:1, RIGHT:2, UP:3 }`
- `FurnitureType = { DESK:'desk', BOOKSHELF:'bookshelf', PLANT:'plant', COOLER:'cooler', WHITEBOARD:'whiteboard', CHAIR:'chair', PC:'pc', LAMP:'lamp' }`

Port utility functions:
- `randomRange(min, max)`, `randomInt(min, max)` from `characters.ts:354-360`

### Step 2: Verify HTML loads

Open in browser (or just check for syntax errors via Bun: `bun run --bun standalone/index.html` won't work, but we can verify the server serves it).

### Step 3: Commit

```bash
git add standalone/index.html
git commit -m "feat: add standalone client shell with constants and types"
```

---

## Task 3: Client — Sprite Data

**Files:**
- Modify: `standalone/index.html`

Add all sprite data as inline JS. Port directly from `webview-ui/src/office/sprites/spriteData.ts`.

### Step 1: Add furniture sprites

Port these from `spriteData.ts:11-273` (all use the `SpriteData = string[][]` format):
- `DESK_SQUARE_SPRITE` (32×32)
- `PLANT_SPRITE` (16×24)
- `BOOKSHELF_SPRITE` (16×32)
- `COOLER_SPRITE` (16×24)
- `WHITEBOARD_SPRITE` (32×16)
- `CHAIR_SPRITE` (16×16)
- `PC_SPRITE` (16×16)
- `LAMP_SPRITE` (16×16)

### Step 2: Add speech bubble sprites

Port from `spriteData.ts:275-319`:
- `BUBBLE_PERMISSION_SPRITE` (11×13)
- `BUBBLE_WAITING_SPRITE` (11×13)

### Step 3: Add character palettes and templates

Port from `spriteData.ts:325-984`:
- `CHARACTER_PALETTES` (6 entries with skin/shirt/pants/hair/shoes)
- Template key constants: `H='hair'`, `K='skin'`, `S='shirt'`, `P='pants'`, `O='shoes'`, `E='#FFFFFF'`
- `resolveTemplate(template, palette)` function
- `flipHorizontal(template)` function
- All 21 character templates (7 per direction × 3 directions):
  - DOWN: `CHAR_WALK_DOWN_1/2/3`, `CHAR_DOWN_TYPE_1/2`, `CHAR_DOWN_READ_1/2`
  - UP: `CHAR_WALK_UP_1/2/3`, `CHAR_UP_TYPE_1/2`, `CHAR_UP_READ_1/2`
  - RIGHT: `CHAR_WALK_RIGHT_1/2/3`, `CHAR_RIGHT_TYPE_1/2`, `CHAR_RIGHT_READ_1/2`

### Step 4: Add sprite resolution functions

Port from `spriteData.ts:1005-1122`:
- `flipSpriteHorizontal(sprite)` — flip SpriteData (not template)
- `getCharacterSprites(paletteIndex, hueShift)` — returns `{ walk, typing, reading }` per direction
  - Uses template fallback path (no PNG loading in standalone)
  - Includes hue shift via `hueShiftSprites()` → `adjustSprite()`
- Sprite cache: `Map<string, CharacterSprites>` keyed by `"paletteIndex:hueShift"`

### Step 5: Commit

```bash
git add standalone/index.html
git commit -m "feat: add all sprite data to standalone client"
```

---

## Task 4: Client — Game Engine

**Files:**
- Modify: `standalone/index.html`

Port the core game engine: color math, sprite caching, tile map, pathfinding, character FSM, matrix effect.

### Step 1: Add colorize module

Port from `webview-ui/src/office/colorize.ts:86-177`:
- `hslToHex(h, s, l)` — HSL to `#RRGGBB`
- `clamp255(v)` — clamp to 0-255
- `rgbToHsl(r, g, b)` — RGB to `[h, s, l]`
- `adjustSprite(sprite, color)` — shift HSL values per pixel (for hue shift)

Only `adjustSprite` is needed (no `colorizeSprite` for view-only mode). The colorize cache can be simplified since we only use it for character hue shifts.

### Step 2: Add sprite cache

Port from `webview-ui/src/office/sprites/spriteCache.ts:1-77`:
- `getOutlineSprite(sprite)` — generate 1px white outline SpriteData
- `getCachedSprite(sprite, zoom)` — convert SpriteData to offscreen canvas, cache by zoom level
- Use `Map<number, WeakMap<SpriteData, HTMLCanvasElement>>` for zoom-keyed caching

### Step 3: Add tile map and pathfinding

Port from `webview-ui/src/office/layout/tileMap.ts:1-106`:
- `isWalkable(col, row, tileMap, blockedTiles)` — bounds + type + furniture check
- `getWalkableTiles(tileMap, blockedTiles)` — all walkable positions
- `findPath(startCol, startRow, endCol, endRow, tileMap, blockedTiles)` — BFS pathfinding

### Step 4: Add character FSM

Port from `webview-ui/src/office/engine/characters.ts:1-361`:
- `READING_TOOLS` set: `['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']`
- `isReadingTool(tool)` — check if tool uses reading animation
- `tileCenter(col, row)` — pixel center of a tile
- `directionBetween(fromCol, fromRow, toCol, toRow)` — direction to adjacent tile
- `createCharacter(id, palette, seatId, seat, hueShift)` — initialize all Character fields
- `updateCharacter(ch, dt, walkableTiles, seats, tileMap, blockedTiles, socialSpotTiles)` — the main FSM tick (TYPE → IDLE → WALK transitions)
- `getCharacterSprite(ch, sprites)` — map state+direction+frame to SpriteData

### Step 5: Add matrix effect

Port from `webview-ui/src/office/engine/matrixEffect.ts:1-131`:
- `flickerVisible(col, row, time)` — hash-based shimmer
- `matrixEffectSeeds()` — generate 16 random column seeds
- `renderMatrixEffect(ctx, ch, spriteData, drawX, drawY, zoom)` — per-pixel spawn/despawn rendering

### Step 6: Commit

```bash
git add standalone/index.html
git commit -m "feat: add game engine (colorize, sprites, pathfinding, FSM, matrix effect)"
```

---

## Task 5: Client — Layout, Office State, Renderer

**Files:**
- Modify: `standalone/index.html`

### Step 1: Add layout functions

Port simplified versions from `webview-ui/src/office/layout/layoutSerializer.ts`:
- `layoutToTileMap(layout)` — flat array → 2D grid
- `layoutToFurnitureInstances(furniture)` — placed furniture → renderable instances
  - Simplified: no catalog lookup (use hardcoded sprite map), no desk zY precomputation for surface items, no colorization
  - Chair z-sorting: back chairs get `zY = (row+1)*TILE_SIZE + 1`, others `(row+1)*TILE_SIZE`
- `getBlockedTiles(furniture)` — furniture footprint tiles
- `layoutToSeats(furniture)` — chairs → seat positions with facing direction
  - Simplified: determine facing from adjacent desks only (no catalog orientation)
- `createDefaultLayout()` — port from `layoutSerializer.ts:214-268`
  - The hardcoded 20×11 default office with 2 desks, 8 chairs, plants, bookshelf, cooler, whiteboard

Create a simple furniture catalog as a plain object map (type → { sprite, footprintW, footprintH, isDesk, category }):
```javascript
const FURNITURE_CATALOG = {
  desk: { sprite: DESK_SQUARE_SPRITE, footprintW: 2, footprintH: 2, isDesk: true, category: 'desks' },
  bookshelf: { sprite: BOOKSHELF_SPRITE, footprintW: 1, footprintH: 2, isDesk: false, category: 'storage' },
  plant: { sprite: PLANT_SPRITE, footprintW: 1, footprintH: 2, isDesk: false, category: 'decor' },
  cooler: { sprite: COOLER_SPRITE, footprintW: 1, footprintH: 2, isDesk: false, category: 'misc', isSocialSpot: true },
  whiteboard: { sprite: WHITEBOARD_SPRITE, footprintW: 2, footprintH: 1, isDesk: false, category: 'decor' },
  chair: { sprite: CHAIR_SPRITE, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },
  pc: { sprite: PC_SPRITE, footprintW: 1, footprintH: 1, isDesk: false, category: 'electronics' },
  lamp: { sprite: LAMP_SPRITE, footprintW: 1, footprintH: 1, isDesk: false, category: 'electronics' },
}
```

### Step 2: Add OfficeState class

Port from `webview-ui/src/office/engine/officeState.ts:29-708`. Simplified for view-only:

Keep these methods:
- Constructor: initialize from layout (tileMap, seats, blockedTiles, furniture, walkableTiles, socialSpotTiles)
- `addAgent(id, palette?, hueShift?, seatId?, skipSpawnEffect?, folderName?)` — pick diverse palette, find seat, create character, spawn effect
- `removeAgent(id)` — despawn animation
- `addSubagent(parentAgentId, parentToolId)` — negative ID, parent palette, closest seat
- `removeSubagent(parentAgentId, parentToolId)` — despawn
- `removeAllSubagents(parentAgentId)` — despawn all
- `getSubagentId(parentAgentId, parentToolId)` — lookup
- `setAgentActive(id, active)` — toggle active state
- `setAgentTool(id, tool)` — set current tool for animation
- `showPermissionBubble(id)`, `clearPermissionBubble(id)`, `showWaitingBubble(id)`, `dismissBubble(id)`
- `update(dt)` — tick matrix effects, character FSM, bubble timers
- `getCharacters()` — array of all characters
- `getCharacterAt(worldX, worldY)` — hit testing
- `pickDiversePalette()` — balanced palette assignment
- `withOwnSeatUnblocked(ch, fn)` — unblock seat for pathfinding

Skip these (editor-only):
- `rebuildFromLayout()` (no editor)
- `reassignSeat()` (no seat reassignment in standalone)
- `walkToTile()` (no right-click walk)
- `rebuildFurnitureInstances()` auto-on state (nice-to-have but not essential for v1)

### Step 3: Add renderer

Port from `webview-ui/src/office/engine/renderer.ts:45-187`. View-only subset:

- `renderTileGrid(ctx, tileMap, offsetX, offsetY, zoom)` — solid colored tiles only (no PNG floor sprites). Wall → `#555566`, Floor → `FALLBACK_FLOOR_COLOR` (#808080). Skip VOID tiles.
- `renderScene(ctx, furniture, characters, offsetX, offsetY, zoom, selectedAgentId, hoveredAgentId)` — Z-sort furniture + characters, draw with `getCachedSprite()`. Includes:
  - Matrix effect rendering for spawning/despawning characters
  - White outline for selected/hovered characters
  - Sitting offset for TYPE state
- `renderBubbles(ctx, characters, offsetX, offsetY, zoom)` — speech bubbles above characters. Port the bubble rendering from the existing renderer (permission bubble, waiting bubble with fade).

Skip editor overlays (`renderGridOverlay`, `renderGhostBorder`, etc.).

### Step 4: Commit

```bash
git add standalone/index.html
git commit -m "feat: add layout, office state, and renderer to standalone client"
```

---

## Task 6: Client — WebSocket, Canvas, Interactions, Game Loop

**Files:**
- Modify: `standalone/index.html`

Wire everything together: WebSocket events → office state → canvas rendering.

### Step 1: Add WebSocket client

```javascript
let ws = null
let reconnectTimer = null

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${location.host}/ws`)

  ws.onopen = () => { updateStatus('Connected') }
  ws.onclose = () => {
    updateStatus('Disconnected — reconnecting...')
    reconnectTimer = setTimeout(connectWebSocket, 2000)
  }
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data))
}
```

### Step 2: Add message handler

Map WebSocket events to OfficeState calls:
- `snapshot` → `officeState.addAgent(...)` for each agent (with `skipSpawnEffect: true`), set tool/waiting states
- `agent_created` → `officeState.addAgent(id)` with spawn effect
- `tool_start` → `officeState.setAgentActive(id, true)`, `officeState.setAgentTool(id, toolName)`
  - If `toolName === 'Task'`: `officeState.addSubagent(agentId, toolId)`
- `tool_done` → check if all tools done → `setAgentTool(id, nextActiveTool or null)`
  - If completed tool was a Task: `officeState.removeSubagent(agentId, toolId)`
- `agent_waiting` → `officeState.setAgentActive(id, false)`, `officeState.showWaitingBubble(id)`
- `agent_active` → `officeState.setAgentActive(id, true)`, `officeState.clearPermissionBubble(id)`
- `agent_permission` → `officeState.showPermissionBubble(id)`
- `agent_permission_clear` → `officeState.clearPermissionBubble(id)`
- `subagent_tool_start` → `officeState.addSubagent(agentId, parentToolId)`, set active+tool on sub-agent
- `subagent_tool_done` → clear tool on sub-agent (check if last tool)
- `subagent_clear` → `officeState.removeSubagent(agentId, parentToolId)`
- `agent_removed` → `officeState.removeAgent(id)`

Track per-agent tool state on the client side:
```javascript
const agentTools = new Map()  // agentId → Map<toolId, {toolName, status}>
```

### Step 3: Add canvas setup and resize

```javascript
const canvas = document.getElementById('office')
const ctx = canvas.getContext('2d')
let zoom = Math.max(ZOOM_MIN, Math.round(ZOOM_DEFAULT_DPR_FACTOR * devicePixelRatio))
let panX = 0, panY = 0

function resize() {
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
}
window.addEventListener('resize', resize)
resize()
```

### Step 4: Add interactions

**Zoom** (mouse wheel):
```javascript
canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  const oldZoom = zoom
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + (e.deltaY < 0 ? 1 : -1)))
  if (zoom !== oldZoom) {
    // Zoom toward mouse position
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    panX = mx - (mx - panX) * (zoom / oldZoom)
    panY = my - (my - panY) * (zoom / oldZoom)
  }
})
```

**Pan** (middle-click drag):
```javascript
let isPanning = false, panStartX = 0, panStartY = 0
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1) { // middle click
    isPanning = true
    panStartX = e.clientX - panX
    panStartY = e.clientY - panY
    e.preventDefault()
  }
})
canvas.addEventListener('mousemove', (e) => {
  if (isPanning) {
    panX = e.clientX - panStartX
    panY = e.clientY - panStartY
  }
  // Update hovered agent
  const world = screenToWorld(e.clientX, e.clientY)
  officeState.hoveredAgentId = officeState.getCharacterAt(world.x, world.y)
})
canvas.addEventListener('mouseup', (e) => {
  if (e.button === 1) isPanning = false
})
```

**Click** (select agent):
```javascript
canvas.addEventListener('click', (e) => {
  const world = screenToWorld(e.clientX, e.clientY)
  const agentId = officeState.getCharacterAt(world.x, world.y)
  if (agentId !== null) {
    officeState.selectedAgentId = agentId
    officeState.cameraFollowId = agentId
    // Dismiss bubble on click
    officeState.dismissBubble(agentId)
  } else {
    officeState.selectedAgentId = null
    officeState.cameraFollowId = null
  }
})
```

**Screen-to-world** coordinate conversion:
```javascript
function screenToWorld(screenX, screenY) {
  const mapW = officeState.layout.cols * TILE_SIZE * zoom
  const mapH = officeState.layout.rows * TILE_SIZE * zoom
  const offsetX = Math.floor((canvas.width - mapW) / 2) + Math.round(panX)
  const offsetY = Math.floor((canvas.height - mapH) / 2) + Math.round(panY)
  return {
    x: (screenX - offsetX) / zoom,
    y: (screenY - offsetY) / zoom,
  }
}
```

### Step 5: Add camera follow

Smooth camera follow when `cameraFollowId` is set. Clear on manual pan.

```javascript
function updateCamera(dt) {
  if (officeState.cameraFollowId === null) return
  const ch = officeState.characters.get(officeState.cameraFollowId)
  if (!ch) { officeState.cameraFollowId = null; return }
  const targetX = canvas.width / 2 - ch.x * zoom
  const targetY = canvas.height / 2 - ch.y * zoom
  const mapW = officeState.layout.cols * TILE_SIZE * zoom
  const mapH = officeState.layout.rows * TILE_SIZE * zoom
  const centerOffsetX = (canvas.width - mapW) / 2
  const centerOffsetY = (canvas.height - mapH) / 2
  const dx = (targetX - centerOffsetX) - panX
  const dy = (targetY - centerOffsetY) - panY
  if (Math.abs(dx) < CAMERA_FOLLOW_SNAP_THRESHOLD && Math.abs(dy) < CAMERA_FOLLOW_SNAP_THRESHOLD) return
  panX += dx * CAMERA_FOLLOW_LERP
  panY += dy * CAMERA_FOLLOW_LERP
}
```

### Step 6: Add game loop and rendering

```javascript
let lastTime = 0

function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, MAX_DELTA_TIME_SEC)
  lastTime = timestamp

  // Update
  officeState.update(dt)
  updateCamera(dt)

  // Render
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const mapW = officeState.layout.cols * TILE_SIZE * zoom
  const mapH = officeState.layout.rows * TILE_SIZE * zoom
  const offsetX = Math.floor((canvas.width - mapW) / 2) + Math.round(panX)
  const offsetY = Math.floor((canvas.height - mapH) / 2) + Math.round(panY)

  renderTileGrid(ctx, officeState.tileMap, offsetX, offsetY, zoom)
  renderScene(ctx, officeState.furniture, officeState.getCharacters(), offsetX, offsetY, zoom,
              officeState.selectedAgentId, officeState.hoveredAgentId)

  // UI overlay
  updateOverlay()

  requestAnimationFrame(gameLoop)
}
```

### Step 7: Add UI overlay

```javascript
function updateOverlay() {
  const count = officeState.characters.size
  document.getElementById('overlay').textContent = `${count} agent${count !== 1 ? 's' : ''}`
}

function updateStatus(msg) {
  document.getElementById('status').textContent = msg
}
```

### Step 8: Add initialization

```javascript
// Create office state with default layout
const officeState = new OfficeState(createDefaultLayout())

// Start
connectWebSocket()
requestAnimationFrame(gameLoop)
```

Close the `</script></body></html>` tags.

### Step 9: Verify end-to-end

1. Run: `cd standalone && bun run server.ts`
2. Open `http://localhost:4242` in browser
3. Expected: see the default office rendered with pixel art tiles, desks, chairs, plants
4. Start a Claude Code session in a terminal
5. Expected: a character spawns (matrix effect) and walks to a desk within ~3s
6. When Claude uses tools: character should show typing/reading animation
7. When turn ends: character goes idle, wanders

### Step 10: Commit

```bash
git add standalone/index.html
git commit -m "feat: complete standalone client with WebSocket, canvas, and game loop"
```

---

## Task 7: Polish and Integration Testing

**Files:**
- Modify: `standalone/server.ts` (bug fixes)
- Modify: `standalone/index.html` (bug fixes)

### Step 1: Test with real Claude Code sessions

1. Start the server: `bun run standalone/server.ts`
2. Open browser: `http://localhost:4242`
3. Start 2-3 Claude Code sessions (mix of terminal and chat mode)
4. Verify:
   - Characters appear within 3s of session start
   - Tool animations match (typing for Write/Edit/Bash, reading for Read/Grep/Glob)
   - Waiting bubble appears when turn ends
   - Permission bubble ("...") appears when agent waits for user input >7s
   - Sub-agents spawn when Task tool is used
   - Characters despawn when sessions are inactive >2min
   - Zoom and pan work correctly
   - Multiple clients can connect simultaneously

### Step 2: Fix any issues found during testing

Common issues to watch for:
- JSONL path detection across different OS project hash formats
- Partial JSON line handling (line buffer)
- WebSocket reconnection after server restart
- Canvas DPR handling for high-DPI displays
- Z-sort edge cases with furniture and characters

### Step 3: Final commit

```bash
git add standalone/
git commit -m "fix: polish standalone mode after integration testing"
```

---

## Summary

| Task | Description | Key files |
|------|------------|-----------|
| 1 | Server: HTTP + WS + JSONL scanning/parsing | `standalone/server.ts` |
| 2 | Client: HTML shell + constants + types | `standalone/index.html` |
| 3 | Client: All sprite data (characters, furniture, bubbles) | `standalone/index.html` |
| 4 | Client: Game engine (colorize, cache, pathfinding, FSM, matrix) | `standalone/index.html` |
| 5 | Client: Layout + office state + renderer | `standalone/index.html` |
| 6 | Client: WebSocket + canvas + interactions + game loop | `standalone/index.html` |
| 7 | Integration testing and polish | both files |

**Total estimated code:** ~350 lines server + ~3500 lines client = ~3850 lines across 2 files.
