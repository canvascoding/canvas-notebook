# Diktat und späterer Live-Voice-Modus

## Referenz und Umfang

Referenz ist [Hermes Agent, Commit `614b9b3`](https://github.com/NousResearch/hermes-agent/tree/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0) (MIT-Lizenz). Die aktuelle Umsetzung umfasst ausschließlich Diktat: Mikrofonaufnahme, Transkription und Einfügen als bearbeitbarer Chat-Entwurf. Live Voice ist eine spätere Phase.

Konkrete Hermes-Einstiegspunkte:

- [Mikrofonaufnahme mit MediaRecorder](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/apps/desktop/src/app/chat/composer/hooks/use-mic-recorder.ts#L235-L305)
- [Diktatstatus und Transkriptionsablauf](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/apps/desktop/src/app/chat/composer/hooks/use-voice-recorder.ts#L17)
- [Voice-Menü im Composer](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/apps/desktop/src/app/chat/composer/voice-menu.tsx#L50)
- [Provider-Liste](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/tools/transcription_common.py#L40-L51): local, local_command, Groq, OpenAI, Mistral, xAI, ElevenLabs und DeepInfra. Canvas beginnt mit lokal, OpenAI und Groq; Groq ist nicht der einzige Cloud-Weg.
- [Faster-Whisper-Initialisierung](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/tools/transcription_local.py#L140-L203) und [Transkription samt Auswertung der lazy Segmente](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/tools/transcription_tools.py#L347-L382)
- [STT-Auswahl in den Hermes-Einstellungen](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/apps/desktop/src/app/settings/constants.ts#L362)

## Phase 1: Diktat

1. Administrator wählt in **Einstellungen → Diktat** genau einen Provider und ein dazu passendes Modell. Die Konfiguration gilt für alle Benutzer und ist zunächst deaktiviert. Derselbe Bereich erscheint optional im Administrator-Onboarding nach der Provider-Prüfung. Lokal wird ein Hinweis auf CPU/RAM und den ersten Modelldownload angezeigt.
2. Server prüft bei jeder Anfrage die globale Einstellung, Verfügbarkeit und Anmeldung. Nur Administratoren dürfen die Konfiguration ändern. Schlüssel liegen in der zentralen Integrationsverwaltung. Bei ausgeschaltetem oder fehlendem Dienst wird die Mikrofontaste nicht angezeigt und der Transkriptionsendpunkt verweigert Anfragen.
3. Browser nimmt per MediaRecorder auf. Ein erneuter Klick stoppt die Aufnahme; das Ergebnis wird transkribiert und an den bestehenden Entwurf angehängt. Der Benutzer kann den Text vor dem Senden bearbeiten. Es erfolgt kein automatisches Senden.
4. Lokaler Provider nutzt einen langlebigen Python-Prozess mit Faster-Whisper auf CPU/int8; das Modell wird im DATA-Cache abgelegt und nach Inaktivität entladen. Die Python-Abhängigkeiten sind mit Hashes fixiert. Cloud-Provider nutzen die jeweilige Audio-Transcriptions-API.
5. Prüfen: Build, Zugriffsrechte der API, Providerwechsel und Aktivierung, Sichtbarkeit der Mikrofontaste, Aufnahme/Stop/Transkript als Entwurf, Fehlerfälle und lokale Transkription mit einem echten Audiobeispiel. Keine Container bauen, solange das nicht ausdrücklich angefordert wird.

## Phase 2: Live Voice

Nach der Diktatfreigabe separat planen und implementieren. Dazu Hermes' [Live-Voice-Hook](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/apps/desktop/src/app/chat/composer/hooks/use-voice-live-conversation.ts), [Client-Direktverbindung](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/apps/desktop/src/lib/voice-client-direct.ts) und [Live-Voice-Transport](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/apps/desktop/src/lib/voice-live.ts) im selben Commit untersuchen. Festzulegen sind ein eigener Administratorschalter, Kosten- und Providersteuerung, Audio-Berechtigungen, Unterbrechungen, Gesprächszustand und Fallback auf Diktat. Live Voice verändert den Diktatpfad nicht implizit.
