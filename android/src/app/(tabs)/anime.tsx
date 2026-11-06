// Anime tab: the lists and genre rows the website's anime page shows (from
// AniList), or a poster grid with "Load more" once a genre is picked.
import { useEffect, useState, type ReactElement } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PosterCard, Row } from '../../components/cards';
import { Button, Chip, Loading, Notice, useSizes } from '../../components/ui';
import { ANIME_GENRES, getJSON, type Title } from '../../lib/api';
import { C, F } from '../../lib/theme';

const LISTS: { kind: string; title: string }[] = [
  { kind: 'trending', title: 'Trending now' },
  { kind: 'season', title: 'New this season' },
  { kind: 'airing', title: 'Airing now' },
  { kind: 'popular', title: 'Most popular' },
  { kind: 'top', title: 'Top rated' },
  { kind: 'movies', title: 'Anime movies' },
];
const GENRE_ROWS = ['Action', 'Romance', 'Comedy', 'Fantasy', 'Slice of Life', 'Sports'];
const ROWS = [
  ...LISTS.map(l => ({ id: l.kind, title: l.title, path: `/api/anime/browse?kind=${l.kind}` })),
  ...GENRE_ROWS.map(g => ({ id: 'genre-' + g, title: `${g} anime`, path: `/api/anime/browse?kind=popular&genre=${encodeURIComponent(g)}` })),
];

export default function Anime() {
  const insets = useSafeAreaInsets();
  const { gutter } = useSizes();
  const [genre, setGenre] = useState('');

  const header = (
    <View style={{ paddingTop: insets.top + 14 }}>
      <Text style={[a.title, { paddingHorizontal: gutter }]}>{genre ? `${genre} anime` : 'Anime'}</Text>
      {!genre && <Text style={[a.sub, { paddingHorizontal: gutter }]}>Japanese audio with subtitles.</Text>}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: gutter, gap: 8, paddingVertical: 12 }}>
        <Chip label="All anime" active={!genre} onPress={() => setGenre('')} />
        {ANIME_GENRES.map(g => <Chip key={g} label={g} active={genre === g} onPress={() => setGenre(g)} />)}
      </ScrollView>
    </View>
  );

  if (genre) return <AnimeGrid key={genre} genre={genre} header={header} />;
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: C.night }}
      contentContainerStyle={{ paddingBottom: 24 }}
      data={ROWS}
      keyExtractor={row => row.id}
      ListHeaderComponent={header}
      renderItem={({ item: row }) => <Row title={row.title} path={row.path} kind={row.id === 'trending' ? 'top' : 'poster'} limit={row.id === 'trending' ? 10 : 18} />}
      // Rows load as they scroll into view, so AniList is not asked for all twelve at once.
      initialNumToRender={3}
      maxToRenderPerBatch={2}
      windowSize={5}
      removeClippedSubviews
    />
  );
}

// One genre, most popular first, a page of 24 at a time.
function AnimeGrid({ genre, header }: { genre: string; header: ReactElement }) {
  const { width, gutter, poster } = useSizes();
  const [view, setView] = useState({ pages: 1, loaded: 0, items: [] as Title[], more: false, error: '', retry: 0 });
  const columns = Math.max(3, Math.floor((width - gutter * 2 + 12) / (poster + 12)));
  const cardWidth = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);
  const loading = view.loaded < view.pages && !view.error;

  useEffect(() => {
    if (view.loaded >= view.pages) return;
    let live = true;
    const page = view.pages;
    getJSON<{ data: Title[]; hasMore?: boolean }>(`/api/anime/browse?kind=popular&genre=${encodeURIComponent(genre)}&page=${page}&limit=24`, { timeout: 60000 })
      .then(body => {
        if (!live) return;
        setView(v => {
          const seen = new Set(v.items.map(x => x.imdb_id));
          const fresh = (body.data || []).filter(x => x?.imdb_id && !seen.has(x.imdb_id));
          return { ...v, loaded: page, items: [...v.items, ...fresh], more: Boolean(body.hasMore) && page < 20, error: '' };
        });
      })
      .catch((e: Error) => { if (live) setView(v => ({ ...v, error: e.message })); });
    return () => { live = false; };
  }, [genre, view.pages, view.loaded, view.retry]);

  const retry = () => setView(v => ({ ...v, error: '', retry: v.retry + 1 }));
  return (
    <FlatList
      key={columns}
      style={{ flex: 1, backgroundColor: C.night }}
      data={view.items}
      numColumns={columns}
      keyExtractor={x => x.imdb_id}
      ListHeaderComponent={header}
      columnWrapperStyle={{ gap: 12, paddingHorizontal: gutter }}
      contentContainerStyle={{ gap: 18, paddingBottom: 32 }}
      renderItem={({ item }) => <PosterCard item={item} width={cardWidth} />}
      ListEmptyComponent={loading ? <Loading /> : view.error ? <Notice title="Anime could not load." body={view.error} action="Try again" onAction={retry} /> : <Notice title="No anime found." body="Try another genre." />}
      ListFooterComponent={view.items.length > 0 ? (
        loading ? <Loading label="Loading more…" />
          : view.error ? <View style={a.more}><Button label="Couldn't load more. Try again" kind="quiet" onPress={retry} /></View>
            : view.more ? <View style={a.more}><Button label="Load more" kind="quiet" onPress={() => setView(v => ({ ...v, pages: v.pages + 1 }))} /></View>
              : undefined
      ) : undefined}
    />
  );
}

const a = StyleSheet.create({
  title: { color: C.screen, fontFamily: F.display, fontSize: 32, letterSpacing: -0.6 },
  sub: { color: C.dust, fontFamily: F.text, fontSize: 14, marginTop: 4 },
  more: { alignItems: 'center', marginTop: 10 },
});
