# Modernizace Chat Scribe

## Cíl
Přepracovat hlavní obrazovku do přehledné, mobilně pohodlné aplikace, aniž by se změnilo nahrávání, AI přepis, cloudové ukládání, skupiny nebo export.

## Co upravím
- Nová horní lišta s jasnou značkou, stavem synchronizace a přístupem k nastavení/přihlášení.
- Výrazný nahrávací panel se samostatnými akcemi **Record / Stop**, časem, živým indikátorem zvuku, zvolenou složkou a importem souboru.
- Přehledný stav zpracování každé nahrávky: nahrávání, přepis, jazyková korektura, AI shrnutí, hotovo nebo konkrétní chyba.
- Knihovna minulých nahrávek s vyhledáváním v názvech i přepisech, filtrem složek, datem, délkou a rychlým otevřením.
- Výsledek nahrávky jako soustředěný detail se záložkami **AI shrnutí / Celý přepis**, hledáním v textu a akcemi kopírovat, upravit a exportovat.
- Dotykové ovládání alespoň 44 × 44 px, mobilní spodní navigace, viditelné focus stavy, správné popisky a klávesové ovládání.
- Krátké kontextové nápovědy a kvalitnější prázdné i načítací stavy.

## Technické provedení
- Rozdělím velkou hlavní stránku na malé prezentační komponenty, aby se méně zbytečně překreslovala.
- Použiji stávající shadcn prvky a současné barevné tokeny; nepřidám nové balíčky.
- Vyhledávání a odvozené seznamy budu počítat memoizovaně; zvukové URL se při odchodu bezpečně uvolní.
- Zachovám existující datový model i cloudové API; editace bude aktualizovat současný přepis stejnou ukládací cestou.
- Opravím jazyk dokumentu na češtinu a zajistím přesně jeden hlavní obsahový landmark.

## Ověření
- Ověřím desktop i mobilní šířku, klíčové interakce a viditelné stavy.
- Zkontroluji přístupnost, chyby v konzoli a automatický build.
