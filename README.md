# JEV Find

Inteligentne znajdowanie na stronie dla przeglądarek na Chromium. Słowa i frazy znajdujesz od razu, lokalnie. Gdy opiszesz fragment własnymi słowami, JEV Find po pauzie w pisaniu szuka go po znaczeniu przez model [TypeSafe JEV](https://docs.typesafe.ai/models).

> Projekt nieoficjalny, niezwiązany z TypeSafe. JEV to nazwa modelu TypeSafe; rozszerzenie korzysta z jego publicznego API z Twoim własnym kluczem.

[In English](#in-english)

## Jak działa

- Mały pasek w prawym górnym rogu strony, bez przyciemniania dokumentu. Motyw jasny albo ciemny według systemu.
- Jedno pole. Trafienia dosłowne podświetlają się od razu na żółto, a z kluczem TypeSafe po pauzie w pisaniu dochodzą trafienia po znaczeniu na fioletowo. Aktywne trafienie jest pomarańczowe albo mocno fioletowe.
- Niepewny wynik nie przewija strony sam: otwierasz go przyciskiem „Pokaż najbliższe”.
- Podświetlenia leżą na oryginalnym tekście strony (CSS Custom Highlights) i znikają po zamknięciu paska. Zmiany strony poza trafieniami, na przykład paski postępu, ich nie kasują.

## Wymagania

- Chrome 120 lub nowszy albo inna przeglądarka na Chromium, na przykład Edge.
- Do wyszukiwania po znaczeniu: własny klucz API z [konsoli TypeSafe](https://console.typesafe.ai/keys). Wywołania mogą kosztować według warunków Twojego konta TypeSafe. Bez klucza działa wyszukiwanie dosłowne.

## Instalacja z Release

1. Pobierz `jev-find-<wersja>.zip` z [Releases](https://github.com/Szewowsky/jev-find/releases) i rozpakuj. Folder `JEV-Find` zostaw w stałym miejscu.
2. Otwórz `chrome://extensions` (w Edge `edge://extensions`), włącz **Tryb dewelopera** i kliknij **Załaduj rozpakowane**.
3. Wskaż folder `JEV-Find` z plikiem `manifest.json` i przypnij JEV Find do paska przeglądarki.
4. W ustawieniach rozszerzenia wklej klucz TypeSafe i zapisz.

Pełna instrukcja jest w ZIP-ie jako `PRZECZYTAJ.md` (źródło: [INSTALL.md](INSTALL.md)).

## Instalacja z kodu

Rozszerzenie nie ma zależności ani kroku budowania. Sklonuj repo i w `chrome://extensions` załaduj rozpakowany folder `extension/`.

## Użycie

- Pasek otwierasz ikoną albo skrótem **Option+Shift+F** na Macu / **Alt+Shift+F** na innych systemach. Skrót zmienisz w `chrome://extensions/shortcuts`. Gdy pracujesz w pasku, ten sam skrót go zamyka; gdy fokus jest na stronie, wraca do paska.
- **↑ ↓** albo przyciski przechodzą po wynikach, **Esc** zamyka pasek i czyści podświetlenia.
- Pasek proponuje akcję, gdy jest potrzebna: „Pokaż najbliższe”, „Odśwież” (gdy zmienił się tekst trafienia), „Ponów” albo „Ustawienia”.
- W ustawieniach dodasz wykluczone domeny: JEV Find nie uruchomi się na nich ani na ich subdomenach.

## Prywatność

- Wyszukiwanie dosłowne działa lokalnie, bez sieci.
- Zapytanie i odczytywalny, już wczytany tekst strony trafiają do TypeSafe dopiero po otwarciu JEV Find i wpisaniu zapytania, i tylko z zapisanym kluczem.
- Klucz zostaje w lokalnym profilu przeglądarki (`chrome.storage.local`), bez synchronizacji. Brak historii wyszukiwań i telemetrii.
- Uprawnienia: `activeTab`, `scripting`, `storage` oraz dostęp sieciowy tylko do `https://api.typesafe.ai/*`.

## Bezpieczeństwo

- Pasek działa w osobnej ramce rozszerzenia. Skrypty strony nie odczytają ani nie zmienią pola przez DOM, nie klikną przycisków paska i nie wyślą do niego zdarzeń ani wiadomości. Klucz czyta tylko rozszerzenie (worker i ustawienia), nie strona ani sam pasek.
- Płatne wyszukiwanie po znaczeniu rusza tylko wtedy, gdy jesteś w pasku: po otwarciu ikoną albo skrótem, po kliknięciu w pasek albo po upuszczeniu w nim tekstu. Gdy pasek straci fokus (na rzecz strony, innej karty, okna albo aplikacji), wpisany tekst daje wyniki dosłowne i przycisk „Szukaj po znaczeniu”. Jedno kliknięcie w pasek albo skrót przywraca pełne działanie.
- Budżet zapytań: jedno wyszukiwanie wysyła do TypeSafe najwyżej 32 żądania HTTP, a jedna karta najwyżej 160 w ciągu 10 minut. Zbyt długa strona dostaje komunikat zamiast wyszukiwania po znaczeniu, a przy bardzo długiej stronie potwierdzane są tylko najlepsze fragmenty. Budżet liczy żądania, nie koszt: koszt zależy od długości strony i warunków Twojego konta TypeSafe.
- Co strona nadal może: widzi podświetlenia, więc z trafień dosłownych odtworzy część albo całość zapytania, a z trafień po znaczeniu wywnioskuje, czego szukasz. Widzi, że pasek jest otwarty. Może go zasłonić albo narysować własną imitację i nakłonić Cię do kliknięcia, pisania, przeciągnięcia albo wklejenia tekstu, który sama przygotowała. Takie nakłonienie kosztuje najwyżej wyszukiwania wynikające z Twoich własnych gestów w prawdziwym pasku, w granicach budżetu.
- Strona paska jest zasobem dostępnym z sieci pod stałym adresem rozszerzenia, więc strona, która zna identyfikator Twojej instalacji, może wykryć, że masz JEV Find.

## Ograniczenia

- Czyta wyrenderowany tekst, także poza ekranem, otwarte shadow roots i dostępne ramki tej samej domeny. Nie obsługuje PDF, obrazów, canvas, zamkniętych shadow roots, chronionych stron przeglądarki ani niedostępnych ramek i nie doczytuje treści automatycznie.
- Długie strony trafiają do API w partiach z limitem bajtów; to heurystyka, nie tokenizer.
- Progi dobrego dopasowania są wstępne. Sprawdzone w Chromium 151 na macOS; Windows nie był testowany.

## Rozwój

Potrzebny Node.js (sprawdzone na 22) i npm, a do pakowania polecenia `zip` i `unzip`.

```sh
npm ci            # narzędzia deweloperskie: Playwright do testów w przeglądarce
npm test          # testy jednostkowe (node --test)
npm run check     # składnia i pliki z manifestu
npm run icons     # PNG ikon z extension/icons/source*.svg
npm run package   # testy, kontrola i ZIP w dist/
```

Testy w prawdziwym Chromium potrzebują jednorazowo `npx playwright install chromium`:

```sh
node scripts/browser-qa.mjs [folder-rozszerzenia]
node scripts/qa-regressions.mjs [folder-rozszerzenia]
node scripts/design-gallery.mjs [folder-rozszerzenia] [folder-wyników] [light|dark]
```

Skrypty ładują rozszerzenie w osobnym profilu, blokują DNS i odpowiadają na wywołania API lokalnymi danymi testowymi ze sztucznym kluczem, więc nie potrzebują klucza ani sieci. Wyniki trafiają do `.scratch/` poza repo: `JEV_QA_DIR` zmienia folder, `JEV_QA_CAPTURE=1` zapisuje zrzuty, a `JEV_PLAYWRIGHT_MODULE` wskazuje inną instalację Playwrighta.

Struktura: `extension/` (MV3: `background.js` z budżetem w `budget.js`, `content.js`, `core.js`, pasek `bar.html` z logiką decyzji w `gate.js`, ustawienia, ikony ze źródłami SVG), `scripts/` (kontrola, pakowanie, ikony, QA), `tests/` (testy jednostkowe i strony testowe).

## Licencja

[MIT](LICENSE), © 2026 Robert Szewczyk.

## In English

JEV Find is an unofficial find-in-page extension for Chromium browsers. Words and phrases are highlighted locally as you type; with your own [TypeSafe](https://console.typesafe.ai/keys) API key it also finds passages by meaning with the TypeSafe JEV model after a short pause. Page text is sent to TypeSafe only after you open the bar and type a query, and calls may cost money under your TypeSafe account terms. The key stays in your local browser profile. The bar runs in an isolated extension frame, so page scripts cannot read or fill its field. Paid searches start only while you are in the bar (after opening it, clicking it or dropping text on it); requests are capped at 32 per search and 160 per tab per 10 minutes, which limits the number of requests, not their price. A page can still infer your query from the literal highlights, see that the bar is open and imitate or cover it. To install, download the ZIP from [Releases](https://github.com/Szewowsky/jev-find/releases), unzip it, open `chrome://extensions`, enable Developer mode and load the `JEV-Find` folder. The interface is in Polish. Not affiliated with TypeSafe. MIT license.
