export interface ResumeDoc {
  id: string
  title: string
  item_type: 'resume' | 'cover_letter' | 'portfolio' | 'other'
  is_default: boolean
  content: { text: string; fileName?: string }
}

export type BgMessage =
  | { type: 'FETCH_RESUMES' }

export type PortInMessage =
  | { type: 'SUGGEST'; payload: { transcript: string; question: string; context: string } }

export type PortOutMessage =
  | { type: 'chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
