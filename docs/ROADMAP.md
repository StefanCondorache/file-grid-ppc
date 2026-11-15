# FileGrid PPC: ghid de învățare și prezentare

Ghid de studiu și de prezentare pentru echipă, scris pe baza `main` la `6eb8e0c` (15.11.2026). Citiți-l în
ordine: ce spunem, cum funcționează, unde arătăm, ce poate întreba juriul.

---

## 1. Prezentarea (30 de secunde)

> Rețele Electrice primește zilnic citiri de contoare, fișe de avarie, documente de racordare și video de la
> drone, puse azi ad-hoc pe FTP, S3 sau în baze de date. FileGrid este **o singură poartă de intrare**: o
> **politică per categorie** decide unde și cum se scrie fiecare fișier, iar sistemul **dovedește** că
> fișierul recuperat e identic (SHA-256), **rezistă** la căderea unui storage și la rețele proaste și
> **măsoară** tot, ca să spună din date ce storage se potrivește fiecărei categorii.

Live: **https://ppc.filegrid.cc.cd** (mod demo: alegeți un rol, fără parolă).

---

## 2. Problema într-un tabel (enunț, tabelul 2.1)

| Categorie | Cum intră | Dimensiune | Cerința de business | Cum o dovedim |
|---|---|---|---|---|
| **Citiri contoare** | trimise de contoarele inteligente simulate | 1–50 KB, foarte multe | nicio citire pierdută sau dublată | idempotente pe `readingId`; contoare live: primite, unice, duplicate respinse, **pierdute = 0** |
| **Înregistrări de avarie** | încărcate din interfață | 1–10 MB, vârfuri la furtuni | disponibile **imediat** pentru dispecerat | „disponibil în X s” la fiecare încărcare; izolarea pe categorii (bulkhead) o ține rapidă în timpul unei furtuni |
| **Documente de racordare** (date personale) | încărcate din interfață | 0,1–10 MB | datele personale **protejate și verificabile la audit** | criptate la stocare (AES-256-GCM); numele și CNP-ul mascate; doar auditorul le poate afișa, cu un motiv, iar afișarea intră în audit |
| **Video inspecții dronă** | încărcate din interfață | 100 MB – 1 GB+ | transferul **rezistă pe conexiuni lente sau instabile** | încărcare reluabilă pe bucăți, reîncercări cu pauze tot mai lungi, reluare după deconectare sau reîncărcarea paginii; memoria serverului rămâne constantă și la 1 GB+ |

---

## 3. Arhitectura (de pus pe un slide)

```
 Browser (interfața Next.js)                  Contoare inteligente (simulator)
      │ HTTPS: Cloudflare → Traefik (Let's Encrypt)         │ POST /api/v1/meter-readings (X-API-Key)
      ▼                                                      ▼
 ┌──────────────────────────── k3s pe un singur VPS ────────────────────────────┐
 │ namespace filegrid:   frontend (Next.js) · backend (NestJS, 1–3 replici,      │
 │                       HPA) · simulator                                       │
 │ namespace filegrid-storage (doar ClusterIP, NetworkPolicy: doar podurile     │
 │                       backend)  PostgreSQL 17 · S3 (SeaweedFS) · FTP (pure-ftpd) │
 │ namespace monitoring: Prometheus · Alertmanager · Grafana · Loki · Alloy     │
 └──────────────────────────────────────────────────────────────────────────────┘
```

| Componentă | Tehnologie | Cine | Unde |
|---|---|---|---|
| Cluster, TLS, storage-uri, izolare, observabilitate, alerte, deploy | k3s, Traefik, cert-manager, SeaweedFS, pure-ftpd, Postgres 17, Prometheus/Grafana/Loki/Alloy, Helm | P1 Gabi | `deploy/`, `scripts/`, `mk/`, `Makefile`, `README.md` |
| API-ul backend | NestJS 12, TypeScript, Kysely + pg, Zod 4, pino, prom-client | P2 (tu) | `backend/src/` |
| Adaptoarele de storage, criptarea | portare în TypeScript a designului P1: S3 (SigV4), FTP, DB; FGE1 AES-256-GCM | design P1, portare P2 | `backend/src/storage/`, `backend/src/crypto/` |
| Simulatorul de contoare | TypeScript fără dependențe (Node 26) | P2 | `simulator/` |
| Frontend | Next.js 16 App Router, React, TanStack Query, openapi-fetch, mock-uri MSW, Tailwind 4, Radix | P3 Mihail (+ Gabi) | `frontend/` |
| Contractul | REST sub `/api/v1`; documentul OpenAPI la `/api/v1/docs-json` | P2 | `docs/api.md`, `backend/src/docs/openapi.json` |

