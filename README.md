# Pixel Agents

A self-hosted pixel art dashboard that turns your Claude Code agents into animated characters in a virtual office.

Deploy it on any machine running Claude Code. The server auto-discovers active sessions, parses JSONL transcripts in real time, and streams agent activity to your browser via WebSocket. Each agent becomes a character that walks around, sits at desks, types when writing code, reads when searching files, and waits when it needs your attention.

![Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## Deploy in 30 Seconds

```bash
git clone https://github.com/avrilconseil/pixel-agents.git
cd pixel-agents
cp standalone/.env.example standalone/.env
docker compose up -d
```

Open **http://localhost:4242** — every active Claude Code session on the host appears as a character within seconds.

That's it. No VS Code required, no Claude Code plugin, no config beyond the `.env`. Put it behind a reverse proxy for HTTPS.

## Deploy Without Docker

Requires [Bun](https://bun.sh) 1.0+.

```bash
git clone https://github.com/avrilconseil/pixel-agents.git
cd pixel-agents
cd webview-ui && npm install && npm run build && cd ..
cp standalone/.env.example standalone/.env
bun run standalone/server.ts
```

## What You See

- **Auto-discovery** — scans `~/.claude/projects/` every second, no manual setup
- **Live activity** — characters animate based on what the agent does (Write, Read, Bash, Grep...)
- **Speech bubbles** — permission requests and turn completion indicators
- **Sub-agents** — Task tool sub-agents spawn as linked characters next to their parent
- **Office editor** — design your office with floors, walls, furniture, and color customization
- **Click-to-open** — click a character to jump to its VS Code terminal via `vscode://` remote link
- **Multi-project** — monitor all projects at once, or filter to one

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

6 character skins based on [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack). Beyond 6 simultaneous agents, skins repeat with randomized hue shifts.

## Configuration

Edit `standalone/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4242` | Server port |
| `SSH_HOST` | *(empty)* | Hostname for `vscode://` remote links |
| `PROJECT_FILTER` | *(empty)* | Limit to a single project hash |
| `INACTIVE_TIMEOUT_MS` | `1800000` | Hide agents after 30 min of inactivity |
| `SHORT_THRESHOLD_PROJECTS` | *(empty)* | High-churn projects using shorter adoption window |
| `EXCLUDED_PROJECTS` | *(empty)* | Projects to skip entirely |

CLI overrides: `bun run standalone/server.ts --port 8080 --ssh-host myserver.com --project <hash>`

Full reference: [standalone/README.md](standalone/README.md) (reverse proxy examples for Traefik and Nginx included).

## How It Works

1. The Bun server scans `~/.claude/projects/` for JSONL transcript files
2. New tool_use / tool_result / turn_duration events are parsed and broadcast via WebSocket
3. The React frontend renders a pixel-perfect game loop: canvas rendering, BFS pathfinding, character FSM (idle → walk → type/read)

No modifications to Claude Code — purely observational.

## Office Assets

The office tileset is **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by **Donarg** ($2 on itch.io), not included due to its license. To use the full furniture catalog:

```bash
npm install && npm run import-tileset
```

Pixel Agents works without it — default characters and basic layout included.

## Origin

Fork of [pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents), originally a [VS Code extension](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents). This version extracts the core into a standalone web dashboard.

## License

[MIT](LICENSE)
