import {
  CHECK_APP_UPDATE,
  DOWNLOAD_APP_UPDATE,
  GET_APP_UPDATE_STATE,
  INSTALL_APP_UPDATE,
} from '../../shared/ipc/channels'
import {
  checkForAppUpdate,
  downloadAppUpdate,
  getAppUpdateState,
  quitAndInstallUpdate,
} from '../updater'
import { handle } from './secureIpc'

export function registerUpdaterHandler(): void {
  handle(GET_APP_UPDATE_STATE, async () => getAppUpdateState())
  handle(CHECK_APP_UPDATE, async () => checkForAppUpdate())
  handle(DOWNLOAD_APP_UPDATE, async () => downloadAppUpdate())
  handle(INSTALL_APP_UPDATE, async (): Promise<void> => {
    quitAndInstallUpdate()
  })
}
