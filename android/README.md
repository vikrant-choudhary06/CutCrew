# CutCrew for Android (phones, tablets, TV)

Expo SDK 58 / React Native 0.88 app that talks to `https://web.cutcrew.click`.
One APK installs on phones, tablets and Android TV (TV launcher + banner via
`plugins/withAndroidTv.js`).

## Run while developing

```bash
npm install
npx expo run:android      # needs a device or emulator
```

## Build the release APK (Windows notes)

React Native's C++ build hits Windows path limits, so build from a short folder
outside OneDrive (and outside `AppData\Local` when running inside a packaged app):

```bash
# copy this folder (without node_modules) to e.g. C:\Users\<you>\cc-build, then:
npm ci
npx expo prebuild -p android --clean
```

Then in `android/`:

1. `local.properties`: add `cmake.dir=C:/Users/<you>/AppData/Local/Android/Sdk/cmake/3.31.6`
   (install it with `sdkmanager "cmake;3.31.6"`). Its ninja 1.12 handles long paths;
   the default CMake 3.22's ninja does not.
2. On slow or flaky networks, add to `gradle.properties`:
   ```
   systemProp.java.net.preferIPv4Stack=true
   systemProp.org.gradle.internal.http.socketTimeout=180000
   systemProp.org.gradle.internal.http.connectionTimeout=180000
   ```
3. Build:
   ```bash
   ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a,x86_64
   ```
   Output: `android/app/build/outputs/apk/release/app-release.apk`.

The release APK is signed with the debug key (fine for sideloading). Make your
own keystore before publishing anywhere.

## Updates

**JavaScript changes (OTA, no new APK).** Phones on the same native version
(app.json `version`, used as `runtimeVersion`) download the update in the
background and run it the next time the app opens. Updates come from CutCrew's
own backend (`/api/updates/*`), not EAS.

```bash
CUTCREW_SSH_KEY=/path/to/server-key.pem npm run publish:update
```

**Native changes (new APK).** Raise `version` and `android.versionCode` in
app.json, build the APK, publish it as a GitHub release, then update
`backend/app-releases/android.json` (version, versionCode, apkUrl). On start the
app compares versionCode and offers the download; Android asks once to allow
installs from CutCrew. A copy at `backend/.local/app-releases/android.json` on
the server overrides the one in git without a rebuild.
