'use client';

import { useEffect, useState } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

type VersionUpdateIndicatorProps = {
  currentVersion: string;
  repositoryUrl: string;
};

function parseVersion(version: string): number[] {
  const cleaned = version.replace(/^v/, '').trim();
  const parts = cleaned.split('.').map((p) => parseInt(p, 10) || 0);
  while (parts.length < 4) parts.push(0);
  return parts;
}

function isNewerVersion(current: string, latest: string): boolean {
  const currentParts = parseVersion(current);
  const latestParts = parseVersion(latest);
  const len = Math.max(currentParts.length, latestParts.length);

  for (let i = 0; i < len; i++) {
    const c = currentParts[i] ?? 0;
    const l = latestParts[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

const CACHE_KEY = 'version-check-cache';
const CACHE_DURATION = 3600000;

function normalizeVersion(version: string): string {
  return version.replace(/^v/, '').trim();
}

function computeHasUpdate(currentVersion: string, latestTag: string): boolean {
  const latest = normalizeVersion(latestTag);
  const current = normalizeVersion(currentVersion);
  if (!latest || latest === current) return false;
  return isNewerVersion(currentVersion, latestTag);
}

export function VersionUpdateIndicator({ currentVersion, repositoryUrl }: VersionUpdateIndicatorProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkVersion = async () => {
      try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const { timestamp, latest } = JSON.parse(cached) as { timestamp: number; latest: string; hasUpdate?: boolean };
          if (Date.now() - timestamp < CACHE_DURATION) {
            const hasUpdate = computeHasUpdate(currentVersion, latest);
            setLatestVersion(latest);
            setUpdateAvailable(hasUpdate);
            setIsLoading(false);
            return;
          }
        }

        const response = await fetch('https://api.github.com/repos/canvascoding/canvas-notebook/releases/latest');
        if (!response.ok) {
          setIsLoading(false);
          return;
        }

        const data = await response.json();
        const latestTag = data.tag_name as string;

        if (latestTag) {
          const hasUpdate = computeHasUpdate(currentVersion, latestTag);
          setLatestVersion(latestTag);
          setUpdateAvailable(hasUpdate);

          localStorage.setItem(CACHE_KEY, JSON.stringify({
            timestamp: Date.now(),
            latest: latestTag,
            hasUpdate,
          }));
        }
      } catch {
      } finally {
        setIsLoading(false);
      }
    };

    checkVersion();
  }, [currentVersion]);

  if (isLoading || !updateAvailable) {
    return null;
  }

  const releaseUrl = `${repositoryUrl}/releases/tag/${latestVersion}`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center transition-colors hover:text-foreground"
            aria-label="Neue Version verfügbar"
          >
            <ArrowUpCircle className="h-3 w-3 shrink-0 text-orange-500" />
          </a>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-[10px]">
          <p>Update verfügbar: {latestVersion}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
