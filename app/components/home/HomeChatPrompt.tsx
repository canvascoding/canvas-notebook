'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Send } from 'lucide-react';

import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '@/app/lib/chat/constants';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function HomeChatPrompt() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || isSubmitting) {
      return;
    }

    setIsSubmitting(true);

    try {
      window.sessionStorage.setItem(CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY, normalizedPrompt);
    } catch (error) {
      console.error('Failed to persist initial Canvas Chat prompt.', error);
    }

    router.push('/chat');
  };

  return (
    <Card className="border border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4" />
          Canvas Chat starten
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Prompt eingeben und direkt in Canvas Chat weiterschreiben..."
            className="min-h-24 w-full resize-y border border-border bg-background p-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" className="gap-2" disabled={isSubmitting || !prompt.trim()}>
              <Send className="h-4 w-4" />
              In Canvas Chat öffnen
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
