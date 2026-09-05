import { Heart } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import packageJson from '../../../package.json';

import { requirePageSession } from '@/app/lib/auth-guards';
import { HomeWorkspaceView } from '@/app/components/home/HomeWorkspaceView';
import { AppLauncher } from '@/app/components/AppLauncher';
import { NotificationBell } from '@/app/components/notifications/NotificationBell';
import { HomeHintProvider } from '@/app/components/onboarding/HomeHintProvider';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';
import { getUserOnboardingState } from '@/app/lib/user-preferences';
import { GettingStartedCard } from '@/app/components/onboarding/GettingStartedCard';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { VersionUpdateIndicator } from '@/app/components/VersionUpdateIndicator';
import { WorkspaceSwitcher } from '@/app/components/workspaces/WorkspaceSwitcher';
import { WorkspaceBrandLogo } from '@/app/components/workspaces/WorkspaceBrandLogo';
import { isBrowserLabAllowed } from '@/app/lib/pi/browser/view-access';
import { resolveUserProfile } from '@/app/lib/user-profile/service';
import { UserProfileBadge } from '@/app/components/user-profile/UserProfileBadge';

const repositoryUrl = 'https://github.com/canvascoding/canvas-notebook';
const releaseVersion = packageJson.version;
const releaseTag = `v${releaseVersion}`;
const releaseTagUrl = `${repositoryUrl}/releases/tag/${releaseTag}`;

export default async function Home() {
  const tHome = await getTranslations('home');
  const onboardingHintsEnabled = isOnboardingHintsEnabled();
  const session = await requirePageSession();
  if (!session) return null;
  const userOnboarding = await getUserOnboardingState(session.user.id);
  const userProfile = await resolveUserProfile({
    userId: session.user.id,
    name: session.user.name,
    email: session.user.email,
  });
  // Guided hints are opt-in. A started personal tour must not bypass this gate,
  // otherwise it can leave an unusable overlay in front of the workspace.
  const showPersonalTour = onboardingHintsEnabled && userOnboarding?.tour === 'started';

  return (
    <HomeHintProvider enabled={onboardingHintsEnabled}>
      <div className="fixed inset-0 overflow-hidden bg-background text-foreground">
        <div className="flex h-full min-h-0 flex-col">
          <header className="sticky top-0 z-20 shrink-0 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/85">
            <div className="mx-auto flex min-h-14 max-w-7xl flex-nowrap items-center justify-between gap-1.5 px-3 py-2 sm:gap-2 sm:px-4 md:px-6">
              <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
                <WorkspaceBrandLogo
                  alt={tHome('header.logoAlt')}
                  width={144}
                  height={32}
                  priority
                  className="h-7 max-w-[4.25rem] shrink-0 object-contain sm:h-8 sm:max-w-36"
                  fallbackClassName="w-8 border border-border object-cover"
                  workspaceClassName="w-auto"
                />
                <div className="hidden min-w-0 flex-col min-[390px]:flex">
                  <span className="hidden text-[10px] font-bold tracking-widest text-muted-foreground uppercase sm:block">{tHome('header.productName')}</span>
                  <span className="truncate text-sm font-semibold">{tHome('header.productLabel')}</span>
                </div>
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-3">
                <WorkspaceSwitcher source="home" variant="compact" />
                <NotificationBell />
                <AppLauncher />
                <div className="hidden min-[380px]:block">
                  <ThemeToggle />
                </div>
                <UserProfileBadge profile={userProfile} />
              </div>
            </div>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-5 pb-8 sm:px-4 sm:pt-6 md:px-6 md:pt-8">
            <div className="mx-auto max-w-6xl space-y-6">
              {showPersonalTour && <GettingStartedCard />}

              <HomeWorkspaceView
                showBrowserLab={isBrowserLabAllowed(session.user)}
              />
            </div>
          </main>

          <footer className="shrink-0 border-t border-border bg-background/95">
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-4 py-3 text-[10px] md:px-6 md:text-[11px]">
              <a
                href="https://agency.canvas.holdings"
                target="_blank"
                rel="noopener noreferrer"
                className="flex shrink-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground sm:gap-1.5"
              >
                <span className="hidden sm:inline">{tHome('footer.madeWith')}</span>
                <span className="sm:hidden">by</span>
                <Heart className="h-3 w-3 fill-current text-red-500" />
                <span className="hidden sm:inline">{tHome('footer.byCanvasCoding')}</span>
                <span className="sm:hidden">Canvas Coding</span>
              </a>
              <div className="flex min-w-0 items-center justify-end gap-2 whitespace-nowrap">
                <a
                  href={repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-w-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground sm:gap-1.5"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5 shrink-0 fill-current"
                  >
                    <path d="M12 1.25a10.75 10.75 0 0 0-3.4 20.95c.54.1.74-.23.74-.52v-1.84c-3 .65-3.63-1.28-3.63-1.28-.49-1.24-1.2-1.57-1.2-1.57-.98-.67.08-.66.08-.66 1.08.08 1.65 1.1 1.65 1.1.96 1.64 2.52 1.16 3.13.89.1-.7.38-1.16.68-1.43-2.4-.27-4.92-1.2-4.92-5.33 0-1.18.42-2.15 1.1-2.9-.1-.27-.48-1.37.11-2.84 0 0 .9-.29 2.95 1.1a10.25 10.25 0 0 1 5.38 0c2.04-1.39 2.95-1.1 2.95-1.1.59 1.47.22 2.57.11 2.84.68.75 1.1 1.72 1.1 2.9 0 4.14-2.53 5.05-4.94 5.32.39.34.73 1 .73 2.02v2.99c0 .29.2.63.74.52A10.75 10.75 0 0 0 12 1.25Z" />
                  </svg>
                  <span className="hidden sm:inline">canvascoding/canvas-notebook</span>
                </a>
                <div className="flex items-center gap-1">
                  <a
                    href={releaseTagUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {tHome('footer.version', { version: releaseVersion })}
                  </a>
                  <VersionUpdateIndicator
                    currentVersion={releaseVersion}
                    repositoryUrl={repositoryUrl}
                  />
                </div>
              </div>
            </div>
          </footer>
        </div>
      </div>
    </HomeHintProvider>
  );
}