**O singură comandă:** `sudo make up` pe un Ubuntu curat. Instalează k3s, TLS, storage-urile și
observabilitatea, construiește și pornește aplicația și generează toate secretele. Rulată a doua oară, nu
schimbă nimic.

---

## 4. Viața unui fișier (învățați acest flux; răspunde la jumătate din întrebări)

1. **Politica.** Interfața citește `GET /policies`; backend-ul citește politica live din Postgres la fiecare
   operație (`backend/src/policies/`). Valorile implicite:

   | Categorie | Principal → rezervă | Criptat | Dimensiunea unei bucăți | Dimensiune maximă |
   |---|---|---|---|---|
   | meter_readings | db → s3 | nu | 1 MiB | 16 MiB |
   | fault_records | s3 → db | nu | 5 MiB | 512 MiB |
   | connection_documents | s3 → db | **da (obligatoriu)** | 5 MiB | 50 MiB |
   | drone_videos | ftp → s3 | nu | 16 MiB | 4 GiB |

2. **Crearea.** `POST /uploads` cu un `Idempotency-Key` și metadate validate cu Zod. La documentele de
   racordare, numele și CNP-ul sunt sigilate cu cheia de criptare a cheilor (KEK); se păstrează doar valorile
   mascate.
3. **Bucățile.** Browserul calculează SHA-256 al fișierului într-un Web Worker, îl taie cu `Blob.slice` și
   trimite `PUT /uploads/{id}/parts/{n}` cu `X-Part-SHA256`, mai multe în paralel. Fiecare bucată trece direct
   în storage-ul politicii, ca `staging/{uploadId}/{n}`. Nimic nu e ținut întreg în memorie și nimic nu trece
   prin Next.js.
4. **Finalizarea.** `POST /uploads/{id}/complete` trimite SHA-256 calculat de client. Serverul recitește
   bucățile în ordine, le calculează hash-ul, criptează dacă politica cere și scrie obiectul final (pe
   storage-ul de rezervă dacă cel principal e căzut). Confirmă doar dacă cele două hash-uri coincid
   (`verdict: match`). Pentru fișierele mari răspunde `202`, iar clientul revine să întrebe.
5. **Descărcarea.** `GET /files/{id}/content` recalculează SHA-256 în timpul citirii. Un fișier mic e verificat
   înainte de primul octet trimis (`409 FILE_CORRUPT`); la unul mare conexiunea se întrerupe dacă hash-ul iese
   greșit. În ambele cazuri fișierul e marcat corupt.
6. **Trasarea.** Fiecare răspuns are `X-Trace-Id`. `GET /traces/{id}` arată `api → policy → encryption →
   storage.put → audit → confirm`, cu durate.
7. **Auditul.** Fiecare încărcare, descărcare, verificare, afișare a datelor personale și modificare de
   politică se înregistrează (`GET /audit-events`).
8. **Curățenia.** O încărcare abandonată expiră după 24 h, iar o curățare periodică îi șterge bucățile.

Codul pentru acest flux: `backend/src/uploads/uploads.service.ts`, `upload-assembler.ts`,
`backend/src/object-store/object-store.service.ts`, `backend/src/files/download.service.ts`,
`frontend/src/lib/upload/` (motorul de încărcare, planificatorul, worker-ul SHA-256).

---

## 5. Fiecare cerință din enunț, explicată

Enunțul (`docs/brief/FileGrid_PPC.pdf`, 4 pagini) are 28 de cerințe: 4 cerințe de business, 8 funcționale,
13 nefuncționale și 3 întrebări de statistică. Fiecare intrare citează enunțul, apoi spune ce înseamnă, cum o
îndeplinește FileGrid și ce arătăm live.

### §1–§2 · Contextul și ce construim

- **„FileGrid este punctul de intrare pentru toate aceste date. Fișierele nu sunt preluate din alte sisteme, ci
  intră direct în aplicație.”** Nu importăm fișiere vechi: fiecare fișier intră prin API-ul nostru, deci are
  de la primul octet o politică, un hash, o trasare și o intrare în audit.
- **„Video-urile, înregistrările de avarie și documentele de racordare sunt adăugate de utilizatori (echipe de
  teren, dispecerat, angajații care procesează racordări) din interfață.”** Sunt trei dintre cele cinci roluri
  ale noastre (teren, dispecerat, racordări). Fiecare vede doar categoriile lui, iar regula e impusă de API,
  nu doar ascunsă în interfață.
