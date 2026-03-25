import Anthropic from '@anthropic-ai/sdk'
import type { PortInMessage } from '../types'

// Open side panel on icon click
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error)

// Streaming Claude suggestions via persistent port
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'suggest') return

  port.onMessage.addListener(async (message: PortInMessage) => {
    if (message.type !== 'SUGGEST') return

    const { apiKey, context, transcript, question } = message.payload

    if (!apiKey) {
      port.postMessage({ type: 'error', message: 'No API key set. Add your Anthropic API key in settings.' })
      return
    }

    const client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
    })

    try {
      const stream = client.messages.stream({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        system: `You are a real-time interview assistant helping a candidate during a live interview or meeting.

CANDIDATE BACKGROUND:
${context || '(No background provided — add your resume or experience in the settings panel)'}

Your role:
- Suggest concise, confident answers the candidate can use immediately
- Reference specific experience from their background when relevant
- Write in first person as the candidate
- Keep responses brief: 2–4 sentences unless the question clearly needs more detail
- Be direct — no preamble, no "Here's how you could answer..."`,
        messages: [
          {
            role: 'user',
            content: question.trim()
              ? `Help me answer this question: "${question}"\n\nRecent conversation:\n${transcript}`
              : `Based on this conversation, suggest what I should say next:\n\n${transcript}`,
          },
        ],
      })

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          port.postMessage({ type: 'chunk', text: event.delta.text })
        }
      }

      port.postMessage({ type: 'done' })
    } catch (err) {
      const msg = err instanceof Anthropic.AuthenticationError
        ? 'Invalid API key — check your Anthropic key in settings.'
        : err instanceof Error
        ? err.message
        : 'Suggestion failed'
      port.postMessage({ type: 'error', message: msg })
    }
  })
})
