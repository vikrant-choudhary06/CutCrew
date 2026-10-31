import { router } from 'expo-router';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { backdropUrl, isSeries, posterUrl, type Title } from '../lib/api';
import { useLibrary, type Progress } from '../lib/library';
import { C, F, R } from '../lib/theme';
import { useFetch } from '../lib/useFetch';
import { Art, Focusable, useSizes } from './ui';

export const openTitle = (t: Title) => router.push({ pathname: '/title/[id]', params: { id: t.imdb_id } });
export const openWatch = (id: string, season?: number, episode?: number) =>
  router.push({ pathname: '/watch/[id]', params: { id, ...(season ? { season: String(season), episode: String(episode) } : {}) } });

export function PosterCard({ item, width }: { item: Title; width: number }) {
  return (
    <Focusable onPress={() => openTitle(item)} style={{ width }} accessibilityLabel={`${item.title}${item.release_year ? ', ' + item.release_year : ''}`}>
      <Art uri={posterUrl(item)} label={item.title} style={{ width, aspectRatio: 2 / 3 }} />
      <Text style={c.title} numberOfLines={1}>{item.title}</Text>
      <Text style={c.meta} numberOfLines={1}>{[item.release_year, isSeries(item) ? 'Series' : 'Movie'].filter(Boolean).join('  ')}</Text>
    </Focusable>
  );
}

export function ContinueCard({ entry, width }: { entry: Progress; width: number }) {
  const lib = useLibrary();
  const t = entry.data;
  const left = entry.duration ? Math.max(0, Math.round((entry.duration - entry.position) / 60)) : null;
  const where = entry.season > 0 ? `S${entry.season} E${entry.episode}` : '';
  return (
    <View style={{ width }}>
      <Focusable onPress={() => openWatch(t.imdb_id, entry.season || undefined, entry.episode || undefined)}
        onLongPress={() => lib.removeProgress(t.imdb_id)} accessibilityLabel={`Resume ${t.title} ${where}`}>
        <Art uri={backdropUrl(t, 'small')} label={t.title} style={{ width, aspectRatio: 16 / 9 }} />
        <View style={c.playBadge}><Text style={c.playIcon}>▶</Text></View>
        {!!entry.duration && <View style={c.track}><View style={[c.fill, { width: `${Math.min(100, (entry.position / entry.duration) * 100)}%` }]} /></View>}
      </Focusable>
      <Text style={c.title} numberOfLines={1}>{t.title}</Text>
      <Text style={c.meta}>{[where, left != null ? `${left} min left` : ''].filter(Boolean).join('  ')}</Text>
    </View>
  );
}

export function TopCard({ item, rank, width }: { item: Title; rank: number; width: number }) {
  return (
    <Focusable onPress={() => openTitle(item)} style={{ width: width * 1.55, flexDirection: 'row', alignItems: 'flex-end' }} accessibilityLabel={`Number ${rank}: ${item.title}`}>
      <Text style={[c.rank, { fontSize: width * 0.95, lineHeight: width * 0.82, width: width * 0.62 }]}>{rank}</Text>
      <Art uri={posterUrl(item)} label={item.title} style={{ width, aspectRatio: 2 / 3, marginLeft: -width * 0.08 }} />
    </Focusable>
  );
}

type RowProps = { title: string; path?: string; items?: Title[]; kind?: 'poster' | 'top'; filter?: (x: Title[]) => Title[]; limit?: number };

// A titled horizontal rail. Hidden when it has nothing to show.
export function Row({ title, path, items: given, kind = 'poster', filter, limit = 18 }: RowProps) {
  const { poster, gutter } = useSizes();
  const { data, loading } = useFetch<{ data: Title[] }>(given ? null : path || null, { timeout: 60000 });
  let items = given || data?.data || [];
  if (filter) items = filter(items);
  items = items.filter(x => x?.imdb_id).slice(0, limit);
  if (!loading && !items.length) return null;
  return (
    <View style={{ marginBottom: 26 }}>
      <Text style={[c.rowTitle, { paddingHorizontal: gutter }]}>{title}</Text>
      {loading && !items.length
        ? <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: gutter }}>{[0, 1, 2, 3, 4].map(i => <View key={i} style={{ width: poster, aspectRatio: 2 / 3.4, borderRadius: R.card, backgroundColor: C.velvet }} />)}</View>
        : <FlatList horizontal data={items} keyExtractor={x => x.imdb_id} showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: gutter, gap: kind === 'top' ? 6 : 12, paddingVertical: 6 }}
            renderItem={({ item, index }) => kind === 'top' ? <TopCard item={item} rank={index + 1} width={poster} /> : <PosterCard item={item} width={poster} />} />}
    </View>
  );
}

export function ContinueRow() {
  const lib = useLibrary();
  const { wide, gutter } = useSizes();
  if (!lib.continueWatching.length) return null;
  return (
    <View style={{ marginBottom: 26 }}>
      <Text style={[c.rowTitle, { paddingHorizontal: gutter }]}>Continue watching</Text>
      <FlatList horizontal data={lib.continueWatching} keyExtractor={x => x.data.imdb_id} showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: gutter, gap: 12, paddingVertical: 6 }}
        renderItem={({ item }) => <ContinueCard entry={item} width={wide} />} />
    </View>
  );
}

const c = StyleSheet.create({
  title: { color: C.screen, fontFamily: F.semibold, fontSize: 13, marginTop: 7 },
  meta: { color: C.dust, fontFamily: F.text, fontSize: 12, marginTop: 1 },
  rowTitle: { color: C.screen, fontFamily: F.bold, fontSize: 19, marginBottom: 8, letterSpacing: -0.2 },
  playBadge: { position: 'absolute', left: 10, bottom: 14, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(15,19,32,0.75)', borderWidth: 1.5, borderColor: 'rgba(242,240,234,0.7)', alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: C.screen, fontSize: 13, marginLeft: 2 },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, backgroundColor: 'rgba(242,240,234,0.25)' },
  fill: { height: 4, backgroundColor: C.marigold },
  rank: { color: C.marigold, fontFamily: F.display, textAlign: 'right', letterSpacing: -6, opacity: 0.92 },
});
