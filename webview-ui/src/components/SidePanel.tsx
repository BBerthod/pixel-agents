import { useState, useEffect, useRef } from 'react'
import type { HistoryEntry, AgentStats } from '../hooks/useExtensionMessages.js'
import type { ToolActivity } from '../office/types.js'
import { isStandalone } from '../vscodeApi.js'

interface SidePanelProps {
  isOpen: boolean
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  agentHistory: Record<number, HistoryEntry[]>
  globalFeed: HistoryEntry[]
  agentStats: Record<number, AgentStats>
  folderNames: Record<number, string>
  sshHost: string | null
  onSelectAgent: (id: number) => void
}

type Tab = 'agents' | 'activity' | 'stats'

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  const m = Math.floor(diff / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

function formatDuration(startTime: number, endTime?: number): string | null {
  if (!endTime) return null
  const ms = endTime - startTime
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

function getStatusColor(status: string): string {
  if (status === 'active') return 'var(--pixel-status-active)'
  if (status === 'permission') return 'var(--pixel-status-permission)'
  return 'rgba(255,255,255,0.35)'
}

/** Top N tools from history entries, sorted by count desc */
function topTools(entries: HistoryEntry[], n: number): Array<{ name: string; count: number }> {
  const counts: Record<string, number> = {}
  for (const e of entries) {
    const name = e.toolName || 'Unknown'
    counts[name] = (counts[name] || 0) + 1
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }))
}

/** Check if last N consecutive tools are the same (loop detection) */
function detectLoop(entries: HistoryEntry[], threshold = 10): string | null {
  if (entries.length < threshold) return null
  const recent = entries.slice(-threshold)
  const first = recent[0].toolName
  if (recent.every(e => e.toolName === first)) return first
  return null
}

/** Build vscode:// URI for a file path */
function buildVscodeUri(filePath: string, sshHost: string | null): string | null {
  if (!filePath) return null
  if (isStandalone && sshHost) {
    return `vscode://vscode-remote/ssh-remote+${sshHost}${filePath}`
  }
  if (isStandalone) {
    return `vscode://file${filePath}`
  }
  return null
}

