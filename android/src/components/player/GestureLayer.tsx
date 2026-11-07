// Touch layer under the controls:
// - one tap shows or hides the controls;
// - double tap on the left/right third goes back/forward 10 s (keep tapping for more);
// - swipe up/down on the left half sets brightness, on the right half volume;
// - pinch out fills the screen, pinch in fits the whole picture.
// Shows what changed (a "10 s" ripple or a level bar) and gives a light vibration.
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Brightness from 'expo-brightness';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { VolumeManager } from 'react-native-volume-manager';
import { C, F } from '../../lib/theme';

type Side = 'left' | 'center' | 'right';
type Props = {
  width: number;
  height: number;
  locked: boolean;
  onTap: () => void;
  onSeekBy: (seconds: number) => void;
  onFit: (fill: boolean) => void;
};

const DOUBLE_TAP_MS = 280;
const STEP = 10;
const light = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

export function GestureLayer({ width, height, locked, onTap, onSeekBy, onFit }: Props) {
  const [ripple, setRipple] = useState<{ side: Side; amount: number; key: number } | null>(null);
  const [level, setLevel] = useState<{ kind: 'brightness' | 'volume'; value: number } | null>(null);
  const live = useRef({ width, height, locked, onTap, onSeekBy, onFit });
  useEffect(() => { live.current = { width, height, locked, onTap, onSeekBy, onFit }; });
  // Touch bookkeeping kept outside React state: it changes on every move.
  const touch = useRef({
    x: 0, y: 0, at: 0, mode: 'none' as 'none' | 'brightness' | 'volume' | 'pinch',
    start: 0, pinchFrom: 0, pinchDone: false, lastSet: 0, edge: false,
    lastTap: { side: 'center' as Side, at: 0 }, streak: { side: 'center' as Side, at: 0, amount: 0 },
    tapTimer: null as ReturnType<typeof setTimeout> | null,
    brightness: 0.5, volume: 0.5,
  });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Current brightness and volume, so a swipe starts from where they are.
  useEffect(() => {
    Brightness.getBrightnessAsync().then(v => { touch.current.brightness = v; }).catch(() => {});
    VolumeManager.getVolume().then(r => { touch.current.volume = r.volume; }).catch(() => {});
    const sub = VolumeManager.addVolumeListener(r => { touch.current.volume = r.volume; });
    const t = touch.current;
    return () => { sub.remove(); if (t.tapTimer) clearTimeout(t.tapTimer); if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, []);

  const fadeSoon = (ms = 700) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { setRipple(null); setLevel(null); }, ms);
  };
  const sideOf = (x: number): Side => (x < live.current.width * 0.38 ? 'left' : x > live.current.width * 0.62 ? 'right' : 'center');
  const distance = (e: GestureResponderEvent) => {
    const [a, b] = e.nativeEvent.touches;
    return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
  };

  function seek(side: Side) {
    const t = touch.current, now = Date.now();
    const amount = t.streak.side === side && now - t.streak.at < 800 ? t.streak.amount + STEP : STEP;
    t.streak = { side, at: now, amount };
    live.current.onSeekBy(side === 'left' ? -STEP : STEP);
    setRipple({ side, amount, key: now });
    light();
    fadeSoon(650);
  }
  function tap(x: number) {
    const t = touch.current, now = Date.now(), side = sideOf(x);
    if (live.current.locked) { live.current.onTap(); return; }
    // Taps after a double tap keep seeking the same way.
    const keepGoing = side !== 'center' && t.streak.side === side && now - t.streak.at < 800;
    const second = side !== 'center' && t.lastTap.side === side && now - t.lastTap.at < DOUBLE_TAP_MS;
    if (keepGoing || second) {
      if (t.tapTimer) { clearTimeout(t.tapTimer); t.tapTimer = null; }
      t.lastTap = { side: 'center', at: 0 };
      seek(side);
      return;
    }
    t.lastTap = { side, at: now };
    if (side === 'center') { live.current.onTap(); return; }
    // Wait a moment: this may be the first tap of a double tap.
    if (t.tapTimer) clearTimeout(t.tapTimer);
    t.tapTimer = setTimeout(() => { t.tapTimer = null; live.current.onTap(); }, DOUBLE_TAP_MS);
  }
  function setValue(kind: 'brightness' | 'volume', value: number) {
    const t = touch.current, v = Math.max(0, Math.min(1, value));
    const atEdge = v === 0 || v === 1;
    if (atEdge && !t.edge) Haptics.selectionAsync().catch(() => {});
    t.edge = atEdge;
    setLevel({ kind, value: v });
    const now = Date.now();
    if (now - t.lastSet < 40 && !atEdge) return;
    t.lastSet = now;
    if (kind === 'brightness') { t.brightness = v; Brightness.setBrightnessAsync(v).catch(() => {}); }
    else { t.volume = v; VolumeManager.setVolume(v, { showUI: false }).catch(() => {}); }
  }

  // The handlers read the refs only when a touch happens, never while rendering.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: e => {
      const t = touch.current;
      t.x = e.nativeEvent.locationX; t.y = e.nativeEvent.locationY; t.at = Date.now();
      t.mode = 'none'; t.pinchDone = false; t.pinchFrom = 0; t.edge = false;
    },
    onPanResponderMove: (e, g) => {
      const t = touch.current;
      if (live.current.locked) return;
      if (e.nativeEvent.touches.length >= 2) {
        const d = distance(e);
        if (t.mode !== 'pinch') { t.mode = 'pinch'; t.pinchFrom = d; return; }
        if (!t.pinchDone && t.pinchFrom > 0 && (d / t.pinchFrom > 1.18 || d / t.pinchFrom < 0.85)) {
          t.pinchDone = true;
          live.current.onFit(d > t.pinchFrom);
          light();
        }
        return;
      }
      if (t.mode === 'none' && Math.abs(g.dy) > 14 && Math.abs(g.dy) > Math.abs(g.dx) * 1.2) {
        t.mode = t.x < live.current.width / 2 ? 'brightness' : 'volume';
        t.start = t.mode === 'brightness' ? t.brightness : t.volume;
        if (hideTimer.current) clearTimeout(hideTimer.current);
      }
      if (t.mode === 'brightness' || t.mode === 'volume') {
        // A swipe across most of the screen height covers the whole range.
        setValue(t.mode, t.start - g.dy / (live.current.height * 0.75));
      }
    },
    onPanResponderRelease: (_e, g) => {
      const t = touch.current;
      if (t.mode === 'brightness' || t.mode === 'volume') { fadeSoon(700); return; }
      if (t.mode === 'pinch') return;
      if (Math.abs(g.dx) < 12 && Math.abs(g.dy) < 12 && Date.now() - t.at < 350) tap(t.x);
    },
    onPanResponderTerminate: () => { if (touch.current.mode !== 'none') fadeSoon(700); },
  }));

  return (
    <View style={StyleSheet.absoluteFill} {...responder.panHandlers}>
      {ripple && (
        <View key={ripple.key} pointerEvents="none" style={[g.ripple, ripple.side === 'left' ? g.rippleLeft : g.rippleRight, { height }]}>
          <MaterialIcons name={ripple.side === 'left' ? 'replay-10' : 'forward-10'} size={40} color={C.screen} />
          <Text style={g.rippleText}>{ripple.amount} seconds</Text>
        </View>
      )}
      {level && (
        <View pointerEvents="none" style={[g.level, level.kind === 'brightness' ? { left: 28 } : { right: 28 }]}>
          <MaterialIcons name={level.kind === 'brightness' ? 'brightness-6' : level.value === 0 ? 'volume-off' : 'volume-up'} size={22} color={C.screen} />
          <View style={g.levelTrack}><View style={[g.levelFill, { height: `${Math.round(level.value * 100)}%` }]} /></View>
          <Text style={g.levelText}>{Math.round(level.value * 100)}</Text>
        </View>
      )}
    </View>
  );
}

const g = StyleSheet.create({
  ripple: { position: 'absolute', top: 0, width: '38%', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(242,240,234,0.10)' },
  rippleLeft: { left: 0, borderTopRightRadius: 9999, borderBottomRightRadius: 9999 },
  rippleRight: { right: 0, borderTopLeftRadius: 9999, borderBottomLeftRadius: 9999 },
  rippleText: { color: C.screen, fontFamily: F.semibold, fontSize: 14 },
  level: { position: 'absolute', top: '22%', bottom: '22%', width: 48, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 14, borderRadius: 24, backgroundColor: 'rgba(15,19,32,0.82)' },
  levelTrack: { flex: 1, width: 6, borderRadius: 3, backgroundColor: 'rgba(242,240,234,0.25)', justifyContent: 'flex-end', overflow: 'hidden' },
  levelFill: { width: '100%', backgroundColor: C.marigold },
  levelText: { color: C.screen, fontFamily: F.semibold, fontSize: 12 },
});
