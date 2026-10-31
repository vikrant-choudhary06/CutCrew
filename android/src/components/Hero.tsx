// Featured title at the top of Home: wide artwork, title logo, facts and Play.
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { backdropUrl, isSeries, logoUrl, runtimeLabel, type Title } from '../lib/api';
import { useLibrary } from '../lib/library';
import { C, F } from '../lib/theme';
import { useFetch } from '../lib/useFetch';
import { openTitle, openWatch } from './cards';
import { Button, RoundButton, useSizes } from './ui';

export function Hero() {
  const { width, height, tv, tablet, gutter } = useSizes();
  const lib = useLibrary();
  const { data } = useFetch<{ data: Title[] }>('/api/featured', { timeout: 25000 });
  const items = useMemo(() => (data?.data || []).filter(x => x.imdb_id && x.backdrop_url).slice(0, 5), [data]);
  const [index, setIndex] = useState(0);
  const [logoFailed, setLogoFailed] = useState<Record<string, boolean>>({});

  // Changes every 9 seconds.
  useEffect(() => {
    if (items.length < 2) return;
    const timer = setInterval(() => setIndex(i => (i + 1) % items.length), 9000);
    return () => clearInterval(timer);
  }, [items.length]);

  const heroHeight = tv ? height * 0.78 : tablet ? Math.min(height * 0.62, 640) : Math.min(height * 0.66, 560);
  const item = items[index % Math.max(1, items.length)];
  if (!item) return <View style={{ height: heroHeight, backgroundColor: C.velvet }} />;
  const saved = lib.isSaved(item.imdb_id);
  const facts = [item.release_year, runtimeLabel(item.runtime_minutes) || (isSeries(item) ? 'Series' : ''), (item.genres || []).slice(0, 2).join(', ')].filter(Boolean);
  const wideLayout = tv || (tablet && width > height);

  return (
    <View style={{ height: heroHeight }}>
      <Image source={backdropUrl(item, 'large')} style={StyleSheet.absoluteFill} contentFit="cover" contentPosition={{ top: '20%', left: '65%' }} transition={600} cachePolicy="memory-disk" />
      <LinearGradient colors={['rgba(15,19,32,0.55)', 'transparent', 'rgba(15,19,32,0.75)', C.night]} locations={[0, 0.3, 0.72, 1]} style={StyleSheet.absoluteFill} />
      {wideLayout && <LinearGradient colors={['rgba(15,19,32,0.9)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 0.7, y: 0 }} style={StyleSheet.absoluteFill} />}
      <View style={[h.body, { paddingHorizontal: gutter, maxWidth: wideLayout ? 620 : undefined }]}>
        {!logoFailed[item.imdb_id]
          ? <Image source={logoUrl(item)} style={{ width: Math.min(width * (wideLayout ? 0.36 : 0.72), 420), height: wideLayout ? 130 : 96 }} contentFit="contain" contentPosition="left" onError={() => setLogoFailed(m => ({ ...m, [item.imdb_id]: true }))} accessibilityLabel={item.title} />
          : <Text style={h.title} numberOfLines={2}>{item.title}</Text>}
        <Text style={h.facts}>{facts.join('  ·  ')}</Text>
        {!!item.plot && <Text style={h.plot} numberOfLines={wideLayout ? 3 : 2}>{item.plot}</Text>}
        <View style={h.actions}>
          <Button label="Play" icon="▶" onPress={() => openWatch(item.imdb_id)} />
          <Button label="More info" kind="quiet" onPress={() => openTitle(item)} />
          <RoundButton label={saved ? 'Remove from My List' : 'Add to My List'} icon={saved ? '✓' : '+'} active={saved} onPress={() => lib.toggleWatchlist(item)} />
        </View>
        {items.length > 1 && <View style={h.dots}>{items.map((x, i) => <View key={x.imdb_id} style={[h.dot, i === index && h.dotOn]} />)}</View>}
      </View>
    </View>
  );
}

const h = StyleSheet.create({
  body: { position: 'absolute', left: 0, right: 0, bottom: 18, gap: 10 },
  title: { color: C.screen, fontFamily: F.display, fontSize: 38, lineHeight: 40, letterSpacing: -0.8 },
  facts: { color: C.screen, fontFamily: F.medium, fontSize: 14 },
  plot: { color: 'rgba(242,240,234,0.9)', fontFamily: F.text, fontSize: 15, lineHeight: 22 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' },
  dots: { flexDirection: 'row', gap: 6, marginTop: 8 },
  dot: { width: 18, height: 4, borderRadius: 2, backgroundColor: 'rgba(242,240,234,0.35)' },
  dotOn: { backgroundColor: C.marigold, width: 28 },
});