- **„Citirile de contor sunt trimise automat … de contoarele inteligente, pe care trebuie să le simulați
  voi.”** `simulator/` joacă rolul a mii de contoare și trimite loturi la `POST /api/v1/meter-readings`, cu o
  cheie de API.
- **„FileGrid decide, pe baza unei politici per categorie de date, unde și cum se scrie fiecare fișier,
  verifică integritatea lui și măsoară tot ce se întâmplă.”** Fraza conține tot designul: motorul de politici
  (unde și cum), verificările SHA-256 (integritatea), plus Prometheus, trasările și statisticile (măsurăm tot).

### §2.1 · Cele patru cerințe de business

| Categorie | Cerința | Ce înseamnă | Cum o îndeplinim | Ce arătăm |
|---|---|---|---|---|
| Citiri contoare | „Nicio citire nu se pierde și nu se dublează (altfel facturile sunt greșite)” | fiecare citire se salvează exact o dată, chiar dacă contorul reîncearcă | `readingId` e unic în baza de date: o reîncercare e confirmată ca duplicat și nu se mai salvează; `pierdute = trimise − confirmate − în coadă`, raportat de simulator; alertele `MeterReadingsLost`, `MeterReadingsDuplicateStored` | Contoare live: primite / unice / duplicate respinse / pierdute 0 |
| Înregistrări de avarie | „Disponibile imediat pentru dispecerat” | o fișă de avarie se poate citi la câteva secunde după încărcare, chiar și în timpul unei furtuni | bucăți mici, disponibilă imediat ce cele două hash-uri coincid; fiecare încărcare răspunde cu `availableAfterMs`; izolarea pe categorii împiedică restul traficului s-o încetinească; alerta `FaultUploadsSlow` | încărcare ca dispecerat: „disponibil în X s”, apare live în Fișiere |
| Documente de racordare | „Datele personale rămân protejate și verificabile la audit” | datele personale nu pot fi citite fără drept, iar fiecare acces lasă urmă | criptare AES-256-GCM obligatorie la stocare; numele și CNP-ul sigilate în baza de date, mascate în interfață; doar auditorul le afișează (cu motiv, 60 s), iar fiecare afișare apare în jurnalul de audit | detaliul fișierului (mascat), afișarea, Jurnal de audit |
| Video-uri inspecții dronă | „Transferul rezistă pe conexiuni lente sau instabile” | o încărcare de 1 GB pe o legătură mobilă proastă tot se termină | încărcare reluabilă în bucăți de 16 MiB, fiecare reîncercată cu pauze crescătoare (cam 15–30 de minute înainte să ceară un clic), reluare după deconectare sau reîncărcarea paginii, din IndexedDB; alerta `VideoTransfersFailing` | DevTools offline → online → F5 în timpul unei încărcări |

### §3 · Cerințe funcționale minime („Fără acestea, proiectul nu intră în evaluare”)

1. **„FileGrid stochează și recuperează fișiere din toate cele patru categorii.”** Încărcarea și descărcarea
   merg pentru toate patru (citirile de contor se salvează în loturi, un fișier pe lot, vizibile în Fișiere).
   Arătăm: Încărcare, apoi Fișiere cu filtrul de categorie.
2. **„Fiecare dintre cele trei tipuri de storage (FTP, S3, bază de date) este folosit efectiv și rulează ca
   serviciu separat. S3 poate fi emulat local.”** Trei StatefulSet-uri în namespace-ul lor: PostgreSQL 17,
   SeaweedFS (compatibil S3, „emularea locală”), pure-ftpd. Politicile implicite le folosesc pe toate trei
   (video-urile pe FTP, avariile și documentele pe S3, citirile în baza de date). Arătăm: „Stocat pe …” pe un
   fișier și banda de stare a storage-urilor.
3. **„Politica per categorie de date este configurabilă, fără modificarea codului.”** Politicile stau în
   Postgres, cu versiuni; adminul le modifică din Politici (storage principal, de rezervă, criptare, dimensiunea
   bucății, paralelism, dimensiune maximă, tipuri permise); următoarea operație le citește live. Arătăm:
   mutăm avariile pe FTP, încărcăm una, fișierul spune „Stocat pe FTP · politica vN”.
4. **„Fișierul recuperat este identic cu cel stocat, iar FileGrid poate demonstra asta.”** SHA-256 în browser și
   pe server la încărcare (ambele afișate), recalculat la fiecare descărcare și la cerere (verificare).
   Dovedim și invers: camera de control schimbă un octet, iar următoarea citire detectează. Arătăm:
   hash-urile din detaliul fișierului, Corupe fișierul → „Corupție detectată”.
