// Detect standalone mode: acquireVsCodeApi exists only in VS Code webview context
const isStandalone = typeof acquireVsCodeApi === 'undefined'

interface VsCodeApi {
  postMessage(msg: unknown): void
}

function createStandaloneApi(): VsCodeApi {
  let ws: WebSocket | null = null

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/ws`)

    ws.onopen = () => {
      console.log('[Standalone] WebSocket connected')
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string)
        // Dispatch as MessageEvent on window — useExtensionMessages listens here
        window.dispatchEvent(new MessageEvent('message', { data: msg }))
      } catch (err) {
        console.error('[Standalone] Failed to parse WS message:', err)
      }
    }

    ws.onclose = () => {
      console.log('[Standalone] WebSocket disconnected, reconnecting in 2s...')
      setTimeout(connect, 2000)
    }
  }

  connect()

  return {
    postMessage(msg: unknown) {
      // In standalone, most webview→extension messages are no-ops
      const m = msg as { type?: string }
      if ((m.type === 'webviewReady' || m.type === 'saveLayout') && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg))
      }
    },
  }
}

declare function acquireVsCodeApi(): VsCodeApi

export const vscode: VsCodeApi = isStandalone
  ? createStandaloneApi()
  : acquireVsCodeApi()

export { isStandalone }
