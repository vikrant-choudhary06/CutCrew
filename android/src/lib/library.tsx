// My List and Continue watching, kept on the device (AsyncStorage).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { summary, type Title } from './api';

export type Progress = { data: Title; season: number; episode: number; position: number; duration: number | null; completed: boolean; updated_at: string };
type Library = {
  ready: boolean;
  watchlist: Title[];
  progress: Progress[];
  isSaved: (id: string) => boolean;
  toggleWatchlist: (t: Title) => void;
  saveProgress: (p: Omit<Progress, 'updated_at'>) => void;
  removeProgress: (id: string) => void;
  resumeFor: (id: string) => Progress | undefined;
  continueWatching: Progress[];
};

const KEY = 'cutcrew-library-v1';
const Ctx = createContext<Library | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ ready: boolean; watchlist: Title[]; progress: Progress[] }>({ ready: false, watchlist: [], progress: [] });

  useEffect(() => {
    AsyncStorage.getItem(KEY).then(raw => {
      const saved = raw ? JSON.parse(raw) : {};
      setState({ ready: true, watchlist: Array.isArray(saved.watchlist) ? saved.watchlist : [], progress: Array.isArray(saved.progress) ? saved.progress : [] });
    }).catch(() => setState(s => ({ ...s, ready: true })));
  }, []);

  const persist = useCallback((next: { watchlist: Title[]; progress: Progress[] }) => {
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => { /* storage full or unavailable: keep in memory */ });
  }, []);

  const update = useCallback((change: (s: { watchlist: Title[]; progress: Progress[] }) => { watchlist: Title[]; progress: Progress[] }) => {
    setState(s => {
      const next = change({ watchlist: s.watchlist, progress: s.progress });
      persist(next);
      return { ready: s.ready, ...next };
    });
  }, [persist]);

  const value = useMemo<Library>(() => {
    const sameItem = (a: Progress, b: { data: Title; season: number; episode: number }) => a.data.imdb_id === b.data.imdb_id && a.season === b.season && a.episode === b.episode;
    return {
      ready: state.ready,
      watchlist: state.watchlist,
      progress: state.progress,
      isSaved: id => state.watchlist.some(x => x.imdb_id === id),
      toggleWatchlist: t => update(s => ({ ...s, watchlist: s.watchlist.some(x => x.imdb_id === t.imdb_id) ? s.watchlist.filter(x => x.imdb_id !== t.imdb_id) : [summary(t), ...s.watchlist].slice(0, 500) })),
      saveProgress: p => update(s => ({ ...s, progress: [{ ...p, data: summary(p.data), updated_at: new Date().toISOString() }, ...s.progress.filter(x => !sameItem(x, p))].slice(0, 300) })),
      removeProgress: id => update(s => ({ ...s, progress: s.progress.filter(x => x.data.imdb_id !== id) })),
      resumeFor: id => state.progress.filter(x => x.data.imdb_id === id && !x.completed && x.position > 10)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0],
      // Latest unfinished entry per title.
      continueWatching: (() => {
        const seen = new Set<string>();
        return [...state.progress].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
          .filter(p => !p.completed && p.position > 30 && !seen.has(p.data.imdb_id) && (seen.add(p.data.imdb_id), true)).slice(0, 20);
      })(),
    };
  }, [state, update]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibrary() {
  const value = useContext(Ctx);
  if (!value) throw new Error('useLibrary must be used inside LibraryProvider');
  return value;
}
