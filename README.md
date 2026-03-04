# Pixel Agents

A pixel art web dashboard that visualizes your Claude Code agents as animated characters in a virtual office. Each active Claude session becomes a character that walks around, sits at desks, and reflects what the agent is doing in real time — typing when writing code, reading when searching files, waiting when it needs your attention.

![Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## Quick Start

```bash
git clone https://github.com/avrilconseil/pixel-agents.git
cd pixel-agents
cp standalone/.env.example standalone/.env
# Edit standalone/.env (set SSH_HOST for remote vscode:// links, etc.)

docker compose up -d
```

Open `http://localhost:4242`. Any active Claude Code session on the host appears as a character within seconds.

See [standalone/README.md](standalone/README.md) for bare metal setup, configuration reference, and reverse proxy examples (Traefik, Nginx).

## Features

- **Auto-discovery** — scans `~/.claude/projects/` for active JSONL transcripts, no manual setup required
- **Live activity tracking** — characters animate based on what the agent is doing (writing, reading, running commands)
- **Speech bubbles** — visual indicators when an agent needs permission or has finished its turn
- **Sub-agent visualization** — Task tool sub-agents spawn as separate characters linked to their parent
- **Office layout editor** — design your office with floors, walls, and furniture
- **Persistent layouts** — office design saved to `~/.pixel-agents/layout.json`
- **Click-to-open** — click a character to open its VS Code terminal via `vscode://` remote link (requires `SSH_HOST`)
- **Multi-project support** — monitor agents across all projects, or filter to a specific one

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

6 diverse character skins, based on [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack). Beyond 6 agents, skins repeat with randomized hue shifts.

## How It Works

The standalone Bun server scans `~/.claude/projects/` every second for JSONL transcript files. When an agent uses a tool (writing a file, running a command, searching code), the server parses the JSONL event and broadcasts the state change to all connected browsers via WebSocket.

The browser renders a lightweight game loop with canvas rendering, BFS pathfinding, and a character state machine (idle → walk → type/read). Everything is pixel-perfect at integer zoom levels.

No modifications to Claude Code are needed — Pixel Agents is purely observational.

## Configuration

All settings in `standalone/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4242` | Server port |
| `SSH_HOST` | *(empty)* | Hostname for `vscode://` remote links |
| `PROJECT_FILTER` | *(empty)* | Scan a single project hash (leave empty for all) |
| `INACTIVE_TIMEOUT_MS` | `1800000` | Hide agents after 30 min of inactivity |

Full configuration reference in [standalone/README.md](standalone/README.md).

## Office Assets

The office tileset is **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by **Donarg** ($2 on itch.io). It is not included in this repository due to its license. To use the full furniture catalog, purchase the tileset and run:

```bash
npm run import-tileset
```

Pixel Agents works without the tileset — you get the default characters and basic layout.

## Origin

This project is a fork of [pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents), originally built as a [VS Code extension](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents). The standalone server extracts the core functionality into a self-hosted web dashboard, independent of VS Code.

## License

[MIT License](LICENSE)
