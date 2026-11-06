// Home screen data: one call to /api/home, kept on the phone. The saved copy
// shows at once when the app opens, then a fresh copy is fetched in the
// background (stale-while-revalidate). The saved copy has a format version and
// is ignored after MAX_AGE_MS.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { getJSON, posterUrl, type Title } from './api';

export type HomeRow = { id: string; title: string; kind: 'top' | 'poster'; more: Record<string, string> | null; items: Title[] };
export type HomeData = { version: number; generatedAt: string; hero: Title[]; rows: HomeRow[] };

const KEY = 'cutcrew-home';
const CACHE_VERSION = 1;
const MAX_AGE_MS = 3 * 24 * 3600000; // a saved copy older than this is not shown
const FRESH_MS = 2 * 60000;          // a copy younger than this is not refetched

type Saved = { cacheVersion: number; savedAt: number; data: HomeData };

async function readSaved(): Promise<Saved | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Saved) : null;
    if (!saved || saved.cacheVersion !== CACHE_VERSION || !saved.data?.rows || Date.now() - saved.savedAt > MAX_AGE_MS) return null;
    return saved;
  } catch { return null; }
}

// Posters of the first rows and the hero artwork, fetched before they scroll in.
function prefetch(data: HomeData) {
  const urls = data.rows.slice(0, 2).flatMap(row => row.items.slice(0, 8).map(item => posterUrl(item))).filter(Boolean);
  Image.prefetch(urls, 'memory-disk').catch(() => {});
}

export function useHome() {
  const [state, setState] = useState<{ data: HomeData | null; error: string; refreshing: boolean }>({ data: null, error: '', refreshing: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => {
      const saved = await readSaved();
      if (live && saved) setState(s => ({ ...s, data: saved.data }));
      if (saved && attempt === 0 && Date.now() - saved.savedAt < FRESH_MS) { if (live) setState(s => ({ ...s, refreshing: false })); return; }
      try {
        const data = await getJSON<HomeData>('/api/home', { timeout: 45000, fresh: true });
        if (!live) return;
        setState({ data, error: '', refreshing: false });
        prefetch(data);
        AsyncStorage.setItem(KEY, JSON.stringify({ cacheVersion: CACHE_VERSION, savedAt: Date.now(), data } satisfies Saved)).catch(() => {});
      } catch (error: any) {
        if (live) setState(s => ({ ...s, error: s.data ? '' : error.message, refreshing: false }));
      }
    })();
    return () => { live = false; };
  }, [attempt]);
  return { ...state, retry: useCallback(() => setAttempt(n => n + 1), []) };
}
