const repeat = (value: string, count: number): string => value.repeat(count);

export const longFirstSnippet = repeat('Erster Treffer — lang und vollständig. ', 400);
export const longLaterSnippet = repeat('Später Treffer — darf heute ebenfalls vollständig bleiben. ', 160);
export const unicodeTitle = 'Überblick: Grüße aus München — 東京 / café';
export const unicodeUrl = 'https://例え.テスト/検索?q=grüße%20東京#résumé';
export const longUrl = `https://example.test/${repeat('very-long-path-', 24)}?q=${encodeURIComponent('lange Suche 東京')}`;
export const base64ImageData = `data:image/png;base64,${repeat('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 8)}`;

export const braveDirectPayload = {
  web: {
    results: [
      {
        title: 'First Brave result',
        url: 'https://example.test/first',
        description: longFirstSnippet,
        age: '1 day ago',
        profile: { name: 'Example Source' },
      },
      {
        title: unicodeTitle,
        url: unicodeUrl,
        description: 'Unicode snippet: déjà vu — 日本語',
        page_age: '2 days ago',
      },
      {
        title: 'Later Brave result',
        url: longUrl,
        description: longLaterSnippet,
        description_data: base64ImageData,
      },
      { title: 'Empty URL is discarded', url: '', description: 'discard me' },
    ],
  },
};

export const managedBravePayload = {
  results: [
    {
      title: 'Managed first result',
      url: 'https://managed.example/first',
      snippet: longFirstSnippet,
      age: 'today',
      source: 'Managed Source',
    },
    {
      title: unicodeTitle,
      url: unicodeUrl,
      snippet: 'Managed Unicode — Inhalt',
      content: base64ImageData,
    },
    {
      title: 'Managed later result',
      url: longUrl,
      snippet: longLaterSnippet,
    },
  ],
};

export const ollamaPayload = {
  results: [
    { title: 'First Ollama result', url: 'https://ollama.example/first', content: longFirstSnippet },
    { title: unicodeTitle, url: unicodeUrl, content: 'Ollama Unicode — Inhalt' },
    { title: 'Later Ollama result', url: longUrl, content: longLaterSnippet },
  ],
};

export const invalidManagedPayload = { unexpected: 'shape', results: 'not-an-array' };
export const braveErrorPayload = { error: 'upstream unavailable' };
