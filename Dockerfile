# ── Stage 1: Build React webview ─────────────────────────────────
FROM node:22-slim AS webview-build
WORKDIR /app/webview-ui
COPY webview-ui/package.json webview-ui/package-lock.json ./
RUN npm ci
COPY webview-ui/ ./
RUN npm run build
# Output: /app/dist/webview/

# ── Stage 2: Bun runtime ────────────────────────────────────────
FROM oven/bun:1
WORKDIR /app

# Install pngjs (only runtime dependency)
RUN bun add pngjs

# Copy standalone server
COPY standalone/ ./standalone/

# Copy assets (PNG parsing at startup)
COPY webview-ui/public/ ./webview-ui/public/

# Copy built webview from stage 1
COPY --from=webview-build /app/dist/webview/ ./dist/webview/

EXPOSE 4242
CMD ["bun", "run", "standalone/server.ts"]
