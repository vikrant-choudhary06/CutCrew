import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PosterCard, Row } from '../../components/cards';
import { Chip, Loading, Notice, useSizes } from '../../components/ui';
import { getJSON, type Title } from '../../lib/api';
import { C, F, R } from '../../lib/theme';

const RECENT = 'cutcrew-recent-searches';

export default function Search() {
  const insets = useSafeAreaInsets();
  const { width, gutter, poster } = useSizes();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ query: string; items: Title[]; error: string }>({ query: '', items: [], error: '' });
  const [recent, setRecent] = useState<string[]>([]);
  const columns = Math.max(3, Math.floor((width - gutter * 2 + 12) / (poster + 12)));
  const cardWidth = Math.floor((width - gutter * 2 - (columns - 1) * 12) / columns);

  useEffect(() => { AsyncStorage.getItem(RECENT).then(v => setRecent(v ? JSON.parse(v) : [])).catch(() => {}); }, []);
  // Search shortly after typing stops.
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 350); return () => clearTimeout(t); }, [text]);
  useEffect(() => {
    if (!query) return;
    let live = true;
    getJSON<{ data: Title[] }>('/api/movies/search?query=' + encodeURIComponent(query))
      .then(body => {
        if (!live) return;
        const items = (body.data || []).filter(x => x.imdb_id);
        setResult({ query, items, error: '' });
        if (items.length) setRecent(list => { const next = [query, ...list.filter(x => x.toLowerCase() !== query.toLowerCase())].slice(0, 8); AsyncStorage.setItem(RECENT, JSON.stringify(next)).catch(() => {}); return next; });
      })
      .catch((e: Error) => { if (live) setResult({ query, items: [], error: e.message }); });
    return () => { live = false; };
  }, [query]);

  const searching = Boolean(query) && result.query !== query;
  return (
    <View style={{ flex: 1, backgroundColor: C.night, paddingTop: insets.top + 12 }}>
      <View style={[s.field, { marginHorizontal: gutter }]}>
        <Ionicons name="search" size={20} color={C.dust} />
        <TextInput value={text} onChangeText={setText} placeholder="Search movies and series" placeholderTextColor={C.dust}
          style={s.input} returnKeyType="search" autoCorrect={false} onSubmitEditing={() => setQuery(text.trim())} accessibilityLabel="Search movies and series" />
        {!!text && <Ionicons name="close" size={20} color={C.dust} onPress={() => { setText(''); setQuery(''); }} accessibilityLabel="Clear search" />}
      </View>
      {!query ? (
        <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
          {recent.length > 0 && <View style={{ paddingHorizontal: gutter, marginBottom: 20 }}>
            <Text style={s.head}>Recent searches</Text>
            <View style={s.chips}>{recent.map(r => <Chip key={r} label={r} onPress={() => setText(r)} />)}</View>
          </View>}
          <Row title="Popular right now" path="/api/movies/trending" />
        </ScrollView>
      ) : searching ? <Loading label="Searching…" />
        : result.error ? <Notice title="Search is unavailable right now." body={result.error} />
          : !result.items.length ? <Notice title={`No results for “${query}”.`} body="Check the spelling or try a shorter title." />
            : <FlatList key={columns} data={result.items} numColumns={columns} keyExtractor={x => x.imdb_id}
                ListHeaderComponent={<Text style={[s.count, { paddingHorizontal: gutter }]}>{result.items.length} result{result.items.length === 1 ? '' : 's'} for “{query}”</Text>}
                columnWrapperStyle={{ gap: 12, paddingHorizontal: gutter }} contentContainerStyle={{ gap: 18, paddingVertical: 14 }}
                renderItem={({ item }) => <PosterCard item={item} width={cardWidth} />} />}
    </View>
  );
}

const s = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 54, paddingHorizontal: 16, borderRadius: R.control + 4, backgroundColor: C.velvet, borderWidth: 1, borderColor: C.line },
  input: { flex: 1, color: C.screen, fontFamily: F.medium, fontSize: 17, height: '100%' },
  head: { color: C.screen, fontFamily: F.bold, fontSize: 18, marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  count: { color: C.dust, fontFamily: F.text, fontSize: 14 },
});
