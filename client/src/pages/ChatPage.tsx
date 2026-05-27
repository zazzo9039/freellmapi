import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import type { Conversation, ChatMessageRecord } from '../../../shared/types'

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  keyCount: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  meta?: {
    platform?: string
    model?: string
    latency?: number
    fallbackAttempts?: number
  }
}

export default function ChatPage() {
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('auto')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const queryClient = useQueryClient()

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)

  // Fetch conversations list
  const { data: conversationsData, isLoading: conversationsLoading } = useQuery<{ success: boolean; data: Conversation[] }>({
    queryKey: ['conversations'],
    queryFn: () => apiFetch('/api/conversations'),
  })
  const conversations = conversationsData?.data ?? []

  // Fetch messages for active conversation
  const { data: messagesData, isLoading: messagesLoading } = useQuery<{ success: boolean; data: ChatMessageRecord[] }>({
    queryKey: ['messages', activeConversationId],
    queryFn: () => apiFetch(`/api/conversations/${activeConversationId}/messages`),
    enabled: activeConversationId != null,
  })
  const messageRecords = messagesData?.data ?? []

  // Map ChatMessageRecord to ChatMessage for display
  const displayMessages: ChatMessage[] = messageRecords.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
    meta: m.meta ?? undefined,
  }))

  const createConversationMutation = useMutation({
    mutationFn: (title?: string) =>
      apiFetch<{ success: boolean; data: Conversation }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    },
  })

  const addMessageMutation = useMutation({
    mutationFn: ({ conversationId, role, content, meta }: { conversationId: number; role: string; content: string; meta?: unknown }) =>
      apiFetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role, content, meta }),
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['messages', variables.conversationId] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    },
  })

  const deleteConversationMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    },
  })

  const updateTitleMutation = useMutation({
    mutationFn: ({ id, title }: { id: number; title: string }) =>
      apiFetch(`/api/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    },
  })

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [displayMessages])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return

    setInput('')
    setLoading(true)
    inputRef.current?.focus()

    try {
      let conversationId = activeConversationId

      // If no active conversation, create one
      if (conversationId === null) {
        const result = await createConversationMutation.mutateAsync(undefined)
        conversationId = result.data.id
        setActiveConversationId(conversationId)
      }

      // Save user message
      await addMessageMutation.mutateAsync({
        conversationId,
        role: 'user',
        content: text,
      })

      // Send to LLM API
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const allMessages = [...displayMessages, { role: 'user' as const, content: text }]
      const body: any = {
        messages: allMessages.map(m => ({ role: m.role, content: m.content })),
      }
      if (selectedModel !== 'auto') body.model = selectedModel

      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const start = Date.now()
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      const latency = Date.now() - start
      const routedVia = res.headers.get('X-Routed-Via')
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        await addMessageMutation.mutateAsync({
          conversationId,
          role: 'assistant',
          content: `Error: ${err.error?.message ?? 'Unknown error'}`,
        })
        return
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2)
      const via = data._routed_via ?? (routedVia ? {
        platform: routedVia.split('/')[0],
        model: routedVia.split('/').slice(1).join('/'),
      } : undefined)

      // Save assistant message
      await addMessageMutation.mutateAsync({
        conversationId,
        role: 'assistant',
        content,
        meta: {
          platform: via?.platform,
          model: via?.model,
          latency,
          fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
        },
      })

      // Auto-title: if this is the first user message, update title
      if (messageRecords.length === 0) {
        await updateTitleMutation.mutateAsync({
          id: conversationId,
          title: text.slice(0, 50),
        })
      }
    } catch (err: any) {
      // On failure, try to store the error in the active conversation
      if (activeConversationId != null && messageRecords.length > 0) {
        await addMessageMutation.mutateAsync({
          conversationId: activeConversationId,
          role: 'assistant',
          content: `Error: ${err.message}`,
        }).catch(() => { })
      }
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const handleNewConversation = () => {
    setActiveConversationId(null)
    setInput('')
    setSidebarOpen(false)
  }

  const handleSelectConversation = (id: number) => {
    setActiveConversationId(id)
    setInput('')
    setSidebarOpen(false)
  }

  const handleDeleteConversation = async (id: number) => {
    try {
      await deleteConversationMutation.mutateAsync(id)
      if (activeConversationId === id) {
        setActiveConversationId(null)
      }
    } catch {
      // Silent fail
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const activeModelLabel = selectedModel === 'auto'
    ? 'Auto (fallback chain)'
    : availableModels.find(m => m.modelId === selectedModel)?.displayName ?? selectedModel

  const conversationTitle = activeConversationId
    ? conversations.find(c => c.id === activeConversationId)?.title ?? 'Chat'
    : 'Chat'

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title="Chat"
        description="Persistent conversations routed through your fallback chain."
        actions={
          <>
            <button
              onClick={() => setSidebarOpen(v => !v)}
              className="md:hidden flex items-center justify-center size-9 rounded-md hover:bg-muted touch-manipulation"
              aria-label="Toggle conversations"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12h18" /><path d="M3 6h18" /><path d="M3 18h18" />
              </svg>
            </button>
            <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v ?? 'auto')}>
              <SelectTrigger className="w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (fallback chain)</SelectItem>
                {availableModels.map(m => (
                  <SelectItem key={m.modelDbId} value={m.modelId}>
                    <span className="flex items-center gap-2">
                      <span>{m.displayName}</span>
                      <span className="text-xs text-muted-foreground">{m.platform}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={handleNewConversation}>
              + New
            </Button>
          </>
        }
      />

      <div className="flex-1 flex rounded-lg border bg-card overflow-hidden min-h-0 relative">
        {/* Sidebar overlay backdrop (mobile only) */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/30 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar — slide-over on mobile, static on desktop */}
        <aside
          className={`
            fixed md:relative inset-y-0 left-0 z-50
            w-72 md:w-56 lg:w-64
            bg-background border-r
            transform transition-transform duration-200 ease-in-out
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
            md:translate-x-0
            flex flex-col
          `}
        >
          {/* Sidebar header */}
          <div className="flex items-center justify-between px-4 h-12 md:h-14 border-b">
            <span className="font-medium text-sm">Conversations</span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="md:hidden size-8 flex items-center justify-center rounded-md hover:bg-muted"
              aria-label="Close sidebar"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          {/* Conversation list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {conversationsLoading ? (
              <div className="text-sm text-muted-foreground animate-pulse px-2 py-4 text-center">Loading...</div>
            ) : conversations.length === 0 ? (
              <div className="text-sm text-muted-foreground px-2 py-4 text-center">
                No conversations yet.
              </div>
            ) : (
              conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm cursor-pointer hover:bg-muted transition-colors touch-manipulation ${activeConversationId === conv.id ? 'bg-muted' : ''
                    }`}
                  onClick={() => handleSelectConversation(conv.id)}
                >
                  <div className="truncate flex-1 min-w-0">
                    <div className="truncate font-medium">{conv.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {new Date(conv.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 ml-2 shrink-0 opacity-50 hover:opacity-100"
                    onClick={(e) => { e.stopPropagation(); handleDeleteConversation(conv.id) }}
                    aria-label="Delete conversation"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18" />
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    </svg>
                  </Button>
                </div>
              ))
            )}
          </div>

          {/* New conversation button at bottom of sidebar */}
          <div className="p-2 border-t">
            <Button
              variant="default"
              size="sm"
              className="w-full h-9 text-sm"
              onClick={handleNewConversation}
            >
              + New Conversation
            </Button>
          </div>
        </aside>

        {/* === Chat area === */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {activeConversationId === null ? (
              <div className="flex items-center justify-center h-full text-center">
                <div className="space-y-2 max-w-sm">
                  <p className="text-base font-medium">Send a message to get started.</p>
                  <p className="text-sm text-muted-foreground">
                    Using <span className="text-foreground">{activeModelLabel}</span>. Switch models in the selector above.
                  </p>
                </div>
              </div>
            ) : messagesLoading ? (
              <div className="flex items-center justify-center h-full text-center">
                <div className="text-sm text-muted-foreground animate-pulse">Loading messages...</div>
              </div>
            ) : displayMessages.length === 0 ? (
              <div className="flex items-center justify-center h-full text-center">
                <div className="space-y-2 max-w-sm">
                  <p className="text-base font-medium">Empty conversation.</p>
                  <p className="text-sm text-muted-foreground">Send a message to start.</p>
                </div>
              </div>
            ) : (
              <>
                {displayMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted'
                      }`}
                    >
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                      {msg.meta && (
                        <div className="flex items-center gap-2 mt-2 flex-wrap text-[11px] opacity-70 tabular-nums">
                          {msg.meta.platform && <span>{msg.meta.platform}</span>}
                          {msg.meta.model && <span className="font-mono">· {msg.meta.model}</span>}
                          {msg.meta.latency != null && <span>· {msg.meta.latency} ms</span>}
                          {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && (
                            <span>· {msg.meta.fallbackAttempts} fallback{msg.meta.fallbackAttempts > 1 ? 's' : ''}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="bg-muted rounded-2xl px-4 py-3">
                      <div className="flex gap-1">
                        <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Bottom input bar */}
          <div className="border-t bg-background/50 p-3">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message… (⏎ to send, ⇧⏎ for newline)"
                rows={1}
                className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 min-h-[40px] max-h-[160px]"
                style={{ height: 'auto', overflow: 'hidden' }}
                onInput={e => {
                  const el = e.target as HTMLTextAreaElement
                  el.style.height = 'auto'
                  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
                }}
              />
              <Button onClick={handleSend} disabled={loading || !input.trim()} size="default">
                {loading ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
