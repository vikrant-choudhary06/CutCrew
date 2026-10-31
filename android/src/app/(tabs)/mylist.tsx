import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ContinueCard, PosterCard } from '../../components/cards';
import { Chip, Notice, useSizes } from '../../components/ui';
import { useLibrary } from '../../lib/library';
import { C, F } from '../../lib/theme';

export default function MyList() {
  const insets = useSafeAreaInsets();
  const lib = useLibrary();
  const { width, gutter, poster, wide } = useSizes();
  const [tab, setTab] = useState<'saved' | 'continue'>('saved');
  const columns = Math.max(3, Math.floor((width - gutter * 2 + 12) / (poster + 12)));
  const cardWidth = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);
  const wideColumns = Math.max(1, Math.floor((width - gutter * 2 + 12) / (wide + 12)));
  const wideWidth = Math.floor((width - gutter * 2 - (wideColumns - 1) * 12) / wideColumns);

  const header = (
    <View style={{ paddingHorizontal: gutter, paddingTop: insets.top + 14, gap: 12, marginBottom: 8 }}>
      <Text style={s.title}>My List</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label={`Saved (${lib.watchlist.length})`} active={tab === 'saved'} onPress={() => setTab('saved')} />
        <Chip label={`Continue watching (${lib.continueWatching.length})`} active={tab === 'continue'} onPress={() => setTab('continue')} />
      </View>
    </View>
  );

  if (tab === 'continue') {
    return (
      <FlatList key={'c' + wideColumns} style={{ flex: 1, backgroundColor: C.night }} data={lib.continueWatching} numColumns={wideColumns}
        keyExtractor={x => x.data.imdb_id} ListHeaderComponent={header}
        columnWrapperStyle={wideColumns > 1 ? { gap: 12, paddingHorizontal: gutter } : undefined}
        contentContainerStyle={{ gap: 18, paddingBottom: 32 }}
        renderItem={({ item }) => <View style={wideColumns > 1 ? undefined : { paddingHorizontal: gutter }}><ContinueCard entry={item} width={wideColumns > 1 ? wideWidth : width - gutter * 2} /></View>}
        ListEmptyComponent={<Notice title="Nothing in progress." body="Movies and episodes you start show up here. Long-press one to remove it." />} />
    );
  }
  return (
    <FlatList key={'s' + columns} style={{ flex: 1, backgroundColor: C.night }} data={lib.watchlist} numColumns={columns}
      keyExtractor={x => x.imdb_id} ListHeaderComponent={header}
      columnWrapperStyle={{ gap: 12, paddingHorizontal: gutter }} contentContainerStyle={{ gap: 18, paddingBottom: 32 }}
      renderItem={({ item }) => <PosterCard item={item} width={cardWidth} />}
      ListEmptyComponent={<Notice title="Your list is empty." body="Tap + on any movie or series to save it here." />} />
  );
}

const s = StyleSheet.create({
  title: { color: C.screen, fontFamily: F.display, fontSize: 32, letterSpacing: -0.6 },
});
