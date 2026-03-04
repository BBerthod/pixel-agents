import { useState, useEffect, useRef } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfficeLayout, ToolActivity } from '../office/types.js'
import { extractToolName } from '../office/toolUtils.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { vscode } from '../vscodeApi.js'
import { playDoneSound, setSoundEnabled } from '../notificationSound.js'

export interface HistoryEntry {
  toolId: string
  toolName: string
  status: string
  startTime: number
  endTime?: number
  agentId: number
  filePath?: string
}

export interface AgentStats {
  totalTools: number
  activeMs: number
  waitingMs: number
  lastActiveAt: number
  statusChangedAt: number
  currentStatus: 'active' | 'waiting' | 'idle'
}

export interface SubagentCharacter {
  id: number
  parentAgentId: number
  parentToolId: string
  label: string
}

export interface FurnitureAsset {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  partOfGroup?: boolean
  groupId?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
}

export interface WorkspaceFolder {
  name: string
  path: string
}

export interface ExtensionMessageState {
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  layoutReady: boolean
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> }
  workspaceFolders: WorkspaceFolder[]
  sshHost: string | null
  agentHistory: Record<number, HistoryEntry[]>
  globalFeed: HistoryEntry[]
  agentStats: Record<number, AgentStats>
  folderNames: Record<number, string>
}

// ── localStorage helpers ──────────────────────────────────────

const LS_KEYS = {
  agentHistory: 'pixel-agents:agentHistory',
  globalFeed: 'pixel-agents:globalFeed',
  agentStats: 'pixel-agents:agentStats',
  folderNames: 'pixel-agents:folderNames',
}

function lsLoad<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw) as T
  } catch { /* ignore */ }
  return fallback
}

function lsSave(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* ignore quota errors */ }
}

