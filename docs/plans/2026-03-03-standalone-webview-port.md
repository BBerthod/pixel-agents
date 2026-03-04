# Standalone Webview Port — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the existing VS Code webview (React/Vite) to run in a browser, served by the standalone Bun server — visually identical to the extension.

**Architecture:** Modify `vscodeApi.ts` to detect standalone mode and use WebSocket instead of `acquireVsCodeApi()`. Server loads PNG assets via pngjs and sends the exact same messages as the extension. Vite builds the webview; server serves the static files + WebSocket.

**Tech Stack:** Bun (server), React + Vite (existing webview), pngjs (PNG → SpriteData), WebSocket

---

### Task 1: Dual-Mode Transport Layer (`vscodeApi.ts`)

**Files:**
- Modify: `webview-ui/src/vscodeApi.ts`

**Context:** Currently 3 lines — `acquireVsCodeApi()` export. The webview listens on `window.addEventListener('message', handler)` and sends via `vscode.postMessage()`. We need to detect if we're in a browser (no `acquireVsCodeApi`) and use WebSocket instead. The message handler already listens on `window` events, so dispatching `MessageEvent` on `window` makes the entire webview work unchanged.

**Step 1: Rewrite `vscodeApi.ts` for dual-mode**

```typescript
// Detect standalone mode: acquireVsCodeApi exists only in VS Code webview context
const isStandalone = typeof acquireVsCodeApi === 'undefined'

interface VsCodeApi {
  postMessage(msg: unknown): void
}

function createStandaloneApi(): VsCodeApi {
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/ws`)

    ws.onopen = () => {
      console.log('[Standalone] WebSocket connected')
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        // Dispatch as MessageEvent on window — useExtensionMessages listens here
        window.dispatchEvent(new MessageEvent('message', { data: msg }))
      } catch (err) {
        console.error('[Standalone] Failed to parse WS message:', err)
      }
    }

    ws.onclose = () => {
      console.log('[Standalone] WebSocket disconnected, reconnecting in 2s...')
      reconnectTimer = setTimeout(connect, 2000)
    }
  }

  connect()

  return {
    postMessage(msg: unknown) {
      // In standalone, most webview→extension messages are no-ops
      // The only one we handle is 'webviewReady' — server sends assets on connect anyway
      const m = msg as { type?: string }
      if (m.type === 'webviewReady' && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg))
      }
      // All other messages (saveLayout, saveAgentSeats, focusAgent, openClaude, etc.)
      // are silently dropped in standalone mode — there's no extension to handle them
    },
  }
}

declare function acquireVsCodeApi(): VsCodeApi

export const vscode: VsCodeApi = isStandalone
  ? createStandaloneApi()
  : acquireVsCodeApi()

export { isStandalone }
```

**Step 2: Build webview and verify no compile errors**

Run: `cd webview-ui && npx vite build`
Expected: Build succeeds with no errors.

**Step 3: Commit**

```bash
git add webview-ui/src/vscodeApi.ts
git commit -m "feat: dual-mode vscodeApi — WebSocket transport for standalone"
```

---

### Task 2: Server — Asset Loading

**Files:**
- Modify: `standalone/server.ts`

**Context:** The server needs to load PNG assets using pngjs (already a project dependency) and send the exact same messages the extension sends. The asset loading code can be ported directly from `src/assetLoader.ts`. Assets live at `webview-ui/public/assets/` (relative to project root).

**Step 1: Add pngjs import and PNG→SpriteData conversion**

Port `pngToSpriteData()` from `src/assetLoader.ts:116-162`. Add `import { PNG } from 'pngjs'` at the top of server.ts.

Constants needed (inline, matching `src/constants.ts`):
```typescript
const PNG_ALPHA_THRESHOLD = 128
const WALL_PIECE_WIDTH = 16
const WALL_PIECE_HEIGHT = 32
const WALL_GRID_COLS = 4
const WALL_BITMASK_COUNT = 16
const FLOOR_PATTERN_COUNT = 7
const FLOOR_TILE_SIZE = 16
const CHAR_COUNT = 6
const CHAR_FRAME_W = 16
const CHAR_FRAME_H = 32
const CHAR_FRAMES_PER_ROW = 7
const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const
```

**Step 2: Add `loadAllAssets()` function**

Loads all assets at server startup and stores them. Port loading logic from `src/assetLoader.ts`:

```typescript
interface LoadedAssets {
  characters: Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
  floorSprites: string[][][]
  wallSprites: string[][][]
  furnitureCatalog: FurnitureAsset[]
  furnitureSprites: Record<string, string[][]>
  layout: Record<string, unknown> | null
}