export function SidePanel({
  isOpen,
  agents,
  agentTools,
  agentStatuses,
  agentHistory,
  globalFeed,
  agentStats,
  folderNames,
  sshHost,
  onSelectAgent,
}: SidePanelProps) {
  const [tab, setTab] = useState<Tab>('agents')
  const [hoveredAgent, setHoveredAgent] = useState<number | null>(null)
  const [activityFilter, setActivityFilter] = useState('')
  // Alert state: agentId -> { permission: boolean, loop: string | null }
  const [alerts, setAlerts] = useState<Record<number, { permission: boolean; loop: string | null }>>({})
  // Tick to force re-render for relative times
  const [, setTick] = useState(0)
  const filterInputRef = useRef<HTMLInputElement>(null)

  // Periodic tick for relative times and alert detection
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1)

      // Detect alerts
      const newAlerts: Record<number, { permission: boolean; loop: string | null }> = {}
      for (const id of agents) {
        const tools = agentTools[id] || []
        const permissionTool = tools.find(t => t.permissionWait && !t.done && t.permissionWaitSince)
        const permissionAlert = permissionTool ? (Date.now() - (permissionTool.permissionWaitSince || 0)) > 30_000 : false

        const history = agentHistory[id] || []
        const loopTool = detectLoop(history)

        if (permissionAlert || loopTool) {
          newAlerts[id] = { permission: permissionAlert, loop: loopTool }
        }
      }
      setAlerts(newAlerts)
    }, 1000)
    return () => clearInterval(interval)
  }, [agents, agentTools, agentHistory])

  if (!isOpen) return null

  const tabBtnStyle = (t: Tab): React.CSSProperties => ({
    flex: 1,
    padding: '7px 0',
    fontSize: '22px',
    background: tab === t ? 'var(--pixel-active-bg)' : 'transparent',
    color: tab === t ? 'var(--pixel-text)' : 'var(--pixel-text-dim)',
    border: 'none',
    borderBottom: tab === t ? '2px solid var(--pixel-accent)' : '2px solid transparent',
    borderRadius: 0,
    cursor: 'pointer',
  })

  // Total alert count
  const alertCount = Object.keys(alerts).length

  // Filtered activity feed
  const filterLower = activityFilter.toLowerCase()
  const filteredFeed = filterLower
    ? [...globalFeed].reverse().filter(e => {
        const folder = (folderNames[e.agentId] || `Agent ${e.agentId}`).toLowerCase()
        const tool = (e.toolName || '').toLowerCase()
        const status = e.status.toLowerCase()
        return folder.includes(filterLower) || tool.includes(filterLower) || status.includes(filterLower)
      })
    : [...globalFeed].reverse()

  return (
    <div
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        height: '100%',
        width: 280,
        background: 'rgba(30,30,46,0.97)',
        borderLeft: '2px solid var(--pixel-border)',
        boxShadow: '-2px 0 0 #0a0a14',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 'var(--pixel-panel-z)',
        overflow: 'hidden',
      }}
    >
      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '2px solid var(--pixel-border)', flexShrink: 0 }}>
        <button style={tabBtnStyle('agents')} onClick={() => setTab('agents')}>
          Agents
          {alertCount > 0 && (
            <span style={{
              marginLeft: 5,
              background: 'var(--pixel-status-permission)',
              color: '#000',
              fontSize: '16px',
              padding: '0 4px',
              borderRadius: 0,
              fontWeight: 'bold',
            }}>
              {alertCount}
            </span>
          )}
        </button>
        <button style={tabBtnStyle('activity')} onClick={() => setTab('activity')}>Activity</button>
        <button style={tabBtnStyle('stats')} onClick={() => setTab('stats')}>Stats</button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>

        {/* ── Agents tab ── */}
        {tab === 'agents' && (
          <div>
            {agents.length === 0 && (
              <div style={{ padding: '14px', color: 'var(--pixel-text-dim)', fontSize: '22px' }}>
                No active agents
              </div>
            )}
            {agents.map((id) => {
              const tools = agentTools[id] || []
              const activeTool = [...tools].reverse().find((t) => !t.done)
              const status = agentStatuses[id] || 'active'
              const folder = folderNames[id] || `Agent ${id}`
              const stats = agentStats[id]
              const isHovered = hoveredAgent === id
              const agentAlert = alerts[id]

              return (
                <div
                  key={id}
                  onClick={() => onSelectAgent(id)}
                  onMouseEnter={() => setHoveredAgent(id)}
                  onMouseLeave={() => setHoveredAgent(null)}
                  style={{
                    padding: '10px 12px',
                    cursor: 'pointer',
                    background: isHovered ? 'rgba(255,255,255,0.08)' : 'transparent',
                    borderBottom: '1px solid rgba(255,255,255,0.07)',
                    borderLeft: isHovered ? '2px solid var(--pixel-accent)' : '2px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: getStatusColor(status),
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: '22px', color: 'var(--pixel-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {folder}
                    </span>
                    {agentAlert?.permission && (
                      <span style={{ fontSize: '18px', color: 'var(--pixel-status-permission)', flexShrink: 0 }} title="Permission wait >30s">⚠</span>
                    )}
                    {agentAlert?.loop && (
                      <span style={{ fontSize: '18px', color: '#e55', flexShrink: 0 }} title={`Loop: ${agentAlert.loop} ×10+`}>↻</span>
                    )}
                  </div>
                  {activeTool && (
                    <div style={{ fontSize: '20px', color: 'var(--pixel-text-dim)', paddingLeft: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {activeTool.status}
                    </div>
                  )}
                  {!activeTool && status === 'waiting' && (
                    <div style={{ fontSize: '20px', color: 'var(--pixel-green)', paddingLeft: 15 }}>Waiting for input</div>
                  )}
                  {stats && (
                    <div style={{ fontSize: '18px', color: 'rgba(255,255,255,0.35)', paddingLeft: 15, marginTop: 3 }}>
                      {relativeTime(stats.lastActiveAt)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ── Activity tab ── */}
        {tab === 'activity' && (
          <div>
            {/* Filter input */}
            <div style={{ padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
              <input
                ref={filterInputRef}
                type="text"
                placeholder="Filter by agent / tool…"
                value={activityFilter}
                onChange={(e) => setActivityFilter(e.target.value)}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 0,
                  color: 'var(--pixel-text)',
                  fontSize: '20px',
                  padding: '4px 7px',
                  outline: 'none',
                  fontFamily: 'inherit',
                }}
              />
            </div>

            {filteredFeed.length === 0 && (
              <div style={{ padding: '14px', color: 'var(--pixel-text-dim)', fontSize: '22px' }}>
                {activityFilter ? 'No matching activity' : 'No activity yet'}
              </div>
            )}
            {filteredFeed.map((entry, i) => {
              const folder = folderNames[entry.agentId] || `Agent ${entry.agentId}`
              const duration = formatDuration(entry.startTime, entry.endTime)
              const uri = entry.filePath ? buildVscodeUri(entry.filePath, sshHost) : null
              return (
                <div
                  key={`${entry.toolId}-${i}`}
                  onClick={uri ? () => window.open(uri, '_blank') : undefined}
                  style={{
                    padding: '7px 12px',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    cursor: uri ? 'pointer' : 'default',
                  }}
                  onMouseEnter={e => { if (uri) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.05)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 2 }}>
                    <span style={{ fontSize: '18px', color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>{formatTime(entry.startTime)}</span>
                    <span style={{ fontSize: '20px', color: 'var(--pixel-accent)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder}</span>
                    {duration && (
                      <span style={{ fontSize: '18px', color: 'rgba(255,255,255,0.35)', marginLeft: 'auto', flexShrink: 0 }}>{duration}</span>
                    )}
                  </div>
                  <div style={{ fontSize: '20px', color: uri ? 'var(--pixel-accent)' : 'var(--pixel-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.status}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Stats tab ── */}
        {tab === 'stats' && (
          <div>
            {agents.length === 0 && (
              <div style={{ padding: '14px', color: 'var(--pixel-text-dim)', fontSize: '22px' }}>
                No agents
              </div>
            )}
            {agents.map((id) => {
              const stats = agentStats[id]
              const folder = folderNames[id] || `Agent ${id}`
              const history = agentHistory[id] || []
              if (!stats) return null
              const dominant = topTools(history, 3)
              return (
                <div key={id} style={{ padding: '12px', borderBottom: '2px solid var(--pixel-border)' }}>
                  <div style={{ fontSize: '22px', color: 'var(--pixel-text)', marginBottom: 8 }}>
                    {folder}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 8px', fontSize: '20px' }}>
                    <span style={{ color: 'var(--pixel-text-dim)' }}>Tools used</span>
                    <span style={{ color: 'var(--pixel-text)' }}>{stats.totalTools}</span>
                    <span style={{ color: 'var(--pixel-text-dim)' }}>Active</span>
                    <span style={{ color: 'var(--pixel-status-active)' }}>{formatMs(stats.activeMs)}</span>
                    <span style={{ color: 'var(--pixel-text-dim)' }}>Waiting</span>
                    <span style={{ color: 'var(--pixel-green)' }}>{formatMs(stats.waitingMs)}</span>
                    <span style={{ color: 'var(--pixel-text-dim)' }}>History</span>
                    <span style={{ color: 'var(--pixel-text)' }}>{history.length} entries</span>
                  </div>
                  {dominant.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: '18px', color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Top tools</div>
                      {dominant.map(({ name, count }) => (
                        <div key={name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '20px', marginBottom: 2 }}>
                          <span style={{ color: 'var(--pixel-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                          <span style={{ color: 'var(--pixel-text)', flexShrink: 0, marginLeft: 8 }}>×{count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
