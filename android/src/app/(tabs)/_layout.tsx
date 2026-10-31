import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { C, F } from '../../lib/theme';
import { useSizes } from '../../components/ui';

type IconName = keyof typeof Ionicons.glyphMap;
function icon(name: IconName) {
  function TabIcon({ color, size }: { color: unknown; size: number }) {
    return <Ionicons name={name} color={typeof color === 'string' ? color : undefined} size={size} />;
  }
  return TabIcon;
}

export default function TabsLayout() {
  const { tv } = useSizes();
  return (
    <Tabs screenOptions={{
      headerShown: false,
      // TV: tabs sit at the top, where the remote reaches them first.
      tabBarPosition: tv ? 'top' : 'bottom',
      tabBarStyle: { backgroundColor: 'rgba(15,19,32,0.98)', borderTopColor: C.line, height: tv ? 64 : undefined },
      tabBarActiveTintColor: C.marigold,
      tabBarInactiveTintColor: C.dust,
      tabBarLabelStyle: { fontFamily: F.semibold, fontSize: tv ? 15 : 12 },
      sceneStyle: { backgroundColor: C.night },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('home') }} />
      <Tabs.Screen name="movies" options={{ title: 'Movies', tabBarIcon: icon('film') }} />
      <Tabs.Screen name="series" options={{ title: 'Series', tabBarIcon: icon('tv') }} />
      <Tabs.Screen name="search" options={{ title: 'Search', tabBarIcon: icon('search') }} />
      <Tabs.Screen name="mylist" options={{ title: 'My List', tabBarIcon: icon('bookmark') }} />
    </Tabs>
  );
}