function saveAgentSeats(os: OfficeState): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {}
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId }
  }
  vscode.postMessage({ type: 'saveAgentSeats', seats })
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([])
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null)
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({})
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({})
  const [subagentTools, setSubagentTools] = useState<Record<number, Record<string, ToolActivity[]>>>({})
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([])
  const [layoutReady, setLayoutReady] = useState(false)
  const [loadedAssets, setLoadedAssets] = useState<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>()
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([])
  const [sshHost, setSshHost] = useState<string | null>(null)
  const [agentHistory, setAgentHistory] = useState<Record<number, HistoryEntry[]>>(() => lsLoad(LS_KEYS.agentHistory, {}))
  const [globalFeed, setGlobalFeed] = useState<HistoryEntry[]>(() => lsLoad(LS_KEYS.globalFeed, []))
  const [agentStats, setAgentStats] = useState<Record<number, AgentStats>>(() => lsLoad(LS_KEYS.agentStats, {}))
  const [folderNames, setFolderNames] = useState<Record<number, string>>(() => lsLoad(LS_KEYS.folderNames, {}))

  // Persist to localStorage whenever state changes
  useEffect(() => { lsSave(LS_KEYS.agentHistory, agentHistory) }, [agentHistory])
  useEffect(() => { lsSave(LS_KEYS.globalFeed, globalFeed) }, [globalFeed])
  useEffect(() => { lsSave(LS_KEYS.agentStats, agentStats) }, [agentStats])
  useEffect(() => { lsSave(LS_KEYS.folderNames, folderNames) }, [folderNames])

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false)

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{ id: number; palette?: number; hueShift?: number; seatId?: string; folderName?: string; projectPath?: string; isIdle?: boolean }> = []

    const handler = (e: MessageEvent) => {
      const msg = e.data
      const os = getOfficeState()

      if (msg.type === 'layoutLoaded') {
        // Skip external layout updates while editor has unsaved changes
        if (layoutReadyRef.current && isEditDirty?.()) {
          console.log('[Webview] Skipping external layout update — editor has unsaved changes')
          return
        }
        const rawLayout = msg.layout as OfficeLayout | null
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null
        if (layout) {
          os.rebuildFromLayout(layout)
          onLayoutLoaded?.(layout)
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout())
        }
        // Add buffered agents now that layout (and seats) are correct
        const idleOnRestore: number[] = []
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName, p.projectPath)
          if (p.isIdle) {
            os.setAgentActive(p.id, false)
            idleOnRestore.push(p.id)
          }
        }
        if (idleOnRestore.length > 0) {
          console.log(`[Webview] Restored ${idleOnRestore.length} idle agents: [${idleOnRestore}]`)
        }
        pendingAgents = []
        layoutReadyRef.current = true
        setLayoutReady(true)
        if (os.characters.size > 0) {
          saveAgentSeats(os)
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number
        const folderName = msg.folderName as string | undefined
        const projectPath = msg.projectPath as string | undefined
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
        setSelectedAgent(id)
        os.addAgent(id, undefined, undefined, undefined, undefined, folderName, projectPath)
        saveAgentSeats(os)
        if (folderName) {
          setFolderNames((prev) => ({ ...prev, [id]: folderName }))
        }
        setAgentStats((prev) => ({
          ...prev,
          [id]: { totalTools: 0, activeMs: 0, waitingMs: 0, lastActiveAt: Date.now(), statusChangedAt: Date.now(), currentStatus: 'idle' },
        }))
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number
        setAgents((prev) => prev.filter((a) => a !== id))
        setSelectedAgent((prev) => (prev === id ? null : prev))
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.removeAgent(id)
        setAgentStats((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setFolderNames((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      } else if (msg.type === 'existingAgents') {
        const incoming = msg.agents as number[]
        const meta = (msg.agentMeta || {}) as Record<number, { palette?: number; hueShift?: number; seatId?: string; isIdle?: boolean }>
        const incomingFolderNames = (msg.folderNames || {}) as Record<number, string>
        const projectPaths = (msg.projectPaths || {}) as Record<number, string>
        // Buffer agents — they'll be added in layoutLoaded after seats are built
        for (const id of incoming) {
          const m = meta[id]
          pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId, folderName: incomingFolderNames[id], projectPath: projectPaths[id], isIdle: m?.isIdle })
        }
        // Populate folderNames state from restored agents
        setFolderNames((prev) => ({ ...prev, ...incomingFolderNames }))
        // Initialize stats for restored agents
        setAgentStats((prev) => {
          const next = { ...prev }
          for (const id of incoming) {
            if (!(id in next)) {
              next[id] = { totalTools: 0, activeMs: 0, waitingMs: 0, lastActiveAt: Date.now(), statusChangedAt: Date.now(), currentStatus: 'idle' }
            }
          }
          return next
        })
        setAgents((prev) => {
          const ids = new Set(prev)
          const merged = [...prev]
          for (const id of incoming) {
            if (!ids.has(id)) {
              merged.push(id)
            }
          }
          return merged.sort((a, b) => a - b)
        })
      } else if (msg.type === 'agentToolStart') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        const status = msg.status as string
        const msgToolName = (msg.toolName as string | undefined) || extractToolName(status) || status
        const startTime = (msg.timestamp as number | undefined) || Date.now()
        const filePath = msg.filePath as string | undefined
        setAgentTools((prev) => {
          const list = prev[id] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: [...list, { toolId, status, done: false }] }
        })
        // Track history
        const entry: HistoryEntry = { toolId, toolName: msgToolName, status, startTime, agentId: id, filePath }
        setAgentHistory((prev) => {
          const list = prev[id] || []
          const updated = [...list, entry]
          return { ...prev, [id]: updated.slice(-30) }
        })
        setGlobalFeed((prev) => [...prev, entry].slice(-200))
        // Update stats
        setAgentStats((prev) => {
          const s = prev[id] || { totalTools: 0, activeMs: 0, waitingMs: 0, lastActiveAt: startTime, statusChangedAt: startTime, currentStatus: 'idle' as const }
          return { ...prev, [id]: { ...s, totalTools: s.totalTools + 1, lastActiveAt: startTime } }
        })
        const toolName = extractToolName(status)
        os.setAgentTool(id, toolName)
        os.setAgentActive(id, true)
        os.clearPermissionBubble(id)
        // Create sub-agent character for Task tool subtasks
        if (status.startsWith('Subtask:')) {
          const label = status.slice('Subtask:'.length).trim()
          const subId = os.addSubagent(id, toolId)
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev
            return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label }]
          })
        }
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        const endTime = (msg.timestamp as number | undefined) || Date.now()
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
          }
        })
        // Update endTime in history
        setAgentHistory((prev) => {
          const list = prev[id]
          if (!list) return prev
          return { ...prev, [id]: list.map((e) => e.toolId === toolId ? { ...e, endTime } : e) }
        })
        setGlobalFeed((prev) => prev.map((e) => e.toolId === toolId && e.agentId === id ? { ...e, endTime } : e))
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number
        setSelectedAgent(id)
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as number
        const status = msg.status as string
        const statusTime = (msg.timestamp as number | undefined) || Date.now()
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: status }
        })
        // Update time-tracking stats
        setAgentStats((prev) => {
          const s = prev[id]
          if (!s) return prev
          const delta = statusTime - s.statusChangedAt
          const newStatus: 'active' | 'waiting' | 'idle' = status === 'active' ? 'active' : status === 'waiting' ? 'waiting' : 'idle'
          return {
            ...prev,
            [id]: {
              ...s,
              activeMs: s.currentStatus === 'active' ? s.activeMs + delta : s.activeMs,
              waitingMs: s.currentStatus === 'waiting' ? s.waitingMs + delta : s.waitingMs,
              statusChangedAt: statusTime,
              currentStatus: newStatus,
              lastActiveAt: status === 'active' ? statusTime : s.lastActiveAt,
            },
          }
        })
        os.setAgentActive(id, status === 'active')
        if (status === 'waiting') {
          os.showWaitingBubble(id)
          playDoneSound()
        }
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as number
        const permissionWaitSince = Date.now()
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true, permissionWaitSince })),
          }
        })
        os.showPermissionBubble(id)
      } else if (msg.type === 'subagentToolPermission') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          os.showPermissionBubble(subId)
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const hasPermission = list.some((t) => t.permissionWait)
          if (!hasPermission) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false, permissionWaitSince: undefined } : t)),
          }
        })
        os.clearPermissionBubble(id)
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId)
          }
        }
      } else if (msg.type === 'subagentToolStart') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const status = msg.status as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {}
          const list = agentSubs[parentToolId] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
        })
        // Update sub-agent character's tool and active state
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          const subToolName = extractToolName(status)
          os.setAgentTool(subId, subToolName)
          os.setAgentActive(subId, true)
        }
      } else if (msg.type === 'subagentToolDone') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          const list = agentSubs[parentToolId]
          if (!list) return prev
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) },
          }
        })
      } else if (msg.type === 'subagentClear') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs || !(parentToolId in agentSubs)) return prev
          const next = { ...agentSubs }
          delete next[parentToolId]
          if (Object.keys(next).length === 0) {
            const outer = { ...prev }
            delete outer[id]
            return outer
          }
          return { ...prev, [id]: next }
        })
        // Remove sub-agent character
        os.removeSubagent(id, parentToolId)
        setSubagentCharacters((prev) => prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)))
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`)
        setCharacterTemplates(characters)
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`)
        setFloorSprites(sprites)
      } else if (msg.type === 'wallTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} wall tile sprites`)
        setWallSprites(sprites)
      } else if (msg.type === 'workspaceFolders') {
        const folders = msg.folders as WorkspaceFolder[]
        setWorkspaceFolders(folders)
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean
        setSoundEnabled(soundOn)
        if (msg.sshHost) setSshHost(msg.sshHost as string)
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[]
          const sprites = msg.sprites as Record<string, string[][]>
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`)
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites })
          setLoadedAssets({ catalog, sprites })
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
        }
      } else if (msg.type === 'agentRecentHistory') {
        const history = msg.history as Record<number, Array<{
          type: 'toolStart' | 'toolDone' | 'status'
          toolId?: string
          toolName?: string
          status?: string
          agentStatus?: string
          timestamp: number
          filePath?: string
        }>>

        // For each agent, reconstruct history entries and stats
        for (const [agentIdStr, events] of Object.entries(history)) {
          const agentId = Number(agentIdStr)
          const historyEntries: HistoryEntry[] = []

          // Build history from toolStart events
          for (const ev of events) {
            if (ev.type === 'toolStart' && ev.toolId && ev.status) {
              const entry: HistoryEntry = {
                toolId: ev.toolId,
                toolName: ev.toolName || ev.status,
                status: ev.status,
                startTime: ev.timestamp,
                agentId,
                filePath: ev.filePath,
              }
              // Find matching toolDone to set endTime
              const doneEv = events.find(e => e.type === 'toolDone' && e.toolId === ev.toolId && e.timestamp > ev.timestamp)
              if (doneEv) entry.endTime = doneEv.timestamp
              historyEntries.push(entry)
            }
          }

          if (historyEntries.length > 0) {
            setAgentHistory((prev) => ({ ...prev, [agentId]: historyEntries.slice(-30) }))
            setGlobalFeed((prev) => {
              const merged = [...prev, ...historyEntries].sort((a, b) => a.startTime - b.startTime)
              return merged.slice(-200)
            })
          }

          // Reconstruct stats from events
          let totalTools = 0
          let activeMs = 0
          let waitingMs = 0
          let lastStatusChange = events[0]?.timestamp || Date.now()
          let currentStatus: 'active' | 'waiting' | 'idle' = 'idle'
          let lastActiveAt = events[0]?.timestamp || Date.now()

          for (const ev of events) {
            if (ev.type === 'toolStart') {
              totalTools++
              lastActiveAt = ev.timestamp
            } else if (ev.type === 'status') {
              const delta = ev.timestamp - lastStatusChange
              if (currentStatus === 'active') activeMs += delta
              else if (currentStatus === 'waiting') waitingMs += delta
              const newStatus: 'active' | 'waiting' | 'idle' = ev.agentStatus === 'active' ? 'active' : ev.agentStatus === 'waiting' ? 'waiting' : 'idle'
              currentStatus = newStatus
              lastStatusChange = ev.timestamp
            }
          }

          setAgentStats((prev) => {
            const existing = prev[agentId]
            if (existing && existing.totalTools > 0) return prev // don't overwrite live data
            return {
              ...prev,
              [agentId]: {
                totalTools,
                activeMs,
                waitingMs,
                lastActiveAt,
                statusChangedAt: lastStatusChange,
                currentStatus,
              },
            }
          })
        }
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'webviewReady' })
    return () => window.removeEventListener('message', handler)
  }, [getOfficeState])

  return { agents, selectedAgent, agentTools, agentStatuses, subagentTools, subagentCharacters, layoutReady, loadedAssets, workspaceFolders, sshHost, agentHistory, globalFeed, agentStats, folderNames }
}
