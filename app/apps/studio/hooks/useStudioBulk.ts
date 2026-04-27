'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioBulkJob, StudioBulkCreatePayload } from '../types/bulk';

const POLL_INTERVAL_MS = 10_000;

interface UseStudioBulkReturn {
  jobs: StudioBulkJob[];
  activeJob: StudioBulkJob | null;
  loading: boolean;
  error: string | null;
  isPolling: boolean;
  fetchJobs: () => Promise<void>;
  fetchJob: (id: string, options?: { silent?: boolean }) => Promise<StudioBulkJob | null>;
  createJob: (payload: StudioBulkCreatePayload) => Promise<StudioBulkJob | null>;
  cancelJob: (id: string) => Promise<boolean>;
  deleteJob: (id: string) => Promise<boolean>;
  stopPolling: () => void;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function parseJsonResponse(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
    throw new Error(`Server error: ${response.status}. Bitte versuche es erneut.`);
  }
  const data = await response.json();
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || `Request failed with ${response.status}`);
  }
  return data;
}

export function useStudioBulk(): UseStudioBulkReturn {
  const [jobs, setJobs] = useState<StudioBulkJob[]>([]);
  const [activeJob, setActiveJob] = useState<StudioBulkJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollingJobId, setPollingJobId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setPollingJobId(null);
  }, []);

  const fetchJob = useCallback(async (id: string, options?: { silent?: boolean }): Promise<StudioBulkJob | null> => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);

    try {
      const response = await fetch(`/api/studio/bulk/${id}`);
      const data = await parseJsonResponse(response);
      const job = (data.job ?? null) as StudioBulkJob | null;

      if (job) {
        setActiveJob(job);
        setJobs((current) => {
          const without = current.filter((j) => j.id !== job.id);
          return [job, ...without];
        });

        if (job.status === 'completed' || job.status === 'partial' || job.status === 'failed') {
          stopPolling();
        }
      }

      return job;
    } catch (err) {
      const message = toErrorMessage(err, 'Failed to fetch bulk job');
      setError(message);
      if (options?.silent) {
        stopPolling();
      }
      return null;
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [stopPolling]);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/studio/bulk');
      const data = await parseJsonResponse(response);
      const nextJobs = (data.jobs ?? []) as StudioBulkJob[];
      setJobs(nextJobs);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to list bulk jobs'));
    } finally {
      setLoading(false);
    }
  }, []);

  const createJob = useCallback(async (payload: StudioBulkCreatePayload): Promise<StudioBulkJob | null> => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/studio/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await parseJsonResponse(response);
      const job = data.job as StudioBulkJob;

      setActiveJob(job);
      setJobs((current) => [job, ...current]);
      setPollingJobId(job.id);

      return job;
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to create bulk job'));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const cancelJob = useCallback(async (id: string): Promise<boolean> => {
    setError(null);
    try {
      const response = await fetch(`/api/studio/bulk/${id}/cancel`, { method: 'POST' });
      await parseJsonResponse(response);
      await fetchJob(id);
      return true;
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to cancel bulk job'));
      return false;
    }
  }, [fetchJob]);

  const deleteJob = useCallback(async (id: string): Promise<boolean> => {
    setError(null);
    try {
      const response = await fetch(`/api/studio/bulk/${id}`, { method: 'DELETE' });
      await parseJsonResponse(response);
      setJobs((current) => current.filter((j) => j.id !== id));
      setActiveJob((current) => (current?.id === id ? null : current));
      if (pollingJobId === id) {
        stopPolling();
      }
      return true;
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to delete bulk job'));
      return false;
    }
  }, [pollingJobId, stopPolling]);

  useEffect(() => {
    if (!pollingJobId) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    void fetchJob(pollingJobId, { silent: true });

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    intervalRef.current = setInterval(() => {
      void fetchJob(pollingJobId, { silent: true });
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [pollingJobId, fetchJob]);

  useEffect(() => () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
  }, []);

  return {
    jobs,
    activeJob,
    loading,
    error,
    isPolling: pollingJobId !== null,
    fetchJobs,
    fetchJob,
    createJob,
    cancelJob,
    deleteJob,
    stopPolling,
  };
}