import { useCallback, useEffect, useState } from 'react';
import { getJSON, peekJSON } from './api';

// Loads a path (cached), with loading/error state and a retry. The answer is
// tagged with the request it belongs to, so "loading" is derived, not set.
export function useFetch<T = any>(path: string | null, { timeout = 30000 } = {}) {
  const [attempt, setAttempt] = useState(0);
  const key = path ? `${path}#${attempt}` : null;
  const [result, setResult] = useState<{ key: string | null; data: T | null; error: string }>({ key: null, data: null, error: '' });
  useEffect(() => {
    if (!path || !key) return;
    let live = true;
    getJSON<T>(path, { timeout, fresh: attempt > 0 })
      .then(data => { if (live) setResult({ key, data, error: '' }); })
      .catch((error: Error) => { if (live) setResult({ key, data: null, error: error.message }); });
    return () => { live = false; };
  }, [key, path, attempt, timeout]);
  const current = key !== null && result.key === key;
  const cached = path ? peekJSON<T>(path) : undefined;
  return {
    data: (current ? result.data : null) ?? cached ?? null,
    error: current ? result.error : '',
    loading: Boolean(path) && !current && (cached === undefined || attempt > 0),
    retry: useCallback(() => setAttempt(n => n + 1), []),
  };
}
