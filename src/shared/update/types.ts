export interface AppUpdateReleaseNote {
  readonly version: string
  readonly note: string
}

export interface AppUpdateInfo {
  readonly version: string
  readonly releaseName: string | null
  readonly releaseDate: string
  readonly releaseNotes: readonly AppUpdateReleaseNote[]
}

export interface AppUpdateProgress {
  readonly percent: number
  readonly transferred: number
  readonly total: number
  readonly bytesPerSecond: number
}

export type AppUpdateSnapshot =
  | { readonly status: 'idle'; readonly currentVersion: string }
  | { readonly status: 'checking'; readonly currentVersion: string }
  | { readonly status: 'up-to-date'; readonly currentVersion: string; readonly checkedAt: string }
  | { readonly status: 'available'; readonly currentVersion: string; readonly update: AppUpdateInfo }
  | {
      readonly status: 'downloading'
      readonly currentVersion: string
      readonly update: AppUpdateInfo
      readonly progress: AppUpdateProgress
    }
  | { readonly status: 'ready'; readonly currentVersion: string; readonly update: AppUpdateInfo }
  | {
      readonly status: 'error'
      readonly operation: 'check'
      readonly currentVersion: string
      readonly message: string
    }
  | {
      readonly status: 'error'
      readonly operation: 'download'
      readonly currentVersion: string
      readonly update: AppUpdateInfo
      readonly message: string
    }
