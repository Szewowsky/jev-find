# JEV Find - instalacja i pierwsze użycie

1. Rozpakuj ZIP. Zachowaj folder `JEV-Find` w stałym miejscu: przeglądarka odczytuje z niego rozszerzenie.
2. Otwórz `chrome://extensions` w Chrome albo innej przeglądarce na Chromium (w Edge: `edge://extensions`). Manifest wymaga Chrome 120 lub nowszego.
3. Włącz **Tryb dewelopera**, kliknij **Załaduj rozpakowane** i wskaż folder `JEV-Find` zawierający `manifest.json`.
4. Przypnij JEV Find do paska przeglądarki, aby mieć dostęp do ikony. Do wyszukiwania po znaczeniu wklej w ustawieniach rozszerzenia własny klucz z [konsoli TypeSafe](https://console.typesafe.ai/keys) i zapisz. Bez klucza działa wyszukiwanie dosłowne.
5. Na zwykłej stronie kliknij ikonę albo użyj **Option+Shift+F** na Macu / **Alt+Shift+F** na innych systemach. Własny skrót ustawisz w `chrome://extensions/shortcuts`.

Jedno pole: słowa i frazy są wyszukiwane lokalnie od razu, a z kluczem TypeSafe po pauzie w pisaniu także po znaczeniu przez JEV. Trafienia dosłowne są żółte, po znaczeniu fioletowe; aktywne trafienie jest pomarańczowe albo mocno fioletowe. Strzałki góra/dół i przyciski przechodzą po wynikach. Lewo/prawo edytują zapytanie. Escape lub przycisk zamyka pasek i usuwa jego podświetlenia. Niepewny fragment otwierasz świadomie przyciskiem „Pokaż najbliższe”. Zmiany strony poza trafieniami, na przykład paski postępu, przyciski Play/Pause czy menu, nie kasują podświetleń. Gdy zmieni się tekst samego trafienia, pasek usuwa tylko je i proponuje „Odśwież”. Każde nowe zapytanie przeszukuje aktualną treść strony.

Pasek działa w osobnej ramce rozszerzenia: skrypty strony nie odczytają ani nie zmienią pola i nie klikną jego przycisków. Płatne wyszukiwanie po znaczeniu rusza tylko wtedy, gdy jesteś w pasku (po otwarciu, kliknięciu w pasek albo upuszczeniu w nim tekstu). Gdy pasek straci fokus, wpisany tekst daje wyniki dosłowne i przycisk „Szukaj po znaczeniu”; jedno kliknięcie w pasek albo skrót przywraca pełne działanie. Jedno wyszukiwanie wysyła najwyżej 32 żądania do TypeSafe, a jedna karta najwyżej 160 w ciągu 10 minut; to limit liczby żądań, nie kosztu. Strona nadal widzi podświetlenia, więc z trafień dosłownych odtworzy zapytanie, i może zasłonić albo podrobić pasek, żeby nakłonić Cię do pisania w nim.

Klucz pozostaje w lokalnym profilu przeglądarki i nie jest synchronizowany. Zapytanie i odczytywalny, już wczytany tekst strony trafiają do TypeSafe dopiero po uruchomieniu JEV Find i wpisaniu zapytania. Wywołania mogą kosztować zgodnie z warunkami Twojego konta TypeSafe. Zapis klucza nie wywołuje API. Bez klucza lub przy awarii usługi nadal działa szukanie dosłowne. Wykluczenia w ustawieniach obejmują domenę i jej subdomeny. Rozszerzenie nie zapisuje historii wyszukiwań.

JEV Find czyta wyrenderowany tekst, także poza ekranem, otwarte shadow roots i dostępne ramki tej samej domeny. Nie obsługuje PDF, obrazów, canvas, zamkniętych shadow roots, chronionych stron przeglądarki ani niedostępnych ramek. Nie doczytuje automatycznie treści. Ikona z liczbą w pasku wskazuje niedostępne ramki. Progi dobrego dopasowania są wstępne, więc jakość wyszukiwania po znaczeniu sprawdź na własnych stronach.

Nie potrzebujesz npm ani lokalnego serwera. Podświetlenie i licznik pojawiają się od razu; automatyczny skok do trafienia czeka na pauzę w pisaniu. Po przeładowaniu rozszerzenia odśwież stronę, aby uruchomić nowy pasek.
