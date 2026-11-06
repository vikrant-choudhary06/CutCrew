import { BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold } from '@expo-google-fonts/bricolage-grotesque';
import { Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold, useFonts } from '@expo-google-fonts/figtree';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LibraryProvider } from '../lib/library';
import { checkForNewApk } from '../lib/updates';
import { C } from '../lib/theme';
import { loadPreferredAudio } from '../lib/audio';

loadPreferredAudio();

SystemUI.setBackgroundColorAsync(C.night).catch(() => {});

export default function RootLayout() {
  useEffect(() => { const t = setTimeout(() => { checkForNewApk(); }, 4000); return () => clearTimeout(t); }, []);
  const [loaded] = useFonts({ BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold, Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold });
  if (!loaded) return <View style={{ flex: 1, backgroundColor: C.night }} />;
  return (
    <SafeAreaProvider>
      <LibraryProvider>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.night }, animation: 'fade' }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="title/[id]" />
          <Stack.Screen name="watch/[id]" options={{ animation: 'fade', orientation: 'landscape' }} />
        </Stack>
      </LibraryProvider>
    </SafeAreaProvider>
  );
}
