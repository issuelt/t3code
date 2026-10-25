const { AndroidConfig, withAndroidManifest, withMainActivity } = require("expo/config-plugins");

// Lock portrait at runtime on phones only (smallest width < 600dp), before super.onCreate. The
// manifest stays unlocked: a tablet launched in landscape against a portrait manifest stays
// letterboxed until rotated. FULL_USER respects rotation lock; foldables change
// smallestScreenWidthDp without recreating the activity.

const ORIENTATION_METHODS = `
  // Applied in onCreate and re-applied on fold/unfold; added by
  // withAndroidTabletOrientation.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyTabletOrientation()
  }

  private fun applyTabletOrientation() {
    requestedOrientation = if (resources.configuration.smallestScreenWidthDp >= 600) {
      ActivityInfo.SCREEN_ORIENTATION_FULL_USER
    } else {
      ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }
  }
`;

const ORIENTATION_ON_CREATE_CALL = `applyTabletOrientation()
    `;

function findAnchor(contents, anchor, description) {
  const index = contents.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `withAndroidTabletOrientation: could not find ${description} in MainActivity — the Expo template changed; update the plugin anchors.`,
    );
  }
  return index;
}

function insertBefore(contents, anchor, insertion, description) {
  const index = findAnchor(contents, anchor, description);
  return contents.slice(0, index) + insertion + contents.slice(index);
}

function insertAfter(contents, anchor, insertion, description) {
  const end = findAnchor(contents, anchor, description) + anchor.length;
  return contents.slice(0, end) + insertion + contents.slice(end);
}

function withUnlockedManifestOrientation(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(nextConfig.modResults);
    delete mainActivity.$["android:screenOrientation"];
    return nextConfig;
  });
}

module.exports = function withAndroidTabletOrientation(config) {
  config = withUnlockedManifestOrientation(config);
  return withMainActivity(config, (nextConfig) => {
    let contents = nextConfig.modResults.contents;
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("withAndroidTabletOrientation: MainActivity must be Kotlin.");
    }
    if (contents.includes("SCREEN_ORIENTATION_FULL_USER")) {
      return nextConfig;
    }

    contents = insertAfter(
      contents,
      "import android.os.Bundle",
      "\nimport android.content.pm.ActivityInfo\nimport android.content.res.Configuration",
      "the android.os.Bundle import",
    );
    contents = insertAfter(
      contents,
      "class MainActivity : ReactActivity() {",
      ORIENTATION_METHODS,
      "the MainActivity class declaration",
    );
    contents = insertBefore(
      contents,
      "super.onCreate(null)",
      ORIENTATION_ON_CREATE_CALL,
      "the super.onCreate call",
    );

    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
