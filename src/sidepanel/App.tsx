import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Mic, MicOff, Loader2, Sparkles, Settings, ChevronUp,
  RotateCcw, Copy, Check, AlertCircle, RefreshCw, ExternalLink,
  Radio, RadioIcon,
} from 'lucide-react'
import type { PortOutMessage, ResumeDoc } from '../types'

const RESUMEFORGE_URL = 'https://resume-forge-rho.vercel.app'
const MAX_TRANSCRIPT  = 4000   // chars kept in rolling window
const CHUNK_SECONDS   = 6      // seconds of audio per Whisper chunk

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
  readonly isFinal: boolean
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

type ModelState = 'idle' | 'loading' | 'ready' | 'error'

function appendToTranscript(prev: string, text: string): string {
  const next = (prev + ' ' + text).trim()
  return next.length > MAX_TRANSCRIPT ? next.slice(next.length - MAX_TRANSCRIPT) : next
}

export default function App() {
  // Library
  const [docs, setDocs]               = useState<ResumeDoc[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [docsLoading, setDocsLoading] = useState(true)
  const [signedOut, setSignedOut]     = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // Mic (Web Speech API — user's own voice)
  const [micOn, setMicOn] = useState(false)

  // Tab audio capture + Whisper
  const [tabCapturing, setTabCapturing]   = useState(false)
  const [modelState, setModelState]       = useState<ModelState>('idle')
  const [modelProgress, setModelProgress] = useState(0)
  const [pendingCapture, setPendingCapture] = useState(false)

  // Transcript
  const [transcript, setTranscript] = useState('')
  const [question, setQuestion]     = useState('')

  // Suggestion
  const [suggestion, setSuggestion] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [copied, setCopied]         = useState(false)

  const portRef       = useRef<chrome.runtime.Port | null>(null)
  const recogRef      = useRef<SpeechRecognition | null>(null)
  const workerRef     = useRef<Worker | null>(null)
  const audioCtxRef   = useRef<AudioContext | null>(null)
  const tabStreamRef  = useRef<MediaStream | null>(null)
  const transcriptRef = useRef('') // mutable copy for closures

  // ── Library loading ───────────────────────────────────────────────────────
  const loadDocs = useCallback(() => {
    setDocsLoading(true)
    setSignedOut(false)
    chrome.runtime.sendMessage({ type: 'FETCH_RESUMES' }, (response: { data?: ResumeDoc[]; error?: number | string }) => {
      setDocsLoading(false)
      if (!response || response.error === 401) {
        setSignedOut(true)
        setShowSettings(true)
        return
      }
      if (response.data) {
        setDocs(response.data)
        const defaultDoc = response.data.find((d) => d.is_default)
        setSelectedIds(new Set(defaultDoc ? [defaultDoc.id] : response.data.slice(0, 1).map((d) => d.id)))
      }
    })
  }, [])

  useEffect(() => { loadDocs() }, [loadDocs])

  function toggleDoc(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function buildContext() {
    return docs
      .filter((d) => selectedIds.has(d.id))
      .map((d) => `${d.title}:\n${d.content.text}`)
      .join('\n\n---\n\n')
  }

  // ── Whisper worker ────────────────────────────────────────────────────────
  const initWorker = useCallback(() => {
    if (workerRef.current) return
    const worker = new Worker(
      chrome.runtime.getURL('src/whisper-worker.js'),
      { type: 'module' }
    )
    worker.onmessage = (e: MessageEvent<{ type: string; progress?: number; name?: string; text?: string; message?: string }>) => {
      const { type } = e.data
      if (type === 'PROGRESS') {
        if (e.data.name && e.data.progress !== undefined) {
          setModelProgress(Math.round(e.data.progress))
        }
      } else if (type === 'READY') {
        setModelState('ready')
      } else if (type === 'ERROR') {
        setModelState('error')
        setError(`Whisper: ${e.data.message}`)
      } else if (type === 'RESULT' && e.data.text) {
        transcriptRef.current = appendToTranscript(transcriptRef.current, e.data.text)
        setTranscript(transcriptRef.current)
      }
    }
    worker.postMessage({ type: 'LOAD' })
    workerRef.current = worker
    setModelState('loading')
    setModelProgress(0)
  }, [])

  // ── Tab audio capture ─────────────────────────────────────────────────────
  const doCapture = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) throw new Error('No active tab found — make sure your meeting tab is active.')

      const streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id! }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
          else resolve(id)
        })
      })

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
        } as MediaTrackConstraints,
        video: false,
      })

      tabStreamRef.current = stream

      // AudioContext at 16kHz — Whisper's expected sample rate
      const ctx = new AudioContext({ sampleRate: 16000 })
      audioCtxRef.current = ctx

      const source = ctx.createMediaStreamSource(stream)
      const CHUNK_SAMPLES = 16000 * CHUNK_SECONDS

      let sampleBuffer: Float32Array[] = []
      let sampleCount = 0

      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (e) => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0))
        sampleBuffer.push(data)
        sampleCount += data.length

        if (sampleCount >= CHUNK_SAMPLES) {
          const combined = new Float32Array(sampleCount)
          let offset = 0
          for (const chunk of sampleBuffer) { combined.set(chunk, offset); offset += chunk.length }
          sampleBuffer = []
          sampleCount = 0
          workerRef.current?.postMessage({ type: 'TRANSCRIBE', audio: combined }, [combined.buffer])
        }
      }

      // Silent gain node: keeps the audio graph connected (needed for onaudioprocess)
      // without double-playing the meeting audio through the extension's output
      const silent = ctx.createGain()
      silent.gain.value = 0
      source.connect(processor)
      processor.connect(silent)
      silent.connect(ctx.destination)

      setTabCapturing(true)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to capture tab audio')
    }
  }, [])

  // When model becomes ready and user was waiting to capture
  useEffect(() => {
    if (modelState === 'ready' && pendingCapture) {
      setPendingCapture(false)
      doCapture()
    }
  }, [modelState, pendingCapture, doCapture])

  const startTabCapture = useCallback(() => {
    if (modelState === 'idle') {
      initWorker()
      setPendingCapture(true)
      return
    }
    if (modelState === 'loading') {
      setPendingCapture(true)
      return
    }
    if (modelState === 'ready') {
      doCapture()
    }
  }, [modelState, initWorker, doCapture])

  const stopTabCapture = useCallback(() => {
    tabStreamRef.current?.getTracks().forEach((t) => t.stop())
    tabStreamRef.current = null
    audioCtxRef.current?.close()
    audioCtxRef.current = null
    setTabCapturing(false)
  }, [])

  // Cleanup on unmount
  useEffect(() => () => {
    stopTabCapture()
    workerRef.current?.terminate()
  }, [stopTabCapture])

  // ── Mic (Web Speech API) ──────────────────────────────────────────────────
  const startMic = useCallback(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SR) { setError('Speech recognition not supported.'); return }

    const recognition = new SR()
    recognition.continuous     = true
    recognition.interimResults = false  // only final results to avoid duplicating transcript
    recognition.lang           = 'en-US'

    recognition.onresult = (event) => {
      for (let i = event.results.length - 1; i >= 0; i--) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0].transcript.trim()
          if (text) {
            transcriptRef.current = appendToTranscript(transcriptRef.current, `[Me] ${text}`)
            setTranscript(transcriptRef.current)
          }
        }
      }
    }

    recognition.onerror = (e) => {
      if (e.error !== 'no-speech') { setError(`Mic: ${e.error}`); setMicOn(false) }
    }

    recognition.onend = () => { if (recogRef.current) recognition.start() }

    recognition.start()
    recogRef.current = recognition
    setMicOn(true)
  }, [])

  const stopMic = useCallback(() => {
    if (recogRef.current) {
      recogRef.current.onend = null
      recogRef.current.stop()
      recogRef.current = null
    }
    setMicOn(false)
  }, [])

  // ── Suggestion ─────────────────────────────────────────────────────────────
  function getSuggestion() {
    if (generating) return
    portRef.current?.disconnect()
    setSuggestion('')
    setGenerating(true)
    setError(null)

    const port = chrome.runtime.connect({ name: 'suggest' })
    portRef.current = port

    port.onMessage.addListener((msg: PortOutMessage) => {
      if (msg.type === 'chunk') setSuggestion((s) => s + msg.text)
      else if (msg.type === 'done') { setGenerating(false); port.disconnect() }
      else if (msg.type === 'error') { setError(msg.message); setGenerating(false); port.disconnect() }
    })

    port.postMessage({
      type: 'SUGGEST',
      payload: {
        context: buildContext(),
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

  function clearTranscript() {
    transcriptRef.current = ''
    setTranscript('')
  }

  const hasTranscript = transcript.trim().length > 0

  // Capture button label
  const captureLabel = tabCapturing
    ? 'Stop'
    : modelState === 'loading'
    ? `Loading… ${modelProgress > 0 ? `${modelProgress}%` : ''}`
    : 'Capture meeting audio'

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
          {signedOut ? (
            <div className="space-y-3">
              <p className="text-xs text-zinc-400 leading-relaxed">
                Sign in to ResumeForge to load your documents as interview context.
              </p>
              <a
                href={RESUMEFORGE_URL}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-xs font-medium transition-colors"
              >
                Sign in to ResumeForge <ExternalLink className="w-3 h-3" />
              </a>
              <button
                onClick={loadDocs}
                className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded bg-zinc-800 border border-zinc-700 hover:border-zinc-500 text-xs text-zinc-300 transition-colors"
              >
                <RefreshCw className="w-3 h-3" /> I've signed in — refresh
              </button>
            </div>
          ) : docsLoading ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your documents…
            </div>
          ) : docs.length === 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">No documents found in your ResumeForge library.</p>
              <a
                href={`${RESUMEFORGE_URL}/resumes`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300"
              >
                Add documents <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-zinc-500 uppercase tracking-wider">Context from My Documents</p>
                <button onClick={loadDocs} className="text-zinc-600 hover:text-zinc-400" title="Refresh">
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-1">
                {docs.map((doc) => (
                  <label key={doc.id} className="flex items-start gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(doc.id)}
                      onChange={() => toggleDoc(doc.id)}
                      className="mt-0.5 accent-violet-500 shrink-0"
                    />
                    <span className="text-xs text-zinc-300 group-hover:text-zinc-100 leading-snug">
                      {doc.title}
                      {doc.is_default && (
                        <span className="ml-1.5 text-[9px] text-violet-400 uppercase tracking-wider">default</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Audio controls */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2 shrink-0 flex-wrap">
        {/* Tab capture — primary */}
        <button
          onClick={tabCapturing ? stopTabCapture : startTabCapture}
          disabled={modelState === 'loading'}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 ${
            tabCapturing
              ? 'bg-red-600/20 border border-red-700/50 text-red-400 hover:bg-red-600/30'
              : 'bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-zinc-500'
          }`}
        >
          {modelState === 'loading'
            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />{captureLabel}</>
            : tabCapturing
            ? <><RadioIcon className="w-3.5 h-3.5" />Stop capturing</>
            : <><Radio className="w-3.5 h-3.5" />Capture meeting audio</>
          }
        </button>

        {/* Mic — secondary */}
        <button
          onClick={micOn ? stopMic : startMic}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
            micOn
              ? 'bg-red-600/20 border border-red-700/50 text-red-400 hover:bg-red-600/30'
              : 'bg-zinc-800 border border-zinc-700 text-zinc-400 hover:border-zinc-500'
          }`}
          title={micOn ? 'Mic on' : 'Mic off'}
        >
          {micOn ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
        </button>

        {/* Status indicators */}
        {tabCapturing && (
          <span className="flex items-center gap-1 text-[10px] text-zinc-500">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            Listening
          </span>
        )}
        {micOn && (
          <span className="flex items-center gap-1 text-[10px] text-zinc-500">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
            Mic
          </span>
        )}

        {/* Clear transcript */}
        {hasTranscript && (
          <button
            onClick={clearTranscript}
            className="ml-auto text-zinc-600 hover:text-zinc-400 transition-colors"
            title="Clear transcript"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* First-use model note */}
      {modelState === 'loading' && (
        <div className="px-4 pt-2 pb-1 shrink-0">
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            Downloading Whisper model (~40 MB) — one-time, then cached locally.
            {modelProgress > 0 && ` ${modelProgress}%`}
          </p>
        </div>
      )}

      {/* Transcript */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {hasTranscript ? (
          <div className="flex-1 overflow-y-auto px-4 pt-3 pb-1">
            <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">Transcript</p>
            <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">
              {transcript.length > 800
                ? '…' + transcript.slice(transcript.length - 800)
                : transcript}
            </p>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center px-6 text-center">
            <p className="text-zinc-700 text-xs leading-relaxed">
              {tabCapturing
                ? 'Listening to the meeting — transcript will appear every few seconds.'
                : 'Hit "Capture meeting audio" to begin. Make sure your meeting tab is active first.'}
            </p>
          </div>
        )}

        {/* Question input + Get suggestion */}
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
                  <button onClick={copy} className="p-1 text-zinc-600 hover:text-zinc-400" title="Copy">
                    {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                  </button>
                )}
                <button onClick={reset} className="p-1 text-zinc-600 hover:text-zinc-400" title="Clear">
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
