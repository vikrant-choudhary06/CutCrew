import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openWatch, Row } from '../../components/cards';
import { Art, Button, Chip, Focusable, Loading, Notice, RoundButton, useSizes } from '../../components/ui';
import { backdropPreview, backdropUrl, GENRES, isAnime, isSeries, logoUrl, ratingLabel, runtimeLabel, sortedEpisodes, sortedSeasons, titlePath, type Title } from '../../lib/api';
import { useLibrary } from '../../lib/library';
import { C, F, R } from '../../lib/theme';
import { useFetch } from '../../lib/useFetch';

export default function TitleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width, height, tv, tablet, gutter } = useSizes();
  const lib = useLibrary();
  const { data, loading, error, retry } = useFetch<{ data: Title }>(id ? titlePath(id) : null, { timeout: 90000 });
  const t = data?.data;
  const [logoFailed, setLogoFailed] = useState(Boolean(id && isAnime(id)));
  const seasons = useMemo(() => (t ? sortedSeasons(t) : []), [t]);
  const resume = t ? lib.resumeFor(t.imdb_id) : undefined;
  const [season, setSeason] = useState<number | null>(null);

  if (!t) {
    return (
      <View style={{ flex: 1, backgroundColor: C.night, paddingTop: insets.top }}>
        <BackButton />
        {loading ? <Loading /> : <Notice title="This title couldn't be found." body={error} action="Try again" onAction={retry} />}
      </View>
    );
  }

  const series = isSeries(t);
  // Anime: one AniList entry is one season, so it is counted and played by episode.
  const anime = isAnime(t);
  const episodeCount = sortedEpisodes(seasons[0]).length;
  const current = seasons.find(s => s.season_number === (season ?? resume?.season ?? seasons[0]?.season_number)) || seasons[0];
  const firstEp = sortedEpisodes(seasons[0])[0];
  const playLabel = resume ? (series && resume.season ? (anime ? `Resume E${resume.episode}` : `Resume S${resume.season} E${resume.episode}`) : 'Resume')
    : series && firstEp ? (anime ? `Play E${firstEp.episode_number}` : `Play S${seasons[0].season_number} E${firstEp.episode_number}`) : 'Play';
  const play = () => resume ? openWatch(t.imdb_id, resume.season || undefined, resume.episode || undefined)
    : series && firstEp ? openWatch(t.imdb_id, seasons[0].season_number, firstEp.episode_number) : openWatch(t.imdb_id);
  const saved = lib.isSaved(t.imdb_id);
  const facts = [t.release_year, t.content_rating, series ? (anime ? (episodeCount ? `${episodeCount} episode${episodeCount > 1 ? 's' : ''}` : 'Anime') : seasons.length ? `${seasons.length} season${seasons.length > 1 ? 's' : ''}` : 'Series') : runtimeLabel(t.runtime_minutes), (t.genres || []).slice(0, 3).join(', ')].filter(Boolean);
  const cast = (t.cast || []).map(c => c.name).filter(Boolean) as string[];
  const meta = new Map((t.episode_metadata || []).map(e => [`${e.season}:${e.episode}`, e]));
  const genre = (t.genres || []).find(g => GENRES.includes(g));
  const wideLayout = tv || (tablet && width > height);
  const heroHeight = wideLayout ? height * 0.72 : Math.min(height * 0.55, 480);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.night }} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ height: heroHeight }}>
        <Image source={backdropUrl(t)} placeholder={backdropPreview(t) || undefined} placeholderContentFit="cover" style={StyleSheet.absoluteFill} contentFit="cover" contentPosition={{ top: '20%', left: '65%' }} transition={400} cachePolicy="memory-disk" />
        <LinearGradient colors={['rgba(15,19,32,0.6)', 'transparent', C.night]} locations={[0, 0.35, 1]} style={StyleSheet.absoluteFill} />
        <View style={{ position: 'absolute', top: insets.top + 6, left: 0 }}><BackButton /></View>
      </View>
      <View style={{ paddingHorizontal: gutter, marginTop: wideLayout ? -heroHeight * 0.45 : -60, gap: 12, maxWidth: wideLayout ? 720 : undefined }}>
        {!logoFailed
          ? <Image source={logoUrl(t)} style={{ width: Math.min(width * 0.7, 420), height: wideLayout ? 120 : 90 }} contentFit="contain" contentPosition="left" onError={() => setLogoFailed(true)} accessibilityLabel={t.title} />
          : <Text style={st.title}>{t.title}</Text>}
        <View style={st.factsRow}>
          <Text style={st.facts}>{facts.join('  ·  ')}</Text>
          {!!ratingLabel(t.rating) && <Text style={st.rating}>★ {ratingLabel(t.rating)}</Text>}
        </View>
        {!!t.plot && <Text style={st.plot}>{t.plot}</Text>}
        {cast.length > 0 && <Text style={st.cast}><Text style={{ color: C.dust }}>Starring </Text>{cast.slice(0, 4).join(', ')}</Text>}
        <View style={st.actions}>
          <Button label={playLabel} icon="▶" onPress={play} />
          <RoundButton label={saved ? 'Remove from My List' : 'Add to My List'} icon={saved ? '✓' : '+'} active={saved} onPress={() => lib.toggleWatchlist(t)} />
        </View>
      </View>

      {series && seasons.length > 0 && (
        <View style={{ marginTop: 28 }}>
          <Text style={[st.section, { paddingHorizontal: gutter }]}>Episodes</Text>
          {seasons.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: gutter, gap: 8, paddingVertical: 10 }}>
            {seasons.map(s => <Chip key={s.season_number} label={`Season ${s.season_number}`} active={s.season_number === current?.season_number} onPress={() => setSeason(s.season_number)} />)}
          </ScrollView>}
          <View style={{ paddingHorizontal: gutter, gap: 10, marginTop: 6 }}>
            {sortedEpisodes(current).map(ep => {
              const info = meta.get(`${current!.season_number}:${ep.episode_number}`);
              const p = lib.progress.find(x => x.data.imdb_id === t.imdb_id && x.season === current!.season_number && x.episode === ep.episode_number);
              const thumbWidth = wideLayout ? 220 : Math.min(150, width * 0.36);
              return (
                <Focusable key={ep.episode_number} onPress={() => openWatch(t.imdb_id, current!.season_number, ep.episode_number)} style={st.episode}
                  accessibilityLabel={`Episode ${ep.episode_number}: ${info?.title || ep.title || ''}`}>
                  <View>
                    <Art uri={info?.thumbnail} label={`Episode ${ep.episode_number}`} style={{ width: thumbWidth, aspectRatio: 16 / 9 }} />
                    {!!p?.duration && <View style={st.track}><View style={[st.fill, { width: `${p.completed ? 100 : Math.min(100, (p.position / p.duration) * 100)}%` }]} /></View>}
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={st.epNum}>Episode {ep.episode_number}{p?.completed ? '  ·  Watched' : ''}</Text>
                    <Text style={st.epTitle} numberOfLines={2}>{info?.title || ep.title || `Episode ${ep.episode_number}`}</Text>
                  </View>
                </Focusable>
              );
            })}
          </View>
        </View>
      )}

      <View style={{ marginTop: 30 }}>
        <Row title="More like this" {...(isAnime(t) ? { items: t.recommendations || [] } : {})} path={`/api/discover?type=${series ? 'series' : 'movie'}&limit=24${genre ? '&genre=' + encodeURIComponent(genre) : ''}`}
          filter={items => items.filter(x => x.imdb_id !== t.imdb_id)} limit={14} />
      </View>
    </ScrollView>
  );
}