function loadAllAssets(projectRoot: string): LoadedAssets { ... }
```

This function:
1. **Character sprites**: Read `assets/characters/char_0.png` through `char_5.png` (each 112×96). Split into 3 direction rows × 7 frames (16×32 each). Same logic as `loadCharacterSprites()` in assetLoader.ts.
2. **Floor tiles**: Read `assets/floors.png` (112×16). Split into 7 patterns (16×16). Same as `loadFloorTiles()`.
3. **Wall tiles**: Read `assets/walls.png` (64×128). Split into 16 bitmask pieces (16×32). Same as `loadWallTiles()`.
4. **Furniture**: Read `assets/furniture/furniture-catalog.json`, then each PNG file listed in the catalog. Same as `loadFurnitureAssets()`.
5. **Layout**: Read `~/.pixel-agents/layout.json`, fall back to `assets/default-layout.json`.

All paths relative to `projectRoot` which is resolved at startup as `path.resolve(import.meta.dir, '..')` (project root from `standalone/` dir).

**Step 3: Store loaded assets in module-level variable**

```typescript
let cachedAssets: LoadedAssets | null = null

// Called at startup
function initAssets(): void {
  const projectRoot = path.resolve(import.meta.dir, '..')
  const assetsRoot = path.join(projectRoot, 'webview-ui', 'public')
  cachedAssets = loadAllAssets(assetsRoot)
  console.log(`[Server] Assets loaded: ${cachedAssets.characters.length} characters, ${cachedAssets.floorSprites.length} floor tiles, ${cachedAssets.wallSprites.length} wall tiles, ${Object.keys(cachedAssets.furnitureSprites).length} furniture`)
}
```

**Step 4: Verify assets load**

Run: `cd /home/camillepicolet/projects/pixel-agents && ~/.bun/bin/bun run standalone/server.ts`
Expected: Log shows all assets loaded successfully (6 characters, 7 floor tiles, 16 wall tiles, ~100 furniture).

**Step 5: Commit**

```bash
git add standalone/server.ts
git commit -m "feat: server loads PNG assets via pngjs at startup"
```

---

### Task 3: Server — Send Assets + Extension Message Protocol on WS Connect

**Files:**
- Modify: `standalone/server.ts`

**Context:** When a WebSocket client connects, the server must send the exact same sequence of messages the extension sends: `settingsLoaded` → `characterSpritesLoaded` → `floorTilesLoaded` → `wallTilesLoaded` → `furnitureAssetsLoaded` → `existingAgents` → `layoutLoaded`. The webview's `useExtensionMessages.ts` handler expects these exact message shapes.

**Step 1: Send asset messages on WS connect**

Update the `open(ws)` handler:

```typescript
open(ws) {
  wsClients.add(ws)
  console.log(`[Server] WebSocket client connected (${wsClients.size} total)`)

  if (!cachedAssets) return

  // 1. Settings
  ws.send(JSON.stringify({ type: 'settingsLoaded', soundEnabled: true }))

  // 2. Character sprites (same format as extension's characterSpritesLoaded)
  ws.send(JSON.stringify({
    type: 'characterSpritesLoaded',
    characters: cachedAssets.characters,
  }))

  // 3. Floor tiles
  ws.send(JSON.stringify({
    type: 'floorTilesLoaded',
    sprites: cachedAssets.floorSprites,
  }))

  // 4. Wall tiles
  ws.send(JSON.stringify({
    type: 'wallTilesLoaded',
    sprites: cachedAssets.wallSprites,
  }))

  // 5. Furniture
  ws.send(JSON.stringify({
    type: 'furnitureAssetsLoaded',
    catalog: cachedAssets.furnitureCatalog,
    sprites: cachedAssets.furnitureSprites,
  }))

  // 6. Existing agents snapshot (extension format)
  const agentIds: number[] = []
  const agentMeta: Record<number, { isIdle: boolean }> = {}
  const folderNames: Record<number, string> = {}
  for (const agent of agents.values()) {
    agentIds.push(agent.id)
    agentMeta[agent.id] = { isIdle: agent.isWaiting }
    folderNames[agent.id] = agent.folderName
  }
  ws.send(JSON.stringify({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
  }))

  // 7. Layout
  ws.send(JSON.stringify({
    type: 'layoutLoaded',
    layout: cachedAssets.layout,
  }))
}
```

**Step 2: Map server broadcast events to extension message format**

The server currently broadcasts snake_case events (`agent_created`, `tool_start`, etc.) but the webview expects camelCase (`agentCreated`, `agentToolStart`, etc.). Update all `broadcast()` calls:

| Current server event | Extension message format |
|---|---|
| `agent_created` `{agentId, folderName}` | `agentCreated` `{id: agentId, folderName}` |
| `tool_start` `{agentId, toolId, toolName, status}` | `agentToolStart` `{id: agentId, toolId, status}` |
| `tool_done` `{agentId, toolId}` | `agentToolDone` `{id: agentId, toolId}` |
| `agent_waiting` `{agentId}` | `agentStatus` `{id: agentId, status: 'waiting'}` |
| `agent_active` `{agentId}` | `agentToolsClear` `{id: agentId}` + `agentStatus` `{id: agentId, status: 'active'}` |
| `agent_permission` `{agentId}` | `agentToolPermission` `{id: agentId}` |
| `agent_permission_clear` `{agentId}` | `agentToolPermissionClear` `{id: agentId}` |
| `subagent_tool_start` `{agentId, parentToolId, toolId, toolName, status}` | `subagentToolStart` `{id: agentId, parentToolId, toolId, status}` |
| `subagent_tool_done` `{agentId, parentToolId, toolId}` | `subagentToolDone` `{id: agentId, parentToolId, toolId}` |
| `subagent_clear` `{agentId, parentToolId}` | `subagentClear` `{id: agentId, parentToolId}` |
| `subagent_tool_permission` `{agentId, parentToolId}` | `subagentToolPermission` `{id: agentId, parentToolId}` |
| `agent_removed` `{agentId}` | `agentClosed` `{id: agentId}` |

Key differences:
- `agentId` → `id` (the webview reads `msg.id`)
- `agent_active` maps to TWO messages: `agentToolsClear` (clears tool UI) + `agentStatus` active
- `agent_waiting` maps to `agentStatus` with `status: 'waiting'`
- `tool_start` status field already has the right format

**Step 3: Handle `webviewReady` message from client**

Update the `message` handler to handle `webviewReady`:

```typescript
message(ws, message) {
  try {
    const msg = JSON.parse(String(message))
    if (msg.type === 'webviewReady') {
      // Re-send assets if needed (client may have reconnected)
      // Already handled by open() — webviewReady is a no-op here
      console.log('[Server] Received webviewReady from client')
    }
  } catch { /* ignore */ }
}
```

**Step 4: Verify message format matches**

Cross-reference each message type against `useExtensionMessages.ts` handler:
- Line 123: `agentCreated` reads `msg.id` and `msg.folderName` ✓
- Line 131: `agentClosed` reads `msg.id` ✓
- Line 156: `existingAgents` reads `msg.agents`, `msg.agentMeta`, `msg.folderNames` ✓
- Line 175: `agentToolStart` reads `msg.id`, `msg.toolId`, `msg.status` ✓
- Line 197: `agentToolDone` reads `msg.id`, `msg.toolId` ✓
- Line 208: `agentToolsClear` reads `msg.id` ✓
- Line 230: `agentStatus` reads `msg.id`, `msg.status` ✓
- Line 247: `agentToolPermission` reads `msg.id` ✓
- Line 258: `subagentToolPermission` reads `msg.id`, `msg.parentToolId` ✓
- Line 266: `agentToolPermissionClear` reads `msg.id` ✓
- Lines 285-334: subagent messages read `msg.id`, `msg.parentToolId`, `msg.toolId`, `msg.status` ✓

**Step 5: Commit**

```bash
git add standalone/server.ts
git commit -m "feat: server sends extension-format messages on WS connect"
```

---

### Task 4: Server — Static File Serving

**Files:**
- Modify: `standalone/server.ts`

**Context:** The Vite-built webview goes to `dist/webview/`. The server must serve these static files. The entry point is `index.html` with JS/CSS assets.

**Step 1: Add static file serving to the HTTP handler**

Replace the current single-file index.html handler:

```typescript
const WEBVIEW_DIR = path.join(import.meta.dir, '..', 'dist', 'webview')

