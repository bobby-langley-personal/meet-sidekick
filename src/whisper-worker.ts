import { pipeline, env } from '@xenova/transformers'

// Fetch ONNX Runtime WASM from CDN (avoids bundling the 8MB WASM file)
env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.1/dist/'

type ProgressCallback = (p: { status: string; progress?: number; name?: string }) => void

let transcriber: Awaited<ReturnType<typeof pipeline>> | null = null

self.onmessage = async (e: MessageEvent<{ type: string; audio?: Float32Array }>) => {
  if (e.data.type === 'LOAD') {
    try {
      transcriber = await pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny.en',
        {
          dtype: 'q8',
          progress_callback: ((p: { status: string; progress?: number; name?: string }) => {
            self.postMessage({ type: 'PROGRESS', status: p.status, progress: p.progress ?? 0, name: p.name })
          }) as ProgressCallback,
        } as object
      )
      self.postMessage({ type: 'READY' })
    } catch (err) {
      self.postMessage({ type: 'ERROR', message: err instanceof Error ? err.message : 'Failed to load model' })
    }
  }

  if (e.data.type === 'TRANSCRIBE' && e.data.audio) {
    if (!transcriber) return
    try {
      const result = await (transcriber as (audio: Float32Array, opts: object) => Promise<{ text: string }>)(
        e.data.audio,
        { language: 'english', task: 'transcribe' }
      )
      const text = result.text.trim()
      // Filter out common Whisper hallucinations on silence
      if (text && text !== 'you' && !text.match(/^\[.*\]$/) && text.length > 2) {
        self.postMessage({ type: 'RESULT', text })
      }
    } catch {
      // Silently skip chunk errors — next chunk will be fine
    }
  }
}