function BackButton() {
  return (
    <Focusable onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityLabel="Back" style={st.back}>
      <Ionicons name="chevron-back" size={26} color={C.screen} />
    </Focusable>
  );
}

const st = StyleSheet.create({
  back: { margin: 10, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(15,19,32,0.6)', alignItems: 'center', justifyContent: 'center' },
  title: { color: C.screen, fontFamily: F.display, fontSize: 36, lineHeight: 38, letterSpacing: -0.8 },
  factsRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  facts: { color: C.screen, fontFamily: F.medium, fontSize: 14 },
  rating: { color: C.marigold, fontFamily: F.bold, fontSize: 14 },
  plot: { color: 'rgba(242,240,234,0.92)', fontFamily: F.text, fontSize: 15, lineHeight: 23 },
  cast: { color: C.screen, fontFamily: F.text, fontSize: 13, lineHeight: 19 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  section: { color: C.screen, fontFamily: F.bold, fontSize: 20 },
  episode: { flexDirection: 'row', gap: 14, alignItems: 'center', padding: 6, borderRadius: R.control },
  epNum: { color: C.dust, fontFamily: F.text, fontSize: 13 },
  epTitle: { color: C.screen, fontFamily: F.semibold, fontSize: 15 },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, backgroundColor: 'rgba(242,240,234,0.25)' },
  fill: { height: 4, backgroundColor: C.marigold },
});
