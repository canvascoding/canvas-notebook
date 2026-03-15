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
      <main className="flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          {/* Intro */}
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">Willkommen in der Hilfe</h2>
            <p className="text-muted-foreground">
              Hier findest du Tutorials und Anleitungen für Canvas Notebook. 
              Klicke auf eine Karte, um mehr zu erfahren.
            </p>
          </div>

          {/* Tutorials Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
            <div className="text-center py-12">
              <HelpCircle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">Keine Tutorials verfügbar</h3>
              <p className="text-muted-foreground max-w-md mx-auto">
                Tutorials werden hier angezeigt, sobald sie verfügbar sind.
              </p>
            </div>
          )}
        </div>
      </main>

      <HelpDialog
        tutorial={selectedTutorial}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
