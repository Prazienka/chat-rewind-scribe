# Oddělení domovské stránky a přepisů

## Výsledek
- Domovská stránka zůstane čistá: nahrávání, import, jazyk, složka a aktuální průběh zpracování.
- Knihovna se přesune na samostatnou stránku **Přepisy** dostupnou z horní i mobilní navigace.
- Domovská stránka nabídne jen nenápadný odkaz na přepisy a případný stručný stav právě zpracovávaných nahrávek.
- Stránka Přepisy zachová vyhledávání, složkové filtry, přejmenování, seznam a detail se shrnutím, celým textem, editací, přehráním a exporty.

## Technické provedení
- Sdílenou logiku nahrávání, ukládání, synchronizace a AI zpracování přesunu do společné pracovní komponenty se dvěma režimy: nahrávání a knihovna.
- Přidám samostatnou adresu `/transcripts` a propojím ji typově bezpečnými odkazy v navigaci.
- Na domovské stránce odstraním vykreslení dlouhého seznamu, ale zachovám živé zobrazení aktuálního zpracování.
- Každá stránka dostane vlastní český název a popis pro sdílení a vyhledávače.

## Ověření
- Ověřím nahrávání a čistou domovskou stránku na počítači i mobilu.
- Ověřím vyhledávání, filtry, otevření detailu a návrat mezi stránkami.
- Zkontroluji sestavení, konzoli a přetékání obsahu.
