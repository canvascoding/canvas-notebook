'use client';

import { useState } from 'react';
import { HelpCircle } from 'lucide-react';

import { HelpCard } from '@/app/components/help/HelpCard';
import { HelpDialog } from '@/app/components/help/HelpDialog';
import { tutorials, type Tutorial } from '@/app/components/help/help-data';

export default function HelpPageClient() {
  const [selectedTutorial, setSelectedTutorial] = useState<Tutorial | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  function handleOpenTutorial(tutorial: Tutorial) {
    setSelectedTutorial(tutorial);
    setDialogOpen(true);
  }

  return (
    <>
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-6">
        <div className="space-y-5 sm:space-y-6">
          {/* Intro */}
          <div className="max-w-2xl space-y-2">
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Willkommen in der Hilfe</h2>
            <p className="text-sm text-muted-foreground sm:text-base">
              Hier findest du Tutorials und Anleitungen für Canvas Notebook. 
              Klicke auf eine Karte, um mehr zu erfahren.
            </p>
          </div>

          {/* Tutorials Grid */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {tutorials.map((tutorial) => (
              <HelpCard
                key={tutorial.id}
                tutorial={tutorial}
                onClick={() => handleOpenTutorial(tutorial)}
              />
            ))}
          </div>

          {/* Empty State */}
          {tutorials.length === 0 && (
            <div className="py-12 text-center">
              <HelpCircle className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
              <h3 className="mb-2 text-lg font-semibold">Keine Tutorials verfügbar</h3>
              <p className="mx-auto max-w-md text-sm text-muted-foreground sm:text-base">
                Tutorials werden hier angezeigt, sobald sie verfügbar sind.
              </p>
            </div>
          )}
        </div>
      </div>

      <HelpDialog
        tutorial={selectedTutorial}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
