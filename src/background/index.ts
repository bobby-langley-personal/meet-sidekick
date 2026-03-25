import type { BgMessage, PortInMessage } from '../types'

const API_BASE = 'https://resume-forge-rho.vercel.app'

// Open side panel on icon click
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error)

// One-off requests
chrome.runtime.onMessage.addListener((message: BgMessage, _sender, sendResponse) => {
  if (message.type === 'FETCH_RESUMES') {
    fetch(`${API_BASE}/api/resumes`, { credentials: 'include' })
      .then(async (res) => {
        if (res.status === 401) return sendResponse({ error: 401 })
        const data = await res.json()
        sendResponse({ data })
      })
      .catch((err: Error) => sendResponse({ error: err.message }))
    return true
  }
})

// Streaming suggestion via persistent port — proxied through ResumeForge backend
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'suggest') return

  port.onMessage.addListener(async (message: PortInMessage) => {
    if (message.type !== 'SUGGEST') return

    try {
      const response = await fetch(`${API_BASE}/api/meet-suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(message.payload),
      })

      if (response.status === 401) {
        port.postMessage({ type: 'error', message: 'Sign in to ResumeForge to use Meet Sidekick.' })
        return
      }
      if (!response.ok) {
        port.postMessage({ type: 'error', message: `Request failed (${response.status})` })
        return
      }

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (!raw || raw === '[DONE]') continue
          try {
            const event = JSON.parse(raw) as { type: string; text?: string; message?: string }
            if (event.type === 'chunk') {
              port.postMessage({ type: 'chunk', text: event.text ?? '' })
            } else if (event.type === 'done') {
              port.postMessage({ type: 'done' })
            } else if (event.type === 'error') {
              port.postMessage({ type: 'error', message: event.message ?? 'Suggestion failed' })
            }
          } catch {
            // non-JSON line, skip
          }
        }
      }
    } catch (err) {
      port.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Suggestion failed',
      })
    }
  })
})
