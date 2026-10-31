// Movies / Series tab: genre chips and a poster grid with "Load more".
import { useEffect, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GENRES, getJSON, type Title } from '../lib/api';
import { C, F } from '../lib/theme';
import { PosterCard } from './cards';
import { Button, Chip, Loading, Notice, useSizes } from './ui';

export function Browse({ type }: { type: 'movie' | 'series' }) {
  const insets = useSafeAreaInsets();
  const { width, gutter, poster } = useSizes();
  const [genre, setGenre] = useState('');
  const [attempt, setAttempt] = useState(0);
  const key = `${type}|${genre}`;
  // The page count belongs to one filter; a new genre starts at page 1.
  const [paging, setPaging] = useState({ key, page: 1 });
  const page = paging.key === key ? paging.page : 1;
  const setPage = (next: (p: number) => number) => setPaging({ key, page: next(page) });
  const request = `${key}|${page}|${attempt}`;
  const [result, setResult] = useState<{ request: string; key: string; items: Title[]; more: boolean; error: string }>({ request: '', key: '', items: [], more: false, error: '' });
  const columns = Math.max(3, Math.floor((width - gutter * 2 + 12) / (poster + 12)));
  const cardWidth = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);

  useEffect(() => {
    let live = true;
    const limit = 24 * page;
    getJSON<{ data: Title[]; hasMore?: boolean }>(`/api/discover?type=${type}&limit=${limit}${genre ? '&genre=' + encodeURIComponent(genre) : ''}`, { timeout: 60000 })
      .then(body => { if (live) setResult({ request, key, items: (body.data || []).filter(x => x.imdb_id), more: Boolean(body.hasMore) || (body.data || []).length >= limit, error: '' }); })
      .catch((e: Error) => { if (live) setResult(r => ({ ...r, request, error: e.message })); });
    return () => { live = false; };
  }, [request, key, page, type, genre]);
  // Loading is derived: the shown answer belongs to an older request.
  const loading = result.request !== request;
  const state = { items: result.key === key ? result.items : [], more: result.more, error: loading ? '' : result.error, loading };

  const header = (
    <View style={{ paddingTop: insets.top + 14 }}>
      <Text style={[b.title, { paddingHorizontal: gutter }]}>{genre ? `${genre} ${type === 'movie' ? 'movies' : 'series'}` : type === 'movie' ? 'Movies' : 'Series'}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: gutter, gap: 8, paddingVertical: 12 }}>
        <Chip label="All" active={!genre} onPress={() => setGenre('')} />
        {GENRES.map(g => <Chip key={g} label={g} active={genre === g} onPress={() => setGenre(g)} />)}
      </ScrollView>
    </View>
  );

  return (
    <FlatList
      key={columns}
      style={{ flex: 1, backgroundColor: C.night }}
      data={state.items}
      numColumns={columns}
      keyExtractor={x => x.imdb_id}
      ListHeaderComponent={header}
      columnWrapperStyle={{ gap: 12, paddingHorizontal: gutter }}
      contentContainerStyle={{ gap: 18, paddingBottom: 32 }}
      renderItem={({ item }) => <PosterCard item={item} width={cardWidth} />}
      ListEmptyComponent={state.loading ? <Loading /> : state.error ? <Notice title="Couldn't load this list." body={state.error} action="Try again" onAction={() => setAttempt(n => n + 1)} /> : <Notice title="Nothing here yet." />}
      ListFooterComponent={state.items.length > 0 ? (state.loading ? <Loading label="Loading more…" /> : state.more ? <View style={{ alignItems: 'center', marginTop: 10 }}><Button label="Load more" kind="quiet" onPress={() => setPage(p => p + 1)} /></View> : undefined) : undefined}
    />
  );
}

const b = StyleSheet.create({
  title: { color: C.screen, fontFamily: F.display, fontSize: 32, letterSpacing: -0.6 },
});
