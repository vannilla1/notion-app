# Projekty a úlohy

V Prpl CRM platí jednotná terminológia:
- **Projekt** = hlavná jednotka práce (v kóde sa volá *task*).
- **Úloha** = podúloha vnútri projektu (v kóde *subtask*). Úlohy môžu byť ľubovoľne hlboko zanorené.

Sekciu **Projekty** otvoríš v hornej hlavičke alebo cez spodnú navigáciu na mobile.

## Globálne projekty vs. projekty pri kontakte

- **Globálny projekt** — nepatrí žiadnemu kontaktu. Vidíš ich v sekcii Projekty.
- **Projekt pri kontakte** — pridaný v detaile konkrétneho kontaktu (CRM). Zobrazuje sa pri kontakte aj v zozname Projektov.

Pri vytváraní projektu môžeš voliteľne priradiť **jeden alebo viac kontaktov**.

## Vytvorenie projektu

1. Klikni **+ Nový projekt** v pravom hornom rohu.
2. Vyplň:
   - **Názov** (povinný)
   - **Popis**
   - **Kontakt(y)** — voliteľne, pre prepojenie s CRM
   - **Termín** — najprv dátum, potom čas
   - **Priorita** — Nízka / Stredná / Vysoká
   - **Priradiť** — člen tímu, ktorému projekt patrí
3. Klikni **Uložiť**.

![Screenshot: formulár pre nový projekt](#)

## Pridanie úlohy

1. Klikni na projekt — rozbalí sa.
2. Dole klikni na **+ Pridať úlohu**.
3. V poli zadaj názov. Pod ikonkami sa rozbalí:
   - 📅 termín a čas
   - 📝 poznámka
   - 👤 priradenie kolegu
4. Ulož tlačidlom **Uložiť** alebo Enter.

Každá úloha môže mať vlastné podúlohy — klikni na úlohu a zopakuj postup.

## Označenie hotového

Vedľa každého projektu a úlohy je krúžok (checkbox). Klikni naň pre dokončenie.

> **Pozor:** keď označíš hlavný projekt ako dokončený, automaticky sa dokončia aj všetky jeho úlohy a podúlohy.

Dokončené projekty sa presunú na koniec zoznamu.

## Termíny — dátum a čas

1. **Najprv dátum** — pole pre čas je do vtedy uzamknuté (kurzor „zákaz").
2. **Potom čas** (HH:MM) — modré označenie automaticky preskočí z hodín na minúty.
3. Ak chceš čas zrušiť, klikni na **×** vedľa neho.

Termíny sú farebne odlíšené:

| Stav termínu | Farba | Význam |
|---|---|---|
| **success** | zelená | viac ako 14 dní (8–14 dní) |
| **warning** | žltá | 4–7 dní |
| **danger** | červená | 1–3 dni |
| **overdue** | červená s výkričníkom | dnes alebo po termíne |

## Priority

- **Vysoká** (červená)
- **Stredná** (oranžová)
- **Nízka** (zelená)

Projekty sú automaticky zoradené podľa priority (Vysoká → Nízka), dokončené na konci.

## Pripomienky

Aplikácia má dva typy pripomienok:

### 1. Automatické pripomienky termínu (denne)

Pre projekty/úlohy s vyplneným dátumom termínu chodí pripomienka:
- 14 dní pred (success → warning prechod)
- 7 dní pred (warning)
- 3 dni pred (danger)
- v deň termínu / po termíne

Tieto pripomienky **vždy uvidíš v zvončeku notifikácií**. Či ti prídu aj ako push na telefón, kontroluje toggle **Pripomienky termínov** v Profil → Nastavenia notifikácií.

### 2. Časové pripomienky (presný čas)

Ak v projekte/úlohe vyplníš aj **čas (HH:MM)**, zobrazí sa pole **🔔 Časové pripomienky** s možnosťami:
- 15 minút pred
- 30 minút pred
- 1 hodina pred
- 2 hodiny pred
- 1 deň pred

Môžeš vybrať **viacero možností naraz**. Tieto pripomienky chodia **vždy ako push** (považujú sa za explicitné, takže nie sú filtrované cez Nastavenia notifikácií).

> Pripomienky kontroluje server každých 5 minút. Nastaviť kratší interval ako 15 minút nemá zmysel.

## Priraďovanie kolegov

V detaile projektu alebo úlohy klikni na **👤 Priradiť** a vyber člena tímu.

Priradený kolega:
- Okamžite dostane in-app notifikáciu **„priradil ti projekt"**.
- Dostane push (toto je „direct" notifikácia, vždy chodí push, **nedá sa vypnúť**).

Naopak, keď ten istý priradený kolega projekt **dokončí**, ty (autor) o tom dostaneš notifikáciu.

## Drag & drop poradie

Projekty môžeš preusporiadať uchopením za **ikonu ⠿ (šesť bodiek vľavo)** a pretiahnutím. Funguje to aj pre úlohy v rámci projektu. Na mobile drž prst na ikone a potiahni.

## Súbory pri projekte

V detaile projektu/úlohy klikni na **📎**. Podporované formáty (max. 10 MB / súbor):
- Obrázky (JPG, PNG)
- Dokumenty (PDF, Word, Excel)
- Textové súbory
- Archívy (ZIP)
- Médiá (MP3, MP4)

## Filtre

V ľavom paneli (na mobile hore):
- **Všetky**
- **Na dnes** — projekty s dnešným termínom
- **Priradené mne**
- **Nové** — vytvorené alebo zmenené za posledných 24 hodín
- **Filtre podľa priority** — Vysoká / Stredná / Nízka

## Kalendárový pohľad

Vpravo hore klikni na **ikonu kalendára (📅)**. Prepínač medzi Mesiac / Týždeň / Deň je v hlavičke kalendára.

- **Mesačný pohľad** — body sú projekty/úlohy s termínom v daný deň. Klikni na deň pre denný detail.
- **Týždenný / denný pohľad** — chronologické zoradenie.
- **Mobil** — kalendárom sa dá posúvať dotykom doľava/doprava.

## Export do CSV

Klikni **📥 CSV** vedľa prepínača pohľadu. Stiahne sa tabuľka so všetkými projektmi a ich úlohami (názov, stav, termín, priorita, priradený používateľ).

## Prepojené správy

V detaile projektu nájdeš sekciu **Správy** so všetkými internými správami, ktoré boli s týmto projektom prepojené. Kliknutím na správu sa otvorí v sekcii Správy.
