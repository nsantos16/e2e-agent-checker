import { useEffect, useState } from 'react';
import type { Api } from './api.ts';
import { errorMessage } from './api.ts';
import type { Network, Observation } from './types.ts';
export function useObservation(api: Api, id: string, active: boolean, errorsOnly: boolean, limit: number) {
  const [data, setData] = useState<Observation | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let pending: Promise<void> | null = null;
    const refresh = () => {
      if (pending) return pending;
      setLoading(true);
      pending = (async () => {
        try {
          const [observation, network] = await Promise.all([
            api<Observation>(`/api/jobs/${id}/observation?errorsOnly=${errorsOnly ? '1' : '0'}`, undefined, controller.signal),
            limit > 100
              ? api<Network>(`/api/jobs/${id}/network?errorsOnly=${errorsOnly ? '1' : '0'}&limit=${limit}`, undefined, controller.signal)
              : undefined,
          ]);
          if (!controller.signal.aborted) {
            setData(network ? { ...observation, network } : observation);
            setError('');
          }
        } catch (error) {
          if (!controller.signal.aborted) setError('Diagnostics could not refresh. ' + errorMessage(error));
        } finally {
          pending = null;
          if (!controller.signal.aborted) setLoading(false);
        }
      })();
      return pending;
    };
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, id, active, errorsOnly, limit]);
  return { data, error, loading };
}