5. **„Întregul sistem pornește pe o mașină curată cu o singură comandă, urmând README-ul.”** `sudo make up`
   instalează k3s, TLS, storage-urile, observabilitatea și aplicația, construiește imaginile și generează toate
   secretele; rulată din nou, nu schimbă nimic. Arătăm: secțiunea Quickstart din README.
6. **„Există o interfață din care utilizatorii încarcă, caută și descarcă fișiere din categoriile încărcate
   manual.”** Interfața Next.js: Încărcare (categorie, metadate, trage și plasează, coadă), Fișiere (căutare,
   filtre după categorie, zonă, interval, integritate), descărcare cu verificarea hash-ului. Arătăm: cele trei
   ecrane.
7. **„Există un simulator de contoare inteligente care trimite continuu citiri … cu volum configurabil, ca să
   puteți reproduce și o zi normală, și una de vârf.”** Moduri: normal, vârf (×10), ritm personalizat și oprit,
   setate din camera de control sau prin `PUT /meters/simulator`; trimite intenționat și reîncercări și
   duplicate, ca să dovedească eliminarea dublurilor. Arătăm: Contoare live, Pornește furtuna.
8. **„Tot codul (aplicația, simulatorul, configurațiile și scripturile) este urcat în repository-ul Git.”**
   `backend/`, `frontend/`, `simulator/`, `deploy/`, `scripts/`, `mk/`, `infra/` sunt toate în repository; doar
   fișiere `.env.example`, niciun secret.

### §4 · Cerințe nefuncționale („La demo trebuie să puteți arăta live că sunt respectate”)

**Scalabilitate**
- **„Un vârf de 10 ori peste volumul normal într-o singură categorie … nu degradează celelalte categorii.”**
  Fiecare categorie are propriul compartiment (un buget de operații simultane, din politică); când e plin, doar
  acea categorie primește `503 CATEGORY_BUSY`. Arătăm: furtună ×10 pe citiri, în timp ce graficul din
  Observabilitate ține celelalte categorii pe loc. (Butonul de furtună acționează pe citiri; izolarea
  funcționează la fel pentru orice categorie.)
- **„Capacitatea crește prin adăugarea de instanțe, fără modificări de cod.”** Backend-ul nu are stare proprie
  (sesiunile, încărcările și fișierele stau în Postgres și în storage-uri), evenimentele live trec între
  replici prin Postgres LISTEN/NOTIFY, iar o singură replică e aleasă să evalueze cerințele de business. HPA
  rulează 1–3 replici după CPU. Arătăm: `kubectl get hpa,pods` (povestit: la încărcarea din demo, CPU-ul rămâne
  mic).
- **„Fișierele de peste 1 GB sunt procesate fără ca resursele serviciului să crească proporțional cu
  dimensiunea fișierului.”** Totul curge în flux: browserul taie fișierul, serverul scrie bucățile direct în
  storage și le recitește în flux la finalizare. Măsurat pe VPS: 1.126 MiB, memoria procesului node +29 MiB
  cel mult. Arătăm: TASKS.md, „1 GB proof”.

**Observabilitate**
- **„Pentru fiecare categorie și fiecare storage se văd latența (p50, p95, p99), throughput-ul și rata de
  erori.”** Metrici Prometheus etichetate după categorie, storage și operație; matricea de 12 celule
  (`GET /metrics/matrix`) și un dashboard Grafana. Arătăm: Observabilitate.
- **„O singură operație poate fi urmărită de la cererea inițială până la storage.”** Un ID de urmărire la
  fiecare răspuns; `GET /traces/{id}`: api → policy → encryption → storage → audit, cu durate; fiecare bucată a
  unei încărcări are propria trasare; logurile din Loki se caută după `trace_id`. Arătăm: trasarea unui fișier.
- **„Echipa este anunțată automat când o cerință de business din tabelul 2.1 e în pericol.”** La fiecare 15 s
  backend-ul evaluează cele patru cerințe (ok, în pericol, încălcată) și înregistrează alertele; regulile
  Prometheus (`MeterReadingsLost`, `FaultUploadsSlow`, `VideoTransfersFailing`, `FileGridStorageDown`…) ajung în
  Alertmanager. Arătăm: ecranul principal în timpul furtunii sau cu S3 oprit. (Webhook-ul către un chat nu e
  conectat încă.)

**Securitate**
- **„Storage-urile nu sunt accesibile direct din afara sistemului; singura cale de acces este FileGrid.”**
  Doar servicii ClusterIP și o NetworkPolicy care refuză tot în afară de podurile backend;
  `make storage-isolation-check` trece 30/30; niciun răspuns al API-ului nu conține URL, bucket sau cale de
  storage.
