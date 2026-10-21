import type { IKanApi } from '../../shared/api'

declare global {
  interface Window {
    api: IKanApi
  }
}

export {}
