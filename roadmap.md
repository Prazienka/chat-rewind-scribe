# Modernizace Chat Scribe

- [x] Přepracovat hlavní navigaci a nahrávací panel
- [x] Přidat knihovnu, vyhledávání a rychlý detail záznamu
- [x] Přidat přehledný stav zpracování a srozumitelné chyby
- [x] Přidat hledání, kopírování, editaci a export v přepisu
- [x] Doladit mobilní ovládání, přístupnost a prázdné/loading stavy
- [x] Optimalizovat odvozené výpočty a úklid zvukových zdrojů
- [x] Ověřit desktop, mobil a build

# Oddělení homepage a knihovny
- [x] Vytvořit samostatnou stránku /transcripts
- [x] Odebrat knihovnu z homepage a zachovat aktuální stav zpracování
- [x] Propojit desktopovou a mobilní navigaci
- [x] Ověřit build a preview na desktopu i mobilu

# Dlouhé nahrávky (až 2 hodiny)
- [x] Limit nahrávky 2 hodiny, import až 300 MB
- [x] Průběžné ukládání nahrávky po 4minutových segmentech do zařízení
- [x] Přepis po segmentech s opakováním a zachováním pořadí
- [x] Překlad celého přepisu po částech do jednoho textu
- [x] Průběh zpracování, stavové hlášky a opakování po chybě
- [x] Obnova rozpracované nahrávky po návratu z pozadí
- [x] Ukládání překladu do cloudu
- [x] Ověřit typy, build, přepis 4min segmentu, překlad, desktop i mobil
- [x] Ukládat živou nahrávku po 30 s a při odchodu aplikace do pozadí
- [x] Nahrávat velký zvuk do cloudu po částech s opakováním a průběhem
- [x] Přidat časové limity požadavků a obnovu přerušeného zpracování

# Spolehlivé nahrávání na pozadí
- [x] Stavový automat session oddělený od UI (recording/background/interrupted/recovering/saved/error)
- [x] Watchdog podle času posledních dat z mikrofonu
- [x] Persistované info o session (poslední část, potvrzené části, čeká obnova)
- [x] Stop má prioritu nad obnovou, cleanup až po uzavření poslední části
- [x] Stavové hlášky v UI a rozšiřovací bod pro nativní obal
- [x] Automatické testy lifecyclu nahrávání
