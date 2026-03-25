export interface Settings {
  apiKey: string
  context: string  // resume / background experience pasted by user
}

export type PortInMessage =
  | { type: 'SUGGEST'; payload: { transcript: string; question: string; context: string; apiKey: string } }

export type PortOutMessage =
  | { type: 'chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
