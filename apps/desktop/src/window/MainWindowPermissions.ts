import * as Electron from "electron";

/**
 * Permission policy for the main window's session. A session without a
 * handler grants every request, and this keeps that. The one addition is
 * microphone capture from the main window on macOS: it asks the OS for
 * consent first, so dictation gets the system prompt instead of silence
 * when the app has not been allowed to record yet.
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
