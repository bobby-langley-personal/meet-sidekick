import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Mic, MicOff, Loader2, Sparkles, Settings, ChevronUp,
  RotateCcw, Copy, Check, AlertCircle,
} from 'lucide-react'
import type { PortOutMessage } from '../types'

const STORAGE_KEY_API  = 'sidekick_api_key'
const STORAGE_KEY_CTX  = 'sidekick_context'
const MAX_TRANSCRIPT   = 3000  // chars kept in rolling window

// Web Speech API — not in lib.dom.d.ts by default
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
}
interface SpeechRecognitionResultList {
  readonly length: number
  [index: number]: SpeechRecognitionResult
}
interface SpeechRecognitionResult {
  readonly length: number
  [index: number]: SpeechRecognitionAlternative
}
interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}
interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}
declare const SpeechRecognition: new () => SpeechRecognition
declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}

export default function App() {
  // Settings
  const [apiKey, setApiKey]     = useState('')
  const [context, setContext]   = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)

  // Listening
  const [listening, setListening]   = useState(false)
  const [transcript, setTranscript] = useState('')
  const [question, setQuestion]     = useState('')

  // Suggestion
  const [suggestion, setSuggestion] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [copied, setCopied]         = useState(false)

  const portRef = useRef<chrome.runtime.Port | null>(null)
  const recogRef = useRef<SpeechRecognition | null>(null)
  const transcriptRef = useRef('')  // mutable ref for rolling window

  // Load saved settings on mount
  useEffect(() => {
    chrome.storage.local.get([STORAGE_KEY_API, STORAGE_KEY_CTX], (result) => {
      if (result[STORAGE_KEY_API]) setApiKey(result[STORAGE_KEY_API] as string)
      if (result[STORAGE_KEY_CTX]) setContext(result[STORAGE_KEY_CTX] as string)
      // Open settings if no API key yet
      if (!result[STORAGE_KEY_API]) setShowSettings(true)
    })
  }, [])

  function saveSettings() {
    chrome.storage.local.set({
      [STORAGE_KEY_API]: apiKey.trim(),
      [STORAGE_KEY_CTX]: context.trim(),
    })
    setSettingsSaved(true)
    setTimeout(() => setSettingsSaved(false), 2000)
  }

  // ── Speech recognition ────────────────────────────────────────────────────
  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SR) {
      setError('Speech recognition not supported in this browser.')
      return
    }

    const recognition = new SR()
    recognition.continuous     = true
    recognition.interimResults = true
    recognition.lang           = 'en-US'

    recognition.onresult = (event) => {
      let full = ''
      for (let i = 0; i < event.results.length; i++) {
        full += event.results[i][0].transcript + ' '
      }
      // Rolling window — keep only the last MAX_TRANSCRIPT chars
      const trimmed = full.length > MAX_TRANSCRIPT
        ? full.slice(full.length - MAX_TRANSCRIPT)
        : full
      transcriptRef.current = trimmed
      setTranscript(trimmed)
    }

    recognition.onerror = (event) => {
      if (event.error !== 'no-speech') {
        setError(`Mic error: ${event.error}`)
        setListening(false)
      }
    }

    recognition.onend = () => {
      // Auto-restart unless we intentionally stopped
      if (recogRef.current) recognition.start()
    }

    recognition.start()
    recogRef.current = recognition
    setListening(true)
    setError(null)
  }, [])

  const stopListening = useCallback(() => {
    if (recogRef.current) {
      recogRef.current.onend = null  // prevent auto-restart
      recogRef.current.stop()
      recogRef.current = null
    }
    setListening(false)
  }, [])

  // ── Claude suggestion ─────────────────────────────────────────────────────
  function getSuggestion() {
    if (generating) return
    portRef.current?.disconnect()

    setSuggestion('')
    setGenerating(true)
    setError(null)

    const port = chrome.runtime.connect({ name: 'suggest' })
    portRef.current = port

    port.onMessage.addListener((msg: PortOutMessage) => {
      if (msg.type === 'chunk') {
        setSuggestion((s) => s + msg.text)
      } else if (msg.type === 'done') {
        setGenerating(false)
        port.disconnect()
      } else if (msg.type === 'error') {
        setError(msg.message)
        setGenerating(false)
        port.disconnect()
      }
    })

    port.postMessage({
      type: 'SUGGEST',
      payload: {
        apiKey: apiKey.trim(),
        context: context.trim(),
        transcript: transcriptRef.current.trim() || transcript.trim(),
        question: question.trim(),
      },
    })
  }

  async function copy() {
    if (!suggestion) return
    await navigator.clipboard.writeText(suggestion)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function reset() {
    portRef.current?.disconnect()
    setSuggestion('')
    setQuestion('')
    setError(null)
    setGenerating(false)
  }

  const hasTranscript = transcript.trim().length > 0

  return (
    <div className="w-full min-h-screen bg-zinc-950 text-zinc-100 flex flex-col text-sm">

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 shrink-0">
        <Sparkles className="w-4 h-4 text-violet-400 shrink-0" />
        <span className="font-semibold">Meet Sidekick</span>
        <button
          onClick={() => setShowSettings((v) => !v)}
          className="ml-auto text-zinc-600 hover:text-zinc-400 transition-colors"
          title="Settings"
        >
          {showSettings ? <ChevronUp className="w-4 h-4" /> : <Settings className="w-4 h-4" />}
        </button>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="border-b border-zinc-800 p-4 space-y-3 bg-zinc-900/50 shrink-0">
          <div className="space-y-1">
            <label className="text-xs text-zinc-500 uppercase tracking-wider">Anthropic API key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-zinc-500 uppercase tracking-wider">Your background / resume</label>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Paste your resume, work history, or key experience here. The more context, the better the suggestions."
              rows={6}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-none leading-relaxed"
            />
          </div>
          <button
            onClick={saveSettings}
            className="w-full py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-xs font-medium transition-colors"
          >
            {settingsSaved ? '✓ Saved' : 'Save settings'}
          </button>
        </div>
      )}

      {/* Listening controls */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3 shrink-0">
        <button
          onClick={listening ? stopListening : startListening}
          className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            listening
              ? 'bg-red-600/20 border border-red-700/50 text-red-400 hover:bg-red-600/30'
              : 'bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-zinc-500'
          }`}
        >
          {listening
            ? <><MicOff className="w-3.5 h-3.5" />Stop listening</>
            : <><Mic className="w-3.5 h-3.5" />Start listening</>
          }
        </button>
        {listening && (
          <span className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            Listening…
          </span>
        )}
      </div>

      {/* Transcript */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {hasTranscript ? (
          <div className="flex-1 overflow-y-auto px-4 pt-3 pb-1">
            <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">Transcript</p>
            <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">
              {transcript.length > 600
                ? '…' + transcript.slice(transcript.length - 600)
                : transcript}
            </p>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center px-6 text-center">
            <p className="text-zinc-700 text-xs leading-relaxed">
              {listening
                ? 'Speak — transcript will appear here.'
                : 'Hit "Start listening" to begin capturing the conversation.'}
            </p>
          </div>
        )}

        {/* Question input + Get help */}
        <div className="px-4 py-3 border-t border-zinc-800 space-y-2 shrink-0">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !generating && getSuggestion()}
            placeholder="Paste or type the question (optional)"
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          />
          <button
            onClick={getSuggestion}
            disabled={generating || (!hasTranscript && !question.trim())}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-medium transition-colors"
          >
            {generating
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Generating…</>
              : <><Sparkles className="w-3.5 h-3.5" />Get suggestion</>
            }
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-4 mb-3 flex items-start gap-2 p-2.5 rounded bg-red-950/40 border border-red-900/50">
            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-300 text-xs leading-snug">{error}</p>
          </div>
        )}

        {/* Suggestion output */}
        {(suggestion || generating) && (
          <div className="mx-4 mb-4 rounded border border-violet-900/40 bg-violet-950/20">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-violet-900/30">
              <span className="text-[10px] text-violet-400 font-medium uppercase tracking-wider flex items-center gap-1">
                <Sparkles className="w-3 h-3" />Suggestion
              </span>
              <div className="flex items-center gap-1">
                {suggestion && (
                  <button
                    onClick={copy}
                    className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors"
                    title="Copy"
                  >
                    {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                  </button>
                )}
                <button
                  onClick={reset}
                  className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors"
                  title="Clear"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="px-3 py-2.5">
              <p className="text-xs text-zinc-200 leading-relaxed whitespace-pre-wrap">
                {suggestion}
                {generating && <span className="inline-block w-1.5 h-3.5 bg-violet-400 ml-0.5 animate-pulse rounded-sm" />}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