- **„Traficul din exterior este criptat, iar accesul la FileGrid este autentificat.”** Doar HTTPS (Let's Encrypt
  prin cert-manager, Cloudflare Full strict, HSTS); autentificare cu un cookie de sesiune `HttpOnly`, `Secure`,
  `SameSite=Strict`, un antet anti-CSRF și cinci roluri. Autentificarea fără parolă există doar în modul demo.
- **„Un acces neautorizat direct la storage nu expune datele personale din documentele de racordare.”** Chiar
  cu octeții bruți din S3 sau din baza de date, un atacator vede doar text criptat: plicul FGE1 (o cheie per
  obiect, sigilată cu KEK); numele și CNP-ul sunt sigilate separat. Arătăm: „criptat la stocare” pe un document
  de racordare.
- **„Nicio parolă sau cheie nu se află în repository.”** `make up` generează toate secretele în Secret-uri k3s;
  repository-ul are doar exemple `.env.example`; chiar și testele își generează parolele aleatoriu.

**Reziliență**
- **„Căderea unui storage nu oprește celelalte categorii și nu duce la pierderea fișierelor deja confirmate.”**
  Storage-ul de rezervă al politicii preia scrierile, un circuit breaker nu mai apelează storage-ul căzut, iar
  celelalte categorii merg mai departe. Un fișier e „confirmat” doar după o scriere durabilă cu hash-ul corect,
  iar storage-urile își țin datele pe volume persistente, deci nimic confirmat nu se pierde. Arătăm: Oprește
  S3, încărcăm o avarie (ajunge pe rezervă), Pornește S3.
- **„Pe o conexiune cu latență mare și pierdere de pachete, transferurile se finalizează sau se reiau, fără
  intervenție manuală.”** Bucăți cu reîncercări și pauze crescătoare, reluare după o deconectare sau
  reîncărcarea paginii; testat cu `tc netem` (latență și pierdere de pachete) pe podul backend real
  (`make chaos-netem-on`). Arătăm: DevTools offline.
- **„Reîncercările nu dublează citirile de contor, iar un fișier corupt este detectat la recuperare.”** Același
  `readingId` se salvează o singură dată (simulatorul reîncearcă intenționat, iar contoarele arată duplicatele
  respinse). Fiecare descărcare recalculează hash-ul: un fișier mic corupt răspunde `409 FILE_CORRUPT`, unul
  mare e întrerupt, iar fișierul e marcat corupt. Arătăm: Contoare live; Corupe fișierul.

### §5 · Statistici și interpretarea datelor

Enunțul cere statistici care ajută pe cine ia decizii și spune că interpretarea contează mai mult decât numărul
de grafice. Fiecare statistică întoarsă de noi are o propoziție în română, o recomandare și faptele pe care se
bazează.
- **„Ce tip de storage se potrivește cel mai bine fiecărei categorii de date și de ce?”** Din jurnalul de
  operații: latența, throughput-ul și erorile pe categorie și storage, cu storage-ul recomandat și motivul.
  Arătăm: Statistici → „Ce storage se potrivește fiecărei categorii?”.
- **„Cum s-a comportat sistemul într-o zi de vârf, comparativ cu una normală?”** Furtunile se înregistrează ca
  perioade; ecranul compară o perioadă de vârf cu una normală (volum, latență, erori, citiri pierdute). Arătăm:
  Statistici → „Zi normală vs. zi de vârf”, imediat după momentul cu furtuna.
- **„Ce spun datele însele despre rețea (de exemplu, tipare sau anomalii în citirile de contor, zonele cu cele
  mai multe avarii)?”** Avariile pe zone, vârful de consum pe ore și contoarele anormale (citire zero sau peste
  de 5 ori media zonei). Arătăm: Statistici → „Ce spun datele despre rețea” și harta live (secțiunea 14).

### §6 · Stack-ul tehnologic recomandat

„Tehnologiile din tabel sunt recomandări … Arhitectura și designul sistemului sunt în întregime decizia
voastră.” Față de tabel: **backend** NestJS în loc de Spring Boot, **frontend** Next.js în loc de Angular
(TypeScript peste tot: un singur limbaj pentru toată echipa); **infrastructură** imagini Docker pe k3s, o
distribuție Kubernetes certificată (ca în recomandare); **observabilitate** Grafana, Loki și Prometheus (ca în
recomandare); **bază de date** PostgreSQL (una dintre cele trei opțiuni).

---

## 6. Mecanismele, pe scurt

