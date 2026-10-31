import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ContinueRow, Row } from '../../components/cards';
import { Hero } from '../../components/Hero';
import { recent } from '../../lib/api';
import { C, F } from '../../lib/theme';

const ROWS: { title: string; path: string; kind?: 'top'; filter?: typeof recent }[] = [
  { title: 'Top 10 movies on CutCrew', path: '/api/movies/trending', kind: 'top' },
  { title: 'New releases', path: '/api/discover?type=movie&limit=24', filter: recent },
  { title: 'Popular series', path: '/api/series/trending' },
  { title: 'Action movies', path: '/api/discover?type=movie&genre=Action&limit=24' },
  { title: 'Comedies', path: '/api/discover?type=movie&genre=Comedy&limit=24' },
  { title: 'Thrillers', path: '/api/discover?type=movie&genre=Thriller&limit=24' },
  { title: 'Crime series', path: '/api/discover?type=series&genre=Crime&limit=24' },
  { title: 'Animated movies', path: '/api/discover?type=movie&genre=Animation&limit=24' },
  { title: 'Romance', path: '/api/discover?type=movie&genre=Romance&limit=24' },
  { title: 'Horror', path: '/api/discover?type=movie&genre=Horror&limit=24' },
];

export default function Home() {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.night }} contentContainerStyle={{ paddingBottom: 24 }}>
      <Hero />
      <View style={[styles.brand, { top: insets.top + 10 }]} pointerEvents="none">
        <Text style={styles.logo}>Cut</Text><View style={styles.cut} /><Text style={styles.logo}>Crew</Text>
      </View>
      <View style={{ marginTop: 8 }}>
        <ContinueRow />
        {ROWS.map(row => <Row key={row.title} {...row} />)}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  brand: { position: 'absolute', left: 16, flexDirection: 'row', alignItems: 'center', gap: 6 },
  logo: { color: C.screen, fontFamily: F.display, fontSize: 22, letterSpacing: -0.4 },
  cut: { width: 6, height: 22, backgroundColor: C.marigold, transform: [{ skewX: '-18deg' }], borderRadius: 1 },
});
