# Sicherheitsübersicht für IT-Verantwortliche

**Was ist das?** imap-mcp verbindet Claude (Anthropic) mit einem E-Mail-Postfach über IMAP/SMTP. Die KI kann – je nach Freigabe – E-Mails suchen, lesen, ordnen, Entwürfe schreiben und senden. Der Dienst läuft lokal auf dem Rechner der Mitarbeiterin bzw. des Mitarbeiters (oder selbst gehostet) und speichert keine E-Mail-Inhalte.

## Datenfluss in einem Satz
Postfach ⇄ (verschlüsselt, TLS ≥ 1.2) ⇄ imap-mcp auf dem Arbeitsplatz ⇄ Claude-App ⇄ Claude-Modell bei Anthropic. Inhalte, die die KI liest, gehen an Anthropic; nutzen Sie daher einen Business-Tarif (Team/Enterprise/API) mit Auftragsverarbeitungsvertrag. Die automatische Servererkennung (DNS, `autoconfig.<domain>`, `autoconfig.thunderbird.net`) übermittelt die Domain der E-Mail-Adresse – bei der Einrichtung und, wenn eine Erweiterung ohne eingetragene Server läuft, bei jedem Start; abschaltbar mit `IMAP_MCP_NO_AUTOCONFIG=1`.

## Berechtigungen (pro Postfach)
| Stufe | Standard | Bedeutung |
|---|---|---|
| Lesen | an | Ordner, Suche, E-Mails lesen |
| Schreiben | an | Markieren, verschieben, Entwürfe |
| Senden | **aus** | E-Mails verschicken |
| Löschen | **aus** | Nur in den Papierkorb verschieben – endgültig gelöscht wird nie (den Papierkorb leeren Sie im eigenen Mailprogramm) |

Zusätzlich legt eine **Richtlinie** fest:
- **Sendemodus:** nur Entwürfe (Empfehlung) / Bestätigung je E-Mail / direkt
- **Empfänger:** erlaubte und gesperrte Domains, maximale Empfängerzahl
- **Mengen:** maximal 20 E-Mails pro Stunde und 100 pro Tag (Standard); Sammelaktionen höchstens 500 Nachrichten, Löschen höchstens 100
- **Ordner:** z. B. „Personal“ oder „Geschäftsführung“ für die KI unsichtbar
- **Anhänge:** Größenlimit, keine ausführbaren Dateien speichern

Tippfehler in der Richtlinie verhindern den Start – nichts wird stillschweigend ignoriert.

## Schutzmaßnahmen
- **Kein stilles Fehlverhalten:** Lehnt der Mailserver etwas ab, meldet das Werkzeug einen Fehler. Eine fehlgeschlagene Suche liefert nie „alle E-Mails“.
- **Bestätigung durch den Menschen:** Senden und Löschen werden in der Claude-App bestätigt. Wo die App es kann, fragt der Dienst selbst nach – gebunden an genau diese E-Mail.
- **Schutz vor manipulierten E-Mails:** Alle Inhalte werden auf „Prompt Injection“ geprüft. Nach einem Fund ist Senden eine Stunde lang nur mit ausdrücklicher Bestätigung möglich.
- **Was geprüft wird, wird gesendet:** Entwürfe werden byte-genau verschickt; eine Kopie landet im Ordner „Gesendet“.
- **Zugangsdaten** liegen im Schlüsselbund des Betriebssystems bzw. verschlüsselt in Claude Desktop, nie im Klartext in Dateien oder Protokollen.
- **Verschlüsselung erzwungen:** keine unverschlüsselten Verbindungen (außer zu lokalen Brücken wie Proton Bridge); eigene Zertifikate werden per Fingerabdruck fest hinterlegt.

## Protokollierung
Jede schreibende, sendende oder löschende Aktion wird in einem **manipulationssicheren Prüfprotokoll** (Hash-Kette) festgehalten: Zeitpunkt, Postfach, Werkzeug, Ordner, Nachrichtennummern, Empfänger, Message-ID, Ergebnis, Art der Bestätigung. **Keine** E-Mail-Texte, keine Anhänge, keine Passwörter. Stufe „minimal“ speichert statt Adressen nur Domains und keine Betreffzeilen. Prüfung: `inbox-warden audit verify` (Ergebnis-Hash extern aufbewahren). Aufbewahrung: Standard 365 Tage.

## Empfohlene Einstellungen
1. Business-Tarif mit Auftragsverarbeitungsvertrag.
2. Erweiterung zentral über die Organisations-Freigabeliste verteilen. „Signatur erforderlich“ (`isDesktopExtensionSignatureRequired`) nicht aktivieren: Mit Claude Desktop 3.x blockiert es jede lokal installierte Erweiterung, und die Pakete ab 0.7.0 sind unsigniert. Die Herkunft belegen Prüfsummen (`SHA256SUMS`) und die Build-Attestierung; prüfen Sie Downloads damit.
3. Dauerhafte „Immer erlauben“-Freigaben deaktivieren.
4. Senden: „nur Entwürfe“ für die meisten Mitarbeitenden; wo Senden nötig ist, Bestätigungsmodus plus Domain-Freigabeliste.
5. Löschen aus. Sensible Ordner sperren.
6. App-Passwörter bzw. OAuth statt Hauptpasswort.
7. Monatlich `inbox-warden audit verify` ausführen.

## Restrisiken
- Wer Sende-Bestätigungen ungelesen erteilt, hebt die Schutzwirkung auf – daher „nur Entwürfe“ als Standard.
- Die Erkennung manipulierter E-Mails ist heuristisch.
- Schadsoftware mit den Rechten der angemeldeten Person kann das Postfach auch ohne KI nutzen.

Details: `threat-model.md`, `data-flow.md`, `hardening-guide.md` (englisch). Sicherheitslücken bitte gemäß `SECURITY.md` melden.
