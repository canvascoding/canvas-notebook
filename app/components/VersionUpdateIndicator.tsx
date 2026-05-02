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
  const cleaned = version.replace(/^v/, '');
  const parts = cleaned.split('.').map((p) => parseInt(p, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function isNewerVersion(current: string, latest: string): boolean {
  const currentParts = parseVersion(current);
  const latestParts = parseVersion(latest);
  
  for (let i = 0; i < 3; i++) {
    if (latestParts[i] > currentParts[i]) return true;
    if (latestParts[i] < currentParts[i]) return false;
  }
  return false;
}

const CACHE_KEY = 'version-check-cache';
const CACHE_DURATION = 3600000;

export function VersionUpdateIndicator({ currentVersion, repositoryUrl }: VersionUpdateIndicatorProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkVersion = async () => {
      try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const { timestamp, latest, hasUpdate } = JSON.parse(cached);
          if (Date.now() - timestamp < CACHE_DURATION) {
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
        const latestTag = data.tag_name;
        
        if (latestTag) {
          const hasUpdate = isNewerVersion(currentVersion, latestTag);
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