- **Motorul de politici:** un rând pe categorie, cu versiune. O salvare trebuie să trimită versiunea curentă
  (`baseVersion`), altfel primește `409`, fiindcă altcineva a salvat între timp. Fiecare versiune și diferențele
  ei se păstrează și intră în audit.
- **Încărcarea reluabilă:** serverul nu ține nicio încărcare în memorie. Bucățile stau în storage, iar sesiunea
  în Postgres, deci orice replică poate prelua următoarea bucată, iar o reîncărcare a paginii continuă de la
  ultima bucată confirmată.
- **Trei hash-uri:** unul pe bucată (`X-Part-SHA256`), unul pe tot fișierul la finalizare (client contra
  server) și încă unul la fiecare descărcare sau verificare.
- **Criptarea (FGE1):** o cheie de date nouă pentru fiecare obiect, AES-256-GCM în segmente de 64 KiB, cheia de
  date sigilată cu KEK (`FILEGRID_KEK`). Documentele de racordare nu pot fi stocate necriptate.
- **Rezervă + circuit breaker:** dacă storage-ul principal cade sau e știut căzut, scrierea merge pe rezerva
  din politică. Circuit breaker-ul nu mai apelează un storage căzut și verifică periodic dacă și-a revenit.
- **Izolarea pe categorii (bulkhead):** fiecare categorie are propriul buget de operații simultane, așa că o
  furtună de încărcări de avarii nu poate bloca video-urile sau documentele.
- **Fără citiri dublate:** citirile vin în loturi, iar fiecare `readingId` se salvează o singură dată; o citire
  retrimisă e confirmată ca duplicat. `pierdute = trimise − confirmate − în coadă`, raportat de simulator,
  trebuie să rămână 0.
- **Cerințele de business:** la fiecare 15 s replica aleasă evaluează cele patru cerințe (ok, în pericol,
  încălcată) și înregistrează fiecare schimbare ca alertă. Interfața le arată live prin Server-Sent Events
  (`GET /stream`).
- **Rolurile:** teren, dispecerat, racordări, auditor, admin (o matrice de drepturi). Doar **auditorul** poate
  afișa datele personale: 60 de secunde, cu un motiv, cu audit. Adminul nu poate; separarea e intenționată.

---

## 7. Cifre de citat

| Fapt | Valoare |
|---|---|
| Dovada pentru 1 GB (VPS) | 1.126 MiB în 71 de bucăți de 16 MiB: încărcare 15,9 s, verificare și stocare 22,4 s, descărcare 14,5 s, SHA-256 identic, **memoria node +29 MiB cel mult** (bugetul: +64 MiB) |
| Citiri de contor, furtună pe VPS | ×10 (aproximativ 100 de citiri/s, ~5 min): 0 pierdute, 0 duplicate salvate, 0 erori de server |
| Verificarea izolării storage-urilor | 30/30 |
| Teste automate | backend 286 (Postgres încorporat, teste reale de protocol S3/FTP), simulator 88, teste unitare frontend (vitest) |
| Consum de resurse | gândit pentru un VPS cu 4 GB și 2 nuclee; fiecare container are limite de memorie (backend 384 Mi) |

---

## 8. Demo-ul de 7 minute (tabelul complet, cu variante de rezervă: `docs/frontend/demo-script.md`)

1. **0:00** Autentificare ca admin → Garanții de business: 4 carduri, banda de stare a storage-urilor, contorul
   de citiri live.
2. **0:30** Echipă de teren: încărcăm un video de dronă; DevTools offline → online → F5; încărcarea se reia;
   SHA-256 verificat.
3. **1:45** Dispecerat: încărcăm o fișă de avarie; e disponibilă în câteva secunde și apare live în Fișiere.
4. **2:30** Angajat racordări: încărcăm un document de racordare (mascat). Auditor: afișăm datele cu un motiv →
   apare în Jurnalul de audit.
5. **3:15** Admin, Cameră de control: pornim o furtună ×10, oprim S3 → celelalte categorii rămân pe loc,
   încărcările merg pe rezervă, pornește o alertă; pornim din nou S3 → revenire.
6. **4:30** Corupem un fișier → „Corupție detectată”; deschidem o trasare (api → policy → storage → audit).
7. **5:30** Politică live: avariile S3 → FTP; următoarea încărcare spune „Stocat pe FTP · politica vN”.
8. **6:00** Statistici (S1, S2, S3) și Harta live.

Înainte de demo: `npm run seed:demo` (în `backend/`) după deploy-ul final și simulatorul pe ritm normal.
După demo: Resetează demo-ul, avariile înapoi pe S3 și autentificarea fără parolă oprită.

---

## 9. Întrebări pe care le poate pune juriul

