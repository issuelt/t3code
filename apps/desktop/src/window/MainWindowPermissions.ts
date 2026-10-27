import * as Electron from "electron";

/**
 * Grants every request, like a session without a handler, except macOS
 * microphone capture from the main window, which asks the OS for consent
 * first so dictation gets the system prompt instead of silence.
 */
export function installMainWindowPermissions(
  webContents: Electron.WebContents,
  platform: NodeJS.Platform,
): void {
  webContents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
    const wantsMicrophone =
      platform === "darwin" &&
      permission === "media" &&
      requester === webContents &&
      "mediaTypes" in details &&
      details.mediaTypes?.includes("audio") === true;
    if (!wantsMicrophone) {
      callback(true);
      return;
    }
    void Electron.systemPreferences
      .askForMediaAccess("microphone")
      .then(callback, () => callback(false));
  });
}
