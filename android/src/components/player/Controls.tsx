// The player's controls, Netflix style: title at the top, big play/pause and
// 10-second jumps in the middle, the timeline and a row of actions at the bottom.
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { C, F } from '../../lib/theme';
import { SeekBar } from './SeekBar';
import { clock } from './time';

type Icon = ComponentProps<typeof MaterialIcons>['name'];
type Props = {
  title: string;
  subtitle: string;
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  buffered: number;
  speed: number;
  canPip: boolean;
  hasEpisodes: boolean;
  hasNext: boolean;
  hasAudioMenu: boolean;
  onBack: () => void;
  onPlayPause: () => void;
  onSeekBy: (seconds: number) => void;
  onSeek: (seconds: number) => void;
  onScrub: (active: boolean) => void;
  onPip: () => void;
  onLock: () => void;
  onMenu: (menu: 'audio' | 'speed' | 'episodes') => void;
  onNext: () => void;
};

function Action({ icon, label, onPress }: { icon: Icon; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [c.action, pressed && c.pressed]} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}>
      <MaterialIcons name={icon} size={22} color={C.screen} />
      <Text style={c.actionText}>{label}</Text>
    </Pressable>
  );
}

function Round({ icon, size, label, onPress, big }: { icon: Icon; size: number; label: string; onPress: () => void; big?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [big ? c.bigButton : c.roundButton, pressed && c.pressed]} accessibilityRole="button" accessibilityLabel={label} hitSlop={10}>
      <MaterialIcons name={icon} size={size} color={C.screen} />
    </Pressable>
  );
}

export function Controls(p: Props) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <LinearGradient colors={['rgba(0,0,0,0.75)', 'transparent']} style={c.topShade} pointerEvents="none" />
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.85)']} style={c.bottomShade} pointerEvents="none" />

      <View style={c.top} pointerEvents="box-none">
        <Round icon="arrow-back" size={28} label="Back" onPress={p.onBack} />
        <View style={c.heading} pointerEvents="none">
          <Text style={c.title} numberOfLines={1}>{p.title}</Text>
          {!!p.subtitle && <Text style={c.subtitle} numberOfLines={1}>{p.subtitle}</Text>}
        </View>
        {p.canPip ? <Round icon="picture-in-picture-alt" size={24} label="Picture in picture" onPress={p.onPip} /> : <View style={{ width: 48 }} />}
      </View>

      <View style={c.middle} pointerEvents="box-none">
        <Round icon="replay-10" size={42} label="Back 10 seconds" onPress={() => p.onSeekBy(-10)} />
        {p.buffering
          ? <View style={c.bigButton}><ActivityIndicator size="large" color={C.screen} /></View>
          : <Round icon={p.playing ? 'pause' : 'play-arrow'} size={58} big label={p.playing ? 'Pause' : 'Play'} onPress={p.onPlayPause} />}
        <Round icon="forward-10" size={42} label="Forward 10 seconds" onPress={() => p.onSeekBy(10)} />
      </View>

      <View style={c.bottom} pointerEvents="box-none">
        <View style={c.timeline}>
          <View style={{ flex: 1 }}>
            <SeekBar position={p.position} duration={p.duration} buffered={p.buffered} onSeek={p.onSeek} onScrub={p.onScrub} />
          </View>
          <Text style={c.time}>{p.duration > 0 ? `-${clock(Math.max(0, p.duration - p.position))}` : clock(p.position)}</Text>
        </View>
        <View style={c.actions}>
          <Action icon="speed" label={`Speed (${p.speed}x)`} onPress={() => p.onMenu('speed')} />
          <Action icon="lock-outline" label="Lock" onPress={p.onLock} />
          {p.hasEpisodes && <Action icon="video-library" label="Episodes" onPress={() => p.onMenu('episodes')} />}
          <Action icon="subtitles" label={p.hasAudioMenu ? 'Audio & Subtitles' : 'Subtitles'} onPress={() => p.onMenu('audio')} />
          {p.hasNext && <Action icon="skip-next" label="Next Ep." onPress={p.onNext} />}
        </View>
      </View>
    </View>
  );
}

const c = StyleSheet.create({
  topShade: { position: 'absolute', top: 0, left: 0, right: 0, height: 120 },
  bottomShade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 170 },
  top: { position: 'absolute', top: 10, left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 8 },
  heading: { flex: 1, alignItems: 'center' },
  title: { color: C.screen, fontFamily: F.bold, fontSize: 17 },
  subtitle: { color: 'rgba(242,240,234,0.75)', fontFamily: F.medium, fontSize: 13, marginTop: 1 },
  middle: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 64 },
  roundButton: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  bigButton: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  bottom: { position: 'absolute', left: 24, right: 24, bottom: 10 },
  timeline: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  time: { color: C.screen, fontFamily: F.semibold, fontSize: 14, minWidth: 64, textAlign: 'right' },
  actions: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 34, marginTop: 2 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  actionText: { color: C.screen, fontFamily: F.semibold, fontSize: 14 },
});
