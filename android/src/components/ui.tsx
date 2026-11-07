// Shared building blocks. Every pressable shows a clear focus ring so the app
// works with a TV remote (D-pad) as well as touch.
import { Image } from 'expo-image';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { C, F, R } from '../lib/theme';

// Layout sizes for phone, tablet and TV from the window width.
export function useSizes() {
  const { width, height } = useWindowDimensions();
  const tv = width >= 1100 && width > height;
  const tablet = !tv && Math.min(width, height) >= 600;
  const gutter = tv ? 48 : tablet ? 28 : 16;
  const poster = tv ? 168 : tablet ? 150 : 112;
  return { width, height, tv, tablet, gutter, poster, wide: Math.round(poster * 1.9) };
}

export function Focusable({ style, focusStyle, children, ...props }: PressableProps & { style?: StyleProp<ViewStyle>; focusStyle?: StyleProp<ViewStyle>; children: ReactNode }) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      {...props}
      onFocus={e => { setFocused(true); props.onFocus?.(e); }}
      onBlur={e => { setFocused(false); props.onBlur?.(e); }}
      style={({ pressed }) => [style, focused && (focusStyle || s.focus), pressed && { opacity: 0.85 }]}
    >
      {children}
    </Pressable>
  );
}

// Artwork with a calm placeholder; falls back to the title text.
export function Art({ uri, label, style, radius = R.card }: { uri?: string; label?: string; style?: StyleProp<ViewStyle>; radius?: number }) {
  const [failed, setFailed] = useState(!uri);
  return (
    <View style={[{ backgroundColor: C.velvet, borderRadius: radius, overflow: 'hidden' }, style]}>
      {!failed && <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" transition={250} cachePolicy="memory-disk" onError={() => setFailed(true)} />}
      {failed && !!label && <View style={s.fallback}><Text style={s.fallbackText} numberOfLines={3}>{label}</Text></View>}
    </View>
  );
}

export function Button({ label, onPress, kind = 'play', icon, style, preferFocus }: { label: string; onPress: () => void; kind?: 'play' | 'quiet'; icon?: string; style?: StyleProp<ViewStyle>; preferFocus?: boolean }) {
  const play = kind === 'play';
  return (
    <Focusable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hasTVPreferredFocus={preferFocus}
      style={[s.button, { backgroundColor: play ? C.marigold : 'rgba(242,240,234,0.14)' }, style]} focusStyle={s.buttonFocus}>
      {!!icon && <Text style={[s.buttonIcon, { color: play ? C.marigoldInk : C.screen }]}>{icon}</Text>}
      <Text style={[s.buttonText, { color: play ? C.marigoldInk : C.screen }]}>{label}</Text>
    </Focusable>
  );
}

export function RoundButton({ label, icon, onPress, active }: { label: string; icon: string; onPress: () => void; active?: boolean }) {
  return (
    <Focusable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }}
      style={[s.round, active && { backgroundColor: 'rgba(242,240,234,0.16)', borderColor: C.screen }]} focusStyle={s.buttonFocus}>
      <Text style={s.roundIcon}>{icon}</Text>
    </Focusable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Focusable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }}
      style={[s.chip, active && { backgroundColor: C.screen, borderColor: C.screen }]} focusStyle={s.chipFocus}>
      <Text style={[s.chipText, active && { color: C.night }]}>{label}</Text>
    </Focusable>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <View style={s.center}><ActivityIndicator color={C.marigold} size="large" /><Text style={s.muted}>{label}</Text></View>;
}

export function Notice({ title, body, action, onAction }: { title: string; body?: string; action?: string; onAction?: () => void }) {
  return (
    <View style={s.notice}>
      <Text style={s.noticeTitle}>{title}</Text>
      {!!body && <Text style={s.muted}>{body}</Text>}
      {!!action && !!onAction && <Button label={action} onPress={onAction} kind="quiet" style={{ marginTop: 16, alignSelf: 'flex-start' }} />}
    </View>
  );
}

export const s = StyleSheet.create({
  focus: { borderWidth: 3, borderColor: C.screen, borderRadius: R.card + 3, transform: [{ scale: 1.04 }] },
  fallback: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 10, backgroundColor: C.raised },
  fallbackText: { color: C.dust, fontFamily: F.displayBold, fontSize: 15, textAlign: 'center' },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48, paddingHorizontal: 22, borderRadius: R.control },
  buttonFocus: { borderWidth: 3, borderColor: C.screen, transform: [{ scale: 1.05 }] },
  buttonIcon: { fontSize: 16, fontFamily: F.bold },
  buttonText: { fontSize: 16, fontFamily: F.bold },
  round: { width: 48, height: 48, borderRadius: 24, borderWidth: 1.5, borderColor: 'rgba(242,240,234,0.55)', alignItems: 'center', justifyContent: 'center' },
  roundIcon: { color: C.screen, fontSize: 22, fontFamily: F.bold, marginTop: -2 },
  chip: { minHeight: 44, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, borderColor: C.line, backgroundColor: C.velvet, justifyContent: 'center' },
  chipFocus: { borderColor: C.marigold, borderWidth: 2 },
  chipText: { color: C.screen, fontFamily: F.semibold, fontSize: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, minHeight: 240 },
  muted: { color: C.dust, fontFamily: F.text, fontSize: 14, lineHeight: 20 },
  notice: { padding: 24, gap: 6 },
  noticeTitle: { color: C.screen, fontFamily: F.bold, fontSize: 20 },
});
