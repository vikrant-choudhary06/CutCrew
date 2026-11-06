// App updates.
// 1. JavaScript updates (OTA) are handled by expo-updates itself (app.json
//    "updates"): on launch it checks CutCrew's update server, downloads in the
//    background, and the new version runs the next time the app opens.
// 2. New APKs: on launch the app asks /api/app/android for the latest native
//    version. If it is newer than the installed build, a popup offers to
//    download it and opens Android's installer.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { Alert, Platform } from 'react-native';
import { getJSON } from './api';

export type Release = { version: string; versionCode: number; apkUrl: string; notes?: string; sizeMb?: number };
const LATER_KEY = 'cutcrew-update-later';
const LATER_MS = 24 * 3600000;

// Is the offered build newer than the installed one? (Android versionCode.)
export function isNewer(release: Partial<Release> | null, installedCode: number) {
  return Boolean(release && Number.isInteger(release.versionCode) && release.versionCode! > installedCode && /^https:\/\//.test(release.apkUrl || ''));
}

async function install(release: Release) {
  const target = new File(Paths.cache, `CutCrew-${release.version}.apk`);
  if (target.exists) target.delete();
  Alert.alert('Downloading update', `CutCrew ${release.version} is downloading. The installer opens when it is ready.`);
  const file = await File.downloadFileAsync(release.apkUrl, target);
  // Android asks once to allow installs from CutCrew ("Install unknown apps").
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: file.contentUri, flags: 1 /* FLAG_GRANT_READ_URI_PERMISSION */, type: 'application/vnd.android.package-archive',
  });
}

export async function checkForNewApk() {
  if (Platform.OS !== 'android') return;
  try {
    const installed = Number(Application.nativeBuildVersion) || 0;
    const release = await getJSON<Release>('/api/app/android', { timeout: 15000, fresh: true });
    if (!isNewer(release, installed)) return;
    const later = Number(await AsyncStorage.getItem(`${LATER_KEY}:${release.versionCode}`)) || 0;
    if (Date.now() - later < LATER_MS) return;
    const size = release.sizeMb ? ` (${release.sizeMb} MB)` : '';
    Alert.alert('Update available', [
      `CutCrew ${release.version}${size} is ready. You have ${Application.nativeApplicationVersion}.`,
      release.notes || '',
      'The first time, Android asks you to allow installs from CutCrew: tap Settings, turn on "Allow from this source", go back, then tap Install.',
    ].filter(Boolean).join('\n\n'), [
      { text: 'Later', style: 'cancel', onPress: () => { AsyncStorage.setItem(`${LATER_KEY}:${release.versionCode}`, String(Date.now())).catch(() => {}); } },
      { text: 'Update', onPress: () => { install(release).catch(error => Alert.alert('Update failed', error?.message || 'The update could not be downloaded. Try again later.')); } },
    ]);
  } catch { /* no network or no release info: try again next launch */ }
}
