// Home: hero + rows from one /api/home call, shown from the phone's saved copy
// first and refreshed in the background. Rows render as the user scrolls to
// them (FlatList), so only the hero and the first rows load at start.
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ContinueRow, Row } from '../../components/cards';
import { Hero } from '../../components/Hero';
import { Loading, Notice } from '../../components/ui';
import { useHome, type HomeRow } from '../../lib/home';
import { C, F } from '../../lib/theme';

export default function Home() {
  const insets = useSafeAreaInsets();
  const { data, error, retry } = useHome();
  const header = (
    <View>
      {/* The hero waits for /api/home (saved copy first) instead of loading /api/featured itself. */}
      <Hero items={data?.hero ?? []} />
      <View style={[styles.brand, { top: insets.top + 10 }]} pointerEvents="none">
        <Text style={styles.logo}>Cut</Text><View style={styles.cut} /><Text style={styles.logo}>Crew</Text>
      </View>
      <View style={{ marginTop: 8 }}><ContinueRow /></View>
    </View>
  );
  return (
    <FlatList<HomeRow>
      style={{ flex: 1, backgroundColor: C.night }}
      contentContainerStyle={{ paddingBottom: 24 }}
      data={data?.rows || []}
      keyExtractor={row => row.id}
      ListHeaderComponent={header}
      ListEmptyComponent={error ? <Notice title="Home could not load." body={error} action="Try again" onAction={retry} /> : <Loading />}
      renderItem={({ item: row }) => <Row title={row.title} items={row.items} kind={row.kind === 'top' ? 'top' : 'poster'} limit={row.kind === 'top' ? 10 : 24} />}
      initialNumToRender={3}
      maxToRenderPerBatch={2}
      windowSize={5}
      removeClippedSubviews
    />
  );
}

const styles = StyleSheet.create({
  brand: { position: 'absolute', left: 16, flexDirection: 'row', alignItems: 'center', gap: 6 },
  logo: { color: C.screen, fontFamily: F.display, fontSize: 22, letterSpacing: -0.4 },
  cut: { width: 6, height: 22, backgroundColor: C.marigold, transform: [{ skewX: '-18deg' }], borderRadius: 1 },
});