// MIME types for static files
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

fetch(req, server) {
  const url = new URL(req.url)

  // WebSocket upgrade
  if (url.pathname === '/ws') {
    const upgraded = server.upgrade(req)
    if (!upgraded) return new Response('WebSocket upgrade failed', { status: 400 })
    return undefined as unknown as Response
  }

  // Serve static files from dist/webview/
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname
  const fullPath = path.join(WEBVIEW_DIR, filePath)

  // Security: prevent path traversal
  if (!fullPath.startsWith(WEBVIEW_DIR)) {
    return new Response('Forbidden', { status: 403 })
  }

  try {
    if (!fs.existsSync(fullPath)) {
      // SPA fallback: serve index.html for non-file paths
      const indexPath = path.join(WEBVIEW_DIR, 'index.html')
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf-8')
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      return new Response('Not found', { status: 404 })
    }

    const ext = path.extname(fullPath)
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    const content = fs.readFileSync(fullPath)
    return new Response(content, { headers: { 'Content-Type': contentType } })
  } catch {
    return new Response('Internal Server Error', { status: 500 })
  }
}
```

**Step 2: Build the webview**

Run: `cd webview-ui && npx vite build`
Expected: Output in `dist/webview/` with `index.html`, JS chunks, CSS, font files.

**Step 3: Verify static serving works**

Run: `~/.bun/bin/bun run standalone/server.ts`
Open: `http://localhost:4242`
Expected: The React webview loads in the browser. The canvas should show the office with floor tiles, walls, and furniture (from the actual PNG assets). No characters yet (no active JSONL sessions).

