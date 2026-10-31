// Makes the same APK installable and launchable on Android TV:
// - shows in the TV launcher (LEANBACK_LAUNCHER) with a 320x180 banner
// - touchscreen and leanback are optional, so phones and TVs both qualify
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

function withTvManifest(config) {
  return withAndroidManifest(config, cfg => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-feature'] = manifest['uses-feature'] || [];
    for (const name of ['android.software.leanback', 'android.hardware.touchscreen']) {
      if (!manifest['uses-feature'].some(f => f.$['android:name'] === name)) {
        manifest['uses-feature'].push({ $: { 'android:name': name, 'android:required': 'false' } });
      }
    }
    const app = manifest.application[0];
    app.$['android:banner'] = '@drawable/tv_banner';
    const main = (app.activity || []).find(a => a.$['android:name'] === '.MainActivity');
    const launcher = main?.['intent-filter']?.find(f => (f.action || []).some(a => a.$['android:name'] === 'android.intent.action.MAIN'));
    if (launcher && !(launcher.category || []).some(c => c.$['android:name'] === 'android.intent.category.LEANBACK_LAUNCHER')) {
      launcher.category = [...(launcher.category || []), { $: { 'android:name': 'android.intent.category.LEANBACK_LAUNCHER' } }];
    }
    return cfg;
  });
}

function withTvBanner(config) {
  return withDangerousMod(config, ['android', async cfg => {
    const target = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/drawable');
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(cfg.modRequest.projectRoot, 'assets/tv-banner.png'), path.join(target, 'tv_banner.png'));
    return cfg;
  }]);
}

module.exports = config => withTvBanner(withTvManifest(config));
