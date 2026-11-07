// Player menus, drawn over a dimmed picture: Audio & Subtitles (two columns),
// Speed and screen fit, and Episodes for a series.
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { sortedEpisodes, sortedSeasons, type Title } from '../../lib/api';
import { C, F } from '../../lib/theme';

export type Choice = { key: string; label: string; active: boolean; onPick: () => void };

function Shell({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <View style={m.shade}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />
      <View style={[m.panel, wide && m.panelWide]}>
        <View style={m.head}>
          <Text style={m.title}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <MaterialIcons name="close" size={26} color={C.screen} />
          </Pressable>
        </View>
        {children}
      </View>
    </View>
  );
}

function Options({ items }: { items: Choice[] }) {
  return (
    <>
      {items.map(item => (
        <Pressable key={item.key} onPress={item.onPick} style={m.row} accessibilityRole="button" accessibilityState={{ selected: item.active }}>
          <View style={m.check}>{item.active && <MaterialIcons name="check" size={20} color={C.marigold} />}</View>
          <Text style={[m.rowText, item.active && m.rowActive]} numberOfLines={1}>{item.label}</Text>
        </Pressable>
      ))}
    </>
  );
}

export function AudioSubtitlesSheet({ audio, subtitles, note, onClose }: { audio: Choice[]; subtitles: Choice[]; note?: string; onClose: () => void }) {
  return (
    <Shell title="Audio & Subtitles" onClose={onClose} wide>
      <View style={m.columns}>
        <ScrollView style={m.column}>
          <Text style={m.columnTitle}>Audio</Text>
          {audio.length ? <Options items={audio} /> : <Text style={m.empty}>This file has one audio track.</Text>}
        </ScrollView>
        <ScrollView style={m.column}>
          <Text style={m.columnTitle}>Subtitles</Text>
          <Options items={subtitles} />
        </ScrollView>
      </View>
      {!!note && <Text style={m.note}>{note}</Text>}
    </Shell>
  );
}

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
export type Fit = 'contain' | 'cover' | 'fill';
const FITS: { value: Fit; label: string }[] = [{ value: 'contain', label: 'Fit' }, { value: 'cover', label: 'Fill' }, { value: 'fill', label: 'Stretch' }];

export function SpeedSheet({ speed, fit, onSpeed, onFit, onClose }: { speed: number; fit: Fit; onSpeed: (v: number) => void; onFit: (v: Fit) => void; onClose: () => void }) {
  return (
    <Shell title="Playback speed" onClose={onClose} wide>
      <View style={m.pills}>
        {SPEEDS.map(v => (
          <Pressable key={v} onPress={() => onSpeed(v)} style={[m.pill, v === speed && m.pillActive]} accessibilityRole="button" accessibilityState={{ selected: v === speed }}>
            <Text style={[m.pillText, v === speed && m.pillTextActive]}>{v === 1 ? '1x (Normal)' : `${v}x`}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={[m.columnTitle, { marginTop: 18 }]}>Screen</Text>
      <View style={m.pills}>
        {FITS.map(f => (
          <Pressable key={f.value} onPress={() => onFit(f.value)} style={[m.pill, f.value === fit && m.pillActive]} accessibilityRole="button" accessibilityState={{ selected: f.value === fit }}>
            <Text style={[m.pillText, f.value === fit && m.pillTextActive]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={m.note}>Tip: pinch the picture to switch between Fit and Fill.</Text>
    </Shell>
  );
}

export function EpisodesSheet({ title, season, episode, onPick, onClose }: { title: Title; season: number; episode: number; onPick: (season: number, episode: number) => void; onClose: () => void }) {
  const seasons = sortedSeasons(title);
  const [shown, setShown] = useState(season || seasons[0]?.season_number || 1);
  const current = seasons.find(s => s.season_number === shown) || seasons[0];
  const meta = new Map((title.episode_metadata || []).map(e => [`${e.season}:${e.episode}`, e]));
  const anime = title.kind === 'anime';
  return (
    <Shell title="Episodes" onClose={onClose} wide>
      {seasons.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={m.pills}>
          {seasons.map(s => (
            <Pressable key={s.season_number} onPress={() => setShown(s.season_number)} style={[m.pill, s.season_number === shown && m.pillActive]}>
              <Text style={[m.pillText, s.season_number === shown && m.pillTextActive]}>Season {s.season_number}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <ScrollView style={{ marginTop: 10 }}>
        {sortedEpisodes(current).map(ep => {
          const playing = current?.season_number === season && ep.episode_number === episode;
          const name = meta.get(`${current?.season_number}:${ep.episode_number}`)?.title || ep.title || '';
          return (
            <Pressable key={ep.episode_number} onPress={() => onPick(current!.season_number, ep.episode_number)} style={[m.episode, playing && m.episodeActive]} accessibilityRole="button">
              <Text style={m.episodeNumber}>{ep.episode_number}</Text>
              <View style={{ flex: 1 }}>
                <Text style={m.rowText} numberOfLines={1}>{name && !/^Episode \d+$/.test(name) ? name : `Episode ${ep.episode_number}`}</Text>
                {playing && <Text style={m.playing}>Playing now</Text>}
              </View>
              {!playing && <MaterialIcons name="play-circle-outline" size={26} color={C.dust} />}
            </Pressable>
          );
        })}
        {!anime && !current && <Text style={m.empty}>No episode list for this title.</Text>}
      </ScrollView>
    </Shell>
  );
}

const m = StyleSheet.create({
  shade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  panel: { width: '60%', maxWidth: 560, maxHeight: '92%', backgroundColor: 'rgba(24,30,46,0.97)', borderRadius: 14, padding: 20 },
  panelWide: { width: '82%', maxWidth: 820 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { color: C.screen, fontFamily: F.bold, fontSize: 20 },
  columns: { flexDirection: 'row', gap: 24, flexShrink: 1 },
  column: { flex: 1 },
  columnTitle: { color: C.dust, fontFamily: F.semibold, fontSize: 13, letterSpacing: 0.5, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 11 },
  check: { width: 22, alignItems: 'center' },
  rowText: { color: C.dust, fontFamily: F.semibold, fontSize: 16 },
  rowActive: { color: C.screen },
  empty: { color: C.dust, fontFamily: F.text, fontSize: 14, paddingVertical: 10 },
  note: { color: C.dust, fontFamily: F.text, fontSize: 13, marginTop: 14 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  pill: { paddingHorizontal: 16, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(242,240,234,0.3)' },
  pillActive: { backgroundColor: C.screen, borderColor: C.screen },
  pillText: { color: C.screen, fontFamily: F.semibold, fontSize: 15 },
  pillTextActive: { color: C.night },
  episode: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 10, borderRadius: 10 },
  episodeActive: { backgroundColor: 'rgba(242,179,61,0.14)' },
  episodeNumber: { color: C.dust, fontFamily: F.bold, fontSize: 20, width: 34, textAlign: 'center' },
  playing: { color: C.marigold, fontFamily: F.medium, fontSize: 12, marginTop: 2 },
});