**Step 4: Commit**

```bash
git add standalone/server.ts
git commit -m "feat: server serves built webview static files"
```

---

### Task 5: Standalone UI Adjustments

**Files:**
- Modify: `webview-ui/src/components/BottomToolbar.tsx`
- Modify: `webview-ui/src/components/SettingsModal.tsx`

**Context:** Some UI elements don't make sense in standalone mode: "+ Agent" button (no terminal to open), "Layout" editor toggle (no save capability without extension), some settings. Use the `isStandalone` export from `vscodeApi.ts` to hide these.

**Step 1: Hide extension-only UI in BottomToolbar**

In `BottomToolbar.tsx`, hide the "+ Agent" button, the "Layout" toggle, and workspace folder selector in standalone mode:

```typescript
import { isStandalone } from '../vscodeApi.js'

// In the render, wrap extension-only elements:
{!isStandalone && (
  <button onClick={...}>+ Agent</button>
)}
{!isStandalone && (
  <button onClick={onToggleEdit}>Layout</button>
)}
```

**Step 2: Hide extension-only settings in SettingsModal**

In `SettingsModal.tsx`, hide "Open Sessions Folder", "Export Layout", "Import Layout" in standalone mode:

```typescript
import { isStandalone } from '../vscodeApi.js'

// Wrap:
{!isStandalone && (
  <button onClick={() => vscode.postMessage({ type: 'openSessionsFolder' })}>
    Open Sessions Folder
  </button>
)}
// Same for export/import layout buttons
```

