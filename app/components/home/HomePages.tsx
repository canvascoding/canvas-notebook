'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import styles from './home-pages.module.css';

export function HomePages({ work, workspace }: { work: ReactNode; workspace: (active: boolean) => ReactNode }) {
  const t = useTranslations('home.pages');
  const firstRef = useRef<HTMLElement>(null);
  const secondRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const root = firstRef.current?.closest<HTMLElement>('[data-home-scroll]');
    const first = firstRef.current;
    const second = secondRef.current;
    if (!root || !first || !second) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const boundary = root.getBoundingClientRect().top + root.clientHeight * 0.45;
      setActive(second.getBoundingClientRect().top <= boundary ? 1 : 0);
      root.dataset.homeOverflow = String(first.scrollHeight > root.clientHeight + 1 || second.scrollHeight > root.clientHeight + 1);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    observer.observe(first);
    observer.observe(second);
    root.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener('scroll', schedule);
      delete root.dataset.homeOverflow;
    };
  }, []);

  const navigate = (index: number) => {
    const section = index === 0 ? firstRef.current : secondRef.current;
    if (!section) return;
    section.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };

  return (
    <>
      <nav className={styles.navigation} aria-label={t('navigation')}>
        {(['continue', 'workspace'] as const).map((key, index) => (
          <button key={key} type="button" onClick={() => navigate(index)} aria-label={t(key)} aria-controls={index === 0 ? 'home-continue' : 'home-workspace'} aria-current={active === index ? 'step' : undefined} title={t(key)} className="group flex h-10 w-10 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="8" className={active === index ? 'fill-primary/15' : 'fill-transparent'} />
              <circle cx="10" cy="10" r="4" className={active === index ? 'fill-primary' : 'fill-muted-foreground/40 group-hover:fill-foreground'} />
            </svg>
          </button>
        ))}
      </nav>
      <section ref={firstRef} id="home-continue" tabIndex={-1} aria-labelledby="home-files-heading" className={`${styles.page} outline-none`}>
        <div className={styles.content}>{work}</div>
        <div className={`${styles.content} mt-auto flex justify-center pt-2`}>
          <Button variant="ghost" size="sm" className="gap-2 text-xs text-muted-foreground" onClick={() => navigate(1)}>{t('toWorkspace')}<ArrowDown className="h-3.5 w-3.5" /></Button>
        </div>
      </section>
      <section ref={secondRef} id="home-workspace" tabIndex={-1} aria-labelledby="home-workspaces-heading" className={`${styles.page} border-t border-border/60 outline-none`}>
        <div className={`${styles.content} flex-1`}>{workspace(active === 1)}</div>
        <div className={`${styles.content} flex justify-center pt-2`}>
          <Button variant="ghost" size="sm" className="gap-2 text-xs text-muted-foreground" onClick={() => navigate(0)}><ArrowUp className="h-3.5 w-3.5" />{t('toContinue')}</Button>
        </div>
      </section>
    </>
  );
}
