// The timeline: played and buffered parts, a thumb you can drag, and the
// time under your finger while you drag. Seeks once, when you let go.
import { useEffect, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { C, F } from '../../lib/theme';
import { clock } from './time';

type Props = {
  position: number;
  duration: number;
  buffered: number;
  onScrub: (active: boolean) => void;
  onSeek: (seconds: number) => void;
};

export function SeekBar({ position, duration, buffered, onScrub, onSeek }: Props) {
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  // The responder is made once; it reads the latest values from here.
  const live = useRef({ width: 0, duration: 0, onScrub, onSeek });
  useEffect(() => { live.current = { width, duration, onScrub, onSeek }; });
  const at = (x: number) => {
    const { width: w, duration: d } = live.current;
    return w > 0 && d > 0 ? Math.max(0, Math.min(1, x / w)) * d : 0;
  };
  // The handlers read the ref only when a touch happens, never while rendering.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => PanResponder.create({
    onStartShouldSetPanResponder: () => live.current.duration > 0,
    onMoveShouldSetPanResponder: () => live.current.duration > 0,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: e => { live.current.onScrub(true); setDrag(at(e.nativeEvent.locationX)); },
    onPanResponderMove: e => setDrag(at(e.nativeEvent.locationX)),
    onPanResponderRelease: e => {
      const target = at(e.nativeEvent.locationX);
      setDrag(null);
      live.current.onSeek(target);
      live.current.onScrub(false);
    },
    onPanResponderTerminate: () => { setDrag(null); live.current.onScrub(false); },
  }));

  const shown = drag ?? position;
  const part = (value: number) => `${duration > 0 ? Math.max(0, Math.min(100, (value / duration) * 100)) : 0}%` as `${number}%`;
  return (
    <View style={b.wrap} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)} {...responder.panHandlers}
      accessibilityRole="adjustable" accessibilityLabel="Timeline" accessibilityValue={{ text: `${clock(shown)} of ${clock(duration)}` }}>
      {drag !== null && (
        <View style={[b.bubble, { left: Math.max(0, Math.min(width - 72, (duration > 0 ? (drag / duration) * width : 0) - 36)) }]} pointerEvents="none">
          <Text style={b.bubbleText}>{clock(drag)}</Text>
        </View>
      )}
      <View style={[b.track, drag !== null && b.trackActive]} pointerEvents="none">
        <View style={[b.buffered, { width: part(buffered) }]} />
        <View style={[b.played, { width: part(shown) }]} />
      </View>
      <View style={[b.thumb, drag !== null && b.thumbActive, { left: part(shown) }]} pointerEvents="none" />
    </View>
  );
}

const b = StyleSheet.create({
  // A tall touch area around a thin line, so it is easy to grab.
  wrap: { height: 36, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: 'rgba(242,240,234,0.25)', overflow: 'hidden' },
  trackActive: { height: 6, borderRadius: 3 },
  buffered: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: 'rgba(242,240,234,0.45)' },
  played: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: C.marigold },
  thumb: { position: 'absolute', width: 16, height: 16, marginLeft: -8, borderRadius: 8, backgroundColor: C.marigold },
  thumbActive: { width: 22, height: 22, marginLeft: -11, borderRadius: 11 },
  bubble: { position: 'absolute', bottom: 34, width: 72, alignItems: 'center', paddingVertical: 4, borderRadius: 6, backgroundColor: 'rgba(15,19,32,0.92)' },
  bubbleText: { color: C.screen, fontFamily: F.bold, fontSize: 14 },
});