- **De ce trei storage-uri și nu unul?** Enunțul cere ca FTP, S3 și DB să fie folosite efectiv. Lăsăm datele să
  decidă: S1 compară latența și potrivirea pe categorie și recomandă unul.
- **Ce se întâmplă dacă S3 cade în timpul demo-ului?** Rezerva din politică preia scrierile, circuit
  breaker-ul izolează S3 și pornește o alertă. Un fișier confirmat nu se pierde niciodată, fiindcă e confirmat
  doar după o scriere durabilă cu hash-ul corect.
- **Cum dovediți că fișierul e același?** Browserul și serverul calculează fiecare SHA-256 la încărcare, iar
  serverul îl recalculează la fiecare descărcare. Un singur octet schimbat e detectat, și o arătăm live.
- **Un fișier de 1 GB pe un server mic?** Nimic nu e ținut întreg. Browserul taie fișierul, iar serverul trimite
  bucățile în flux spre storage și le recitește în flux la finalizare. Măsurat: +29 MiB pentru 1,1 GiB.
- **Cum scalați?** Backend-ul nu are stare proprie (ea stă în Postgres și în storage-uri), deci HPA adaugă
  replici, iar izolarea pe categorii împiedică vârful unei categorii să le afecteze pe celelalte.
- **Cine vede datele personale?** Implicit, nimeni: sunt mascate peste tot și criptate la stocare. Doar
  auditorul le poate afișa, cu un motiv, 60 de secunde, iar afișarea intră în audit.
- **Poate cineva ajunge la un storage din internet?** Nu: doar ClusterIP, plus o NetworkPolicy care blochează tot
  în afară de backend. API-ul nu întoarce niciodată un URL, bucket sau cale de storage.
- **Citiri dublate când un contor reîncearcă?** `readingId` e cheia de idempotență. Reîncercarea e confirmată ca
  duplicat și nu se salvează de două ori, iar contoarele o arată.
- **Cum știți că o cerință de business e în pericol?** E evaluată la fiecare 15 s din metrici reale, iar alertele
  apar în Alertmanager și pe ecranul principal.
- **De ce NestJS, Next.js și k3s?** Secțiunea §6 a enunțului doar recomandă un stack. Al nostru e TypeScript peste
  tot (un singur limbaj pentru echipă), iar k3s ne dă replici, izolare și deploy cu o singură comandă pe un
  singur VPS.

---

## 10. Traseu de învățare (cam 2 ore, în această ordine)

1. `docs/brief/FileGrid_PPC.pdf`, §2–§5: cerințele. 15 min
2. `README.md`: arhitectura, `make up`, izolarea storage-urilor, contractele pentru P2/P3. 15 min
3. `docs/api.md`: autentificare, politici, încărcarea reluabilă, fișiere, contoare, trasări, fluxul live,
   endpoint-urile demo. 25 min
4. Fluxul din backend: `uploads.service.ts` → `upload-assembler.ts` → `object-store.service.ts` →
   `download.service.ts`; apoi `policies/`, `meters/meters.service.ts`, `guarantees/`. 30 min
5. Frontend-ul: `frontend/src/lib/upload/` (motorul, worker-ul), `features/upload`, `features/files`,
   `features/demo`, `features/map`. 20 min
6. `TASKS.md`: „P2 status”, „P2 parallel tasks” (cu dovada pentru 1 GB) și „State on 15.11” (ce e gata și ce a
   rămas). 10 min
7. Parcurgeți demo-ul o dată pe site-ul live sau pe mock-uri: `cd frontend && npm run dev`. 15 min

---

## 11. Echipa

- **P1 Gabi:** platforma k3s, TLS, storage-urile și izolarea, observabilitatea și alertele, scripturile de
  haos, deploy-ul, întărirea securității, harta live; deploy-urile finale și unirea branch-urilor.
- **P2 (tu):** backend-ul NestJS (politici, încărcare reluabilă, integritate, portarea criptării, contoare,
  trasări, audit, cerințe de business și alerte, statistici, endpoint-urile demo, `docs-json`), simulatorul,
  dovada pentru 1 GB, datele demo.
- **P3 Mihail:** frontend-ul Next.js (cadrul aplicației, motorul de încărcare, fișiere, politici, audit,
  monitorizare, statistici, camera de control), sistemul de design și curățenia frontend-ului.

---

## 12. Limite asumate (spuneți-le înainte să le găsească altcineva)

- Furtunile se simulează doar pentru citirile de contor.
- La 100 de citiri/s backend-ul folosește cam 39% CPU, deci HPA nu scalează în timpul demo-ului; scalarea se
  povestește.
