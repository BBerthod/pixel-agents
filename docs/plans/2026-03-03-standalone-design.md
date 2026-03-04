# Pixel Agents Standalone — Design

## Overview

Standalone web app (server + client) that monitors all Claude Code sessions via JSONL files and displays them as animated pixel art characters in a browser, independent of VS Code.

## Architecture

```
~/.claude/projects/<hash>/*.jsonl
        │
        ▼
standalone/server.ts (Bun)     ← scans JSONL, parses, broadcasts
  ├── HTTP: serves index.html
  └── WebSocket: pushes agent events
        │
        ▼
standalone/index.html          ← canvas 2D, sprites, game loop
```

## Server (server.ts)

- **Runtime**: Bun, zero external dependencies
- **Bun.serve()**: HTTP + WebSocket on port 4242
- **File scanner**: Every 1s, scans `~/.claude/projects/` for JSONL files (mtime < 30s = new session)
- **JSONL parser**: Ported from `transcriptParser.ts` — detects `tool_use`, `tool_result`, `turn_duration`, `progress`
- **Permission detection**: Non-exempt tool active >7s with no data → `agent_permission`
- **Cleanup**: JSONL inactive >2min → `agent_removed`
- **Snapshot on connect**: Late-joining clients get current state immediately
- **CLI**: `bun run server.ts [--project <hash>]`

## Client (index.html)

Single self-contained HTML file, no framework, no build step.

### Embedded assets
- Character sprite templates (6 palettes, hardcoded hex arrays from spriteData.ts)
- Basic furniture sprites (desk, chair, plant, bookshelf, PC, cooler, whiteboard, lamp)
- Speech bubble sprites (permission "...", waiting checkmark)
- Simplified default layout (~20x11 grid)

### Engine (ported from extension)
- Character FSM (idle/walk/type) from characters.ts
- BFS pathfinding from tileMap.ts
- Sprite cache (SpriteData → offscreen canvas) from spriteCache.ts
- Z-sorted renderer from renderer.ts
- Matrix spawn/despawn effect from matrixEffect.ts
- Office state management from officeState.ts
- Game loop (requestAnimationFrame, delta-time capped 0.1s)

### Not included (vs extension)
- No layout editor
- No floor/wall PNG sprites (solid colored tiles)
- No furniture catalog loading
- No sound notifications
- No furniture colorization

### Rendering
- Floors: solid colored rectangles
- Walls: solid colored blocks
- Furniture + characters: hardcoded pixel art sprites
- Bubbles: above character heads

### Interactions
- Click character: select, show session-id + tool status overlay
- Mouse wheel: integer zoom (pixel-perfect)
- Middle-click drag: pan viewport
- Agent counter overlay in corner

## WebSocket Protocol

### Events (server → client)

| Event | Trigger | Data |
|---|---|---|
| `snapshot` | Client connects | All current agents + states |
| `agent_created` | New JSONL (mtime < 30s) | id, sessionFile |
| `tool_start` | tool_use in JSONL | agentId, toolId, toolName, status |
| `tool_done` | tool_result in JSONL | agentId, toolId |
| `agent_waiting` | turn_duration in JSONL | agentId |
| `agent_active` | New user prompt | agentId |
| `agent_permission` | Tool >7s no data | agentId |
| `subagent_tool_start` | progress + tool_use | agentId, parentToolId, toolId, status |
| `subagent_tool_done` | progress + tool_result | agentId, parentToolId, toolId |
| `agent_removed` | JSONL inactive >2min | id |

### Sub-agent handling
- `Task` tool_use → track parentToolUseID
- Nested progress records → subagent_tool_start/done
- Parent Task tool_result → remove all sub-agents for that task

## Layout

Hardcoded simplified office:
- ~20x11 tile grid
- 6 desks with chairs (expandable)
- Decorative: plants, bookshelves, cooler
- Solid colored floor/walls (no PNGs)

## Deployment

```bash
scp standalone/server.ts standalone/index.html user@server:~/pixel-agents-standalone/
ssh user@server "cd ~/pixel-agents-standalone && bun run server.ts"
```

Access: SSH port forward (`-L 4242:localhost:4242`) or Traefik reverse proxy.

## Code reuse from extension

Directly portable (pure functions, no VS Code/React deps):
- `spriteData.ts` — sprite templates, palettes, furniture sprites
- `spriteCache.ts` — SpriteData → canvas cache
- `characters.ts` — character FSM
- `tileMap.ts` — BFS pathfinding
- `renderer.ts` — canvas rendering (subset: no editor overlays)
- `officeState.ts` — game world state (simplified)
- `matrixEffect.ts` — spawn/despawn animation
- `gameLoop.ts` — rAF loop
- `transcriptParser.ts` — JSONL parsing (strip vscode types, use callbacks)
- `colorize.ts` — for hue shift on agents >6