**Step 3: Build and verify**

Run: `cd webview-ui && npx vite build`
Run: `~/.bun/bin/bun run standalone/server.ts`
Expected: The webview loads without the "+ Agent" button, "Layout" button, or extension-only settings.

**Step 4: Commit**

```bash
git add webview-ui/src/components/BottomToolbar.tsx webview-ui/src/components/SettingsModal.tsx
git commit -m "feat: hide extension-only UI elements in standalone mode"
```

---

### Task 6: Integration Testing + Bug Fixes

**Files:**
- Modify: `standalone/server.ts` (fixes)
- Modify: `webview-ui/src/vscodeApi.ts` (fixes)

**Step 1: Build and deploy**

```bash
cd /home/camillepicolet/projects/pixel-agents
cd webview-ui && npx vite build && cd ..
~/.bun/bin/bun run standalone/server.ts
```

**Step 2: Test asset loading**

Open `https://pixels.avril-forge.com` in browser.
Verify:
- Floor tiles render with correct textures (not solid gray)
- Walls render with 3D auto-tile appearance
- Furniture items (desks, chairs, monitors, plants, etc.) are visible
- Layout matches `~/.pixel-agents/layout.json` (not the basic default)

**Step 3: Test agent lifecycle**

Start a Claude Code session in a terminal. Verify:
- Character spawns with matrix effect within ~3s
- Character has colored sprite (from PNG, not template)
- Character walks to a seat
- Folder name label appears

**Step 4: Test tool tracking**

Use Claude Code normally. Verify:
- Typing animation when writing/editing
- Reading animation when reading/searching
- Tool status overlay on hover
- Permission bubble after 7s of no data
- Waiting bubble on turn completion
- Sub-agent character spawns on Task tool
- Sound notification on turn completion

**Step 5: Test interactions**

- Click character → selects (white outline), camera follows
- Click empty space → deselects
- Middle-click drag → pan
- Scroll wheel → zoom in/out
- Click permission bubble → dismisses

**Step 6: Fix any bugs found**

Common issues to watch for:
- WebSocket reconnection after server restart
- Asset message size limits (furniture sprites ~500KB total JSON)
- CSS variables without VS Code fallback values
- Font loading (FS Pixel Sans needs to be in the dist)
- `saveAgentSeats` / `saveLayout` messages causing errors in standalone

**Step 7: Final commit**

```bash
git add -A
git commit -m "fix: standalone integration testing fixes"
```

---

## Summary

| Task | Description | Key Files |
|------|------------|-----------|
| 1 | Dual-mode transport (WS for standalone, postMessage for VS Code) | `webview-ui/src/vscodeApi.ts` |
| 2 | Server loads PNG assets via pngjs | `standalone/server.ts` |
| 3 | Server sends extension-format messages on WS connect | `standalone/server.ts` |
| 4 | Server serves built webview static files | `standalone/server.ts` |
| 5 | Hide extension-only UI in standalone mode | `BottomToolbar.tsx`, `SettingsModal.tsx` |
| 6 | Integration testing + bug fixes | both |

**Key insight:** The webview's `useExtensionMessages.ts` doesn't change at all — it listens on `window 'message'` events regardless of transport. Only `vscodeApi.ts` changes (3 lines → ~50 lines).

**Total new/modified code:** ~50 lines in vscodeApi.ts, ~250 lines in server.ts additions, ~10 lines in UI components = ~310 lines total. The entire existing webview (thousands of lines) is reused unchanged.
