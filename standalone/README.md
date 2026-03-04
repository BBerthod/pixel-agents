# Pixel Agents Standalone Server

A web dashboard that visualizes Claude Code agent activity as animated pixel art characters. Scans `~/.claude/projects/` for JSONL transcripts and broadcasts real-time agent state via WebSocket.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) running on the host machine
- Active Claude sessions producing JSONL transcripts in `~/.claude/projects/`

## Quick Start (Docker)

```bash
# Clone and configure
git clone https://github.com/pablodelucca/pixel-agents.git
cd pixel-agents
cp standalone/.env.example standalone/.env
# Edit standalone/.env to set SSH_HOST, timeouts, etc.

# Build and run
docker compose up -d
```

Open `http://localhost:4242` in your browser.

## Quick Start (Bare Metal)

Requires [Bun](https://bun.sh) 1.0+.

```bash
git clone https://github.com/pablodelucca/pixel-agents.git
cd pixel-agents

# Build the webview
cd webview-ui && npm install && npm run build && cd ..

# Configure
cp standalone/.env.example standalone/.env
# Edit standalone/.env

# Run
bun run standalone/server.ts
```

## Configuration

All settings live in `standalone/.env`. Copy `.env.example` to get started.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4242` | Server port |
| `SSH_HOST` | *(empty)* | Hostname for `vscode://` remote links. Leave empty to disable. |
| `PROJECT_FILTER` | *(empty)* | Scan only this project hash. Leave empty for all projects. |
| `INACTIVE_TIMEOUT_MS` | `1800000` | Hide agents after 30 min of inactivity |
| `NEW_FILE_THRESHOLD_MS` | `1800000` | Adopt sessions modified within the last 30 min at startup |
| `NEW_FILE_THRESHOLD_SHORT_MS` | `180000` | Shorter adoption threshold (3 min) for high-churn projects |
| `SHORT_THRESHOLD_PROJECTS` | *(empty)* | Comma-separated project names using the short threshold |
| `EXCLUDED_PROJECTS` | *(empty)* | Comma-separated project names to skip |

CLI flags `--port`, `--project`, `--ssh-host` override `.env` values.

## Docker Compose Variables

The `docker-compose.yml` reads these additional variables from your shell or a root `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_DIR` | `~/.claude` | Path to the Claude config directory on the host |
| `PIXEL_AGENTS_DIR` | `~/.pixel-agents` | Path to layout storage on the host |

## Reverse Proxy

The server runs plain HTTP. Place it behind a reverse proxy for HTTPS.

### Traefik

Create a file config (e.g., `pixel-agents.yml`) in your Traefik dynamic config directory:

```yaml
http:
  routers:
    pixel-agents:
      rule: "Host(`pixels.example.com`)"
      entrypoints: [websecure]
      service: pixel-agents
      tls:
        certResolver: letsencrypt
  services:
    pixel-agents:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:4242"
```

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name pixels.example.com;

    location / {
        proxy_pass http://127.0.0.1:4242;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

WebSocket upgrade headers are required for real-time updates.

## How It Works

1. The server scans `~/.claude/projects/` every second for JSONL transcript files
2. New or modified files are parsed for `tool_use`, `tool_result`, and `turn_duration` records
3. Agent state changes broadcast to all connected WebSocket clients
4. The React webview renders agents as animated pixel art characters in an office scene

## Project Hash

Claude Code stores transcripts in `~/.claude/projects/<hash>/`. The hash derives from the workspace path with `/`, `\`, and `:` replaced by `-`. For example:

- `/home/user/my-project` becomes `-home-user-my-project`
- Use `PROJECT_FILTER` to limit scanning to one project