- Criptarea Secret-urilor k3s la stocare e pregătită (`make k3s-secrets-encrypt`), dar nu e pornită, fiindcă
  repornește k3s.
- Alertele nu ajung încă într-un chat (fără webhook Discord/Telegram); se văd în interfață și în Alertmanager.
- Autentificarea fără parolă e doar pentru demo; se oprește după aceea.
- Testele Playwright end-to-end au fost șterse la curățenia frontend-ului (PR #12) și nu există încă un video de
  rezervă al demo-ului. Comenzile de repetiție de la finalul `docs/frontend/demo-script.md` se referă la acel
  test șters.

---

## 13. Comenzi utile

```
# deploy și stare (pe VPS)
sudo make up                 # tot sistemul, idempotent
make status                  # poduri, certificat, URL-uri
make storage-isolation-check # storage-urile nu sunt accesibile din afară

# date demo și dovezi (în backend/)
FILEGRID_URL=https://ppc.filegrid.cc.cd npm run seed:demo
node scripts/proof-1gb-upload.ts                     # dovada pentru 1 GB (vezi TASKS.md)

# dezvoltare locală
cd backend && npm ci && npm test                     # 286 de teste, Postgres încorporat
cd simulator && node --test test/                    # 88 de teste
cd frontend && npm ci && npm run dev                 # interfața pe mock-uri la :3000
cd frontend && npm test                              # teste unitare (vitest)
```

---

## 14. Ideea noastră originală: harta live a rețelei („Hartă live”)

Enunțul cere statistici, nu cere o hartă. Am adăugat-o fiindcă un om care ia decizii la Rețele Electrice
gândește în locuri, nu în tabele: unde are rețeaua probleme chiar acum? Harta transformă a treia întrebare din
§5 („ce spun datele despre rețea”) într-o singură imagine live, ecranul pe care îl puteți lăsa pe proiector cât
vorbiți.

**Ce arată** (`/map`, în meniu „Hartă live”): o hartă a României pe județe, cu cele trei zone de distribuție
Rețele Electrice (Muntenia Sud, Banat, Dobrogea) și patru straturi care se pot porni și opri:
- **Consum mediu:** fiecare zonă colorată după consumul mediu pe citire din ora curentă.
- **Avarii:** un punct roșu pentru fiecare fișă de avarie; pulsează dacă a fost raportată în ultimele 10 minute.
- **Contoare anormale:** un romb pentru fiecare contor anormal (citire zero sau un vârf de peste 5 ori media
  zonei).
- **Citiri live:** scântei acolo unde sosesc citiri chiar acum, câte una pentru fiecare citire din ritmul live al
  zonei; în timpul unei furtuni se înmulțesc și apare insigna „FURTUNĂ · VÂRF ×10”.

Lângă hartă: totalul citirilor (unice, pierdute, duplicate respinse, citiri pe secundă), avariile din ultimele
24 h, anomaliile, ultimele avarii raportate și interpretarea „Ce spun datele”.

**Cum funcționează:** sunt aceleași date reale ca în restul aplicației, doar desenate pe hartă. Citește
`GET /meters/counters`, `GET /statistics/grid-insights`, `GET /files?category=fault_records` și
`GET /meters/simulator` și se actualizează live, ca celelalte ecrane de monitorizare. Harta e un SVG desenat de
noi, fără plăci de hartă și fără cheie de API, deci merge și fără internet la locul prezentării și nu trimite
date unui furnizor de hărți. Avariile și contoarele au o zonă, nu o adresă exactă, așa că fiecare e plasată pe un
județ fix al zonei ei; aceeași avarie apare mereu în același loc. Codul: `frontend/src/features/map/LiveMapScreen.tsx`.

**De ce contează pentru juriu:** arată trei cerințe de business și statisticile rețelei pe un singur ecran.
Avariile apar pe hartă la câteva secunde după încărcare (disponibile imediat pentru dispecerat). Contoarele țin
„pierdute 0” în timp ce scânteile furtunii zboară (nicio citire pierdută sau dublată). Zonele colorate și
anomaliile răspund la „ce spun datele despre rețea” fără să citești un singur grafic.

**Cum o folosim în demo:** o deschidem la momentul 1 (scântei live, zero pierdute), revenim în timpul furtunii la
momentul 5 (insigna, scânteile se înmulțesc) și încheiem cu ea la momentul 8, după statistici. Încărcați o avarie
în Banat la momentul 3, și pe hartă pulsează un punct roșu în Banat.

**Limite de spus cu voce tare:** pozițiile sunt pe zone, nu coordonate GPS reale; consumul și anomaliile vin de la
contoarele simulate.
