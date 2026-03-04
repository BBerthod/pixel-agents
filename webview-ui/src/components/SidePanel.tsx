import { useState } from 'react'
import type { HistoryEntry, AgentStats } from '../hooks/useExtensionMessages.js'
import type { ToolActivity } from '../office/types.js'

interface SidePanelProps {
  isOpen: boolean
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  agentHistory: Record<number, HistoryEntry[]>
  globalFeed: HistoryEntry[]
  agentStats: Record<number, AgentStats>
  folderNames: Record<number, string>
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

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

function getStatusColor(status: string): string {
  if (status === 'active') return 'var(--pixel-status-active)'
  if (status === 'permission') return 'var(--pixel-status-permission)'
  return 'rgba(255,255,255,0.35)'
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
  onSelectAgent,
}: SidePanelProps) {
  const [tab, setTab] = useState<Tab>('agents')
  const [hoveredAgent, setHoveredAgent] = useState<number | null>(null)

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
        <button style={tabBtnStyle('agents')} onClick={() => setTab('agents')}>Agents</button>
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
                    <span style={{ fontSize: '22px', color: 'var(--pixel-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {folder}
                    </span>
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
            {globalFeed.length === 0 && (
              <div style={{ padding: '14px', color: 'var(--pixel-text-dim)', fontSize: '22px' }}>
                No activity yet
              </div>
            )}
            {[...globalFeed].reverse().map((entry, i) => {
              const folder = folderNames[entry.agentId] || `Agent ${entry.agentId}`
              return (
                <div
                  key={`${entry.toolId}-${i}`}
                  style={{
                    padding: '7px 12px',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 2 }}>
                    <span style={{ fontSize: '18px', color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>{formatTime(entry.startTime)}</span>
                    <span style={{ fontSize: '20px', color: 'var(--pixel-accent)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder}</span>
                  </div>
                  <div style={{ fontSize: '20px', color: 'var(--pixel-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
