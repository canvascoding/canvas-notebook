import 'server-only';

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { WorkspaceType } from './types';

export const WORKSPACE_STARTER_DOCUMENT_NAME = 'Erste Schritte.md';

function workspaceIntroduction(workspaceType: WorkspaceType): string {
  if (workspaceType === 'personal') {
    return `## Dein persönlicher Workspace

Dieser Workspace ist dein privater Arbeitsbereich. Hier kannst du eigene Notizen, Entwürfe, Dateien und Ideen sammeln und sie gemeinsam mit Bradley weiterentwickeln.`;
  }

  if (workspaceType === 'team') {
    return `## Euer Team-Workspace

Dieser Workspace ist ein gemeinsamer Arbeitsbereich für euer Team. Alle Mitglieder sehen nur die Inhalte, für die sie berechtigt sind. Nutzt klare Ordner, verständliche Dateinamen und @Mentions, damit Zusammenarbeit und Übergaben nachvollziehbar bleiben.`;
  }

  if (workspaceType === 'organization') {
    return `## Euer Organisations-Workspace

Dieser Workspace bündelt Wissen und Arbeitsmaterialien, die in der Organisation gemeinsam genutzt werden. Berechtigungen steuern, wer Inhalte lesen, bearbeiten oder verwalten darf.`;
  }

  return `## Euer Projekt-Workspace

Dieser Workspace gehört zu einem Projekt. Hier bleiben Projektwissen, Dateien, Aufgaben und die Arbeit mit Bradley in einem klar abgegrenzten gemeinsamen Kontext.`;
}

function workspaceChecklist(workspaceType: WorkspaceType): string {
  if (workspaceType === 'personal') {
    return `- [ ] Schreibe unter diese Liste eine erste private Notiz
- [ ] Bitte Bradley, die Notiz zu strukturieren oder zusammenzufassen`;
  }

  return `- [ ] Legt eine einfache Ordnerstruktur für eure Zusammenarbeit an
- [ ] Verwendet eine @Mention, um ein Teammitglied in einem Dokument anzusprechen`;
}

export function createWorkspaceStarterDocument(workspaceType: WorkspaceType): string {
  const isPersonal = workspaceType === 'personal';
  const opening = isPersonal
    ? 'Dieses Dokument ist dein kurzer Einstieg und gleichzeitig eine sichere Spielwiese. Du kannst alles darin verändern, umbenennen oder löschen.'
    : 'Dieses Dokument ist euer kurzer Einstieg und gleichzeitig eine sichere Spielwiese. Ihr könnt alles darin verändern, umbenennen oder löschen.';
  const closing = isPersonal
    ? 'Passe die Struktur an deine Arbeit an.'
    : 'Passt die Struktur an eure Zusammenarbeit an.';

  return `# Willkommen bei Canvas Notebook 👋

${opening} Änderungen werden automatisch gespeichert; gelöschte Dateien lassen sich über den Papierkorb beziehungsweise direkt nach dem Löschen wiederherstellen.

${workspaceIntroduction(workspaceType)}

## In zwei Minuten loslegen

${workspaceChecklist(workspaceType)}
- [ ] In einer leeren Zeile \`/\` tippen und einen Block einfügen
- [ ] Text markieren und **Fett**, *Kursiv*, ~~Durchgestrichen~~, \`Inline-Code\` oder ==Highlight== ausprobieren
- [ ] Ein weiteres Markdown-Dokument erstellen und mit \`[[Dokumentname]]\` verlinken
- [ ] In den To-dos eine Aufgabe mit Bezug zu einer Datei anlegen
- [ ] Zum Abschluss dieses Dokument umbenennen oder löschen

> [!tip] Arbeite direkt mit Bradley
> Öffne den Chat im Notebook, beschreibe dein Ziel und verweise auf die aktuelle Datei. Je nach Berechtigung kann Bradley Inhalte analysieren, neue Dateien anlegen oder konkrete Änderungen zur Übernahme vorschlagen.

## Dokumente bearbeiten

Der Markdown-Editor unterstützt unter anderem:

- Überschriften, Listen, Checklisten, Zitate und Codeblöcke
- Tabellen, Formeln, Fußnoten, Callouts und aufklappbare Bereiche
- Bilder aus einer Datei oder von einer URL
- Wiki-Links zwischen Dokumenten und eingebettete Markdown-Dokumente
- einen Quelltextmodus für die direkte Bearbeitung des Markdown-Inhalts
- gemeinsames Bearbeiten unterstützter Dokumente in geteilten Workspaces

Ziehe Blöcke am Griff an der linken Seite, um sie neu anzuordnen. Mit \`/\` findest du die verfügbaren Blöcke besonders schnell.

## Dateien und weitere Werkzeuge

Im Dateibereich kannst du Ordner anlegen sowie Dateien hochladen, verschieben, kopieren, umbenennen, herunterladen und löschen. Canvas zeigt neben Markdown auch Bilder, PDFs, Office-Dokumente, Tabellen, Präsentationen, Audio, Video und viele Codeformate direkt an.

- **To-dos** halten nächste Schritte, Zuständigkeiten, Prioritäten und Fälligkeiten fest.
- **Automationen** führen wiederkehrende oder zeitgesteuerte Arbeit aus.
- **Terminal** bietet direkten Kommandozeilenzugriff auf den Workspace.
- **Einstellungen** verwalten Workspace-Mitglieder, Bradley, Provider, Tools und Integrationen.
- **Hilfe** enthält ausführlichere Anleitungen.

## Eine gute Grundstruktur

Du kannst zum Beispiel so beginnen:

\`\`\`text
Projekte/
Wissen/
Vorlagen/
Archiv/
\`\`\`

${closing} Dieses Startdokument ist nur ein Vorschlag und darf jederzeit verschwinden.
`;
}

export function seedWorkspaceStarterDocument(input: {
  rootPath: string;
  workspaceType: WorkspaceType;
}): 'created' | 'existing' {
  const documentPath = path.join(input.rootPath, WORKSPACE_STARTER_DOCUMENT_NAME);

  try {
    writeFileSync(documentPath, createWorkspaceStarterDocument(input.workspaceType), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return 'created';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      return 'existing';
    }
    throw error;
  }
}
