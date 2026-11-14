# FileGrid PPC

Platformă care rutează fișierele încărcate către FTP, S3 sau baza de date, în funcție de categoria datelor. Cerințele: [docs/brief/FileGrid_PPC.pdf](docs/brief/FileGrid_PPC.pdf). Împărțirea pe echipă: [TASKS.md](TASKS.md).

> Stare: rulează platforma (k3s + HTTPS), storage-urile și observabilitatea. Backend-ul (NestJS, `backend/`) și simulatorul de contoare (`simulator/`) au `Dockerfile`, deci `make up` le construiește și le pornește; frontend-ul (`frontend/`) nu are încă imagine, iar pe `/` rămâne pagina placeholder.

## Arhitectură

```
Internet ──HTTPS──▶ Traefik (k3s; Let's Encrypt prin cert-manager; HTTP → HTTPS)
                      └─▶ aplicația FileGrid               namespace filegrid
                            └─▶ PostgreSQL · S3 · FTP      namespace filegrid-storage (ClusterIP)
```

- Pe VPS rulează o singură platformă: k3s. Storage-urile sunt StatefulSet-uri cu volume persistente (`local-path`: Postgres 5Gi, S3 20Gi, FTP 5Gi) și nu au niciun port deschis în afara clusterului. `local-path` nu impune dimensiunile: volumele sunt directoare pe discul rădăcină comun; S3 se oprește singur la 20 GiB (SeaweedFS: 80 de volume × 256 MB), Postgres și FTP nu au plafon propriu.
- NetworkPolicy: în `filegrid-storage` orice trafic de intrare e refuzat, cu excepția podurilor din namespace-ul `filegrid` care au eticheta `filegrid.io/storage-client: "true"` (doar pe porturile serviciilor: 5432, 8333, 21 și 21000-21019), plus Job-ul `s3-init` din același namespace, către S3:8333. `make storage-isolation-check` demonstrează asta live, inclusiv că porturile interne SeaweedFS (8080, 8888, 9333) rămân închise și că S3 fără semnătură primește 403.
- S3 = SeaweedFS (MinIO nu mai este distribuit de la sfârșitul lui 2025); FTP = pure-ftpd; PostgreSQL 17.
- Docker Compose (`infra/`) e doar pentru dezvoltare pe laptop; pe VPS nu rulează.

## Quickstart

### VPS sau Ubuntu curat (k3s)

Cerințe: Ubuntu 24.04 cu acces root (sau sudo), `git` și `make`; minimum 2 vCPU, 4 GB RAM și 30 GB disc; acces HTTPS de ieșire către `get.k3s.io` și `github.com` (k3s), `raw.githubusercontent.com` și `get.helm.sh` (Helm), `charts.jetstack.io` și `quay.io` (cert-manager), `docker.io` (imaginile storage-urilor) și API-ul ACME Let's Encrypt.

Doar pentru certificatul public Let's Encrypt mai trebuie: porturile 80 și 443 accesibile din Internet și înregistrarea DNS A `ppc.filegrid.cc.cd` → IP-ul mașinii (sau alt domeniu, vezi mai jos). Fără ele `make up` se termină normal, iar aplicația răspunde local cu certificatul implicit al Traefik: `curl -k --resolve ppc.filegrid.cc.cd:443:127.0.0.1 https://ppc.filegrid.cc.cd/` (sau o intrare în `/etc/hosts` pe mașina de pe care testați; `make status` afișează indiciul cât timp certificatul nu e emis).

Firewall: k3s ascultă pe toate interfețele și pe 6443 (API), 10250 (kubelet), pe NodePort-urile Traefik (din 30000-32767, `kubectl -n kube-system get svc traefik`) și, pe VPS-ul existent, pe 8472/udp (VXLAN flannel; o instalare nouă folosește `host-gw`, fără acest port). Scripturile nu modifică firewall-ul gazdei, deci în firewall-ul / security group-ul furnizorului VPS permiteți la intrare doar 22, 80 și 443 (plus 6443 doar de la IP-ul unui admin, dacă e nevoie).

```bash
sudo apt-get update && sudo apt-get install -y git make   # dacă lipsesc
git clone <url-repo> file-grid-ppc && cd file-grid-ppc
sudo make up
```

`make up` instalează doar ce lipsește: `curl`, `openssl`, `jq`, `ca-certificates` (apt), k3s `v1.37.2+k3s1` (versiunea testată, cu `--flannel-backend=host-gw` și `--secrets-encryption`; altă versiune: `sudo make up K3S_VERSION=...`, ultima din canal: `K3S_CHANNEL=stable`; un k3s existent nu e reinstalat), Helm `v3.22.1` (scriptul de instalare luat de la același tag). Apoi pornește storage-urile (`make k8s-storage-up`), cert-manager, Traefik (redirect HTTP→HTTPS, limite) și placeholder-ul (`make k8s-tls-up`) și afișează starea (`make status`). Comanda e idempotentă: la a doua rulare `kubectl` raportează `unchanged` și nu repornește nimic. Parolele sunt generate o singură dată în Secret-ul Kubernetes `filegrid-storage-credentials` și nu ajung niciodată în git.

Comenzi utile (ca root, kubeconfig-ul k3s are mod 600; `make` folosește `KUBECONFIG=/etc/rancher/k3s/k3s.yaml`, setați-l la fel pentru `helm` rulat de mână):

```bash
make status                    # poduri, certificat, adrese
make storage-isolation-check   # demo: doar podul etichetat din filegrid ajunge la storage-uri
make tls-status                # certificatul Let's Encrypt
make tls-retry                 # re-declanșează emiterea după ce DNS-ul indică mașina
```

Alt domeniu: `sudo make up DOMAIN=exemplu.ro` (se substituie în Ingress la aplicare; înregistrarea DNS A trebuie să indice mașina). `DOMAIN` nu e salvat: dați-l la fiecare rulare (`make up`, `make k8s-tls-up`), altfel Ingress-ul revine la `ppc.filegrid.cc.cd`; pentru o schimbare permanentă modificați valoarea implicită din `Makefile`.

### Laptop (dezvoltare, Docker Compose)

Cerințe: Docker Engine cu pluginul Compose v2, `make`, `openssl`; porturile 5432, 9000, 8888, 21 și 21000-21019 libere pe `127.0.0.1`.

```bash
make infra-up     # generează infra/.env (o singură dată) și pornește PostgreSQL, S3, FTP
make infra-ps     # starea serviciilor
make infra-logs   # loguri
make infra-down   # oprește serviciile (datele rămân în volume)
```

Pe acest stack se testează adaptorii de storage. Porturile sunt legate doar la `127.0.0.1`; secretele sunt în `infra/.env` (ignorat de git), cu aceleași chei ca Secret-ul din k3s, plus adresele storage-urilor (`FILEGRID_*`, ca în ConfigMap-ul din k3s). Un `infra/.env` creat înainte de aceste chei nu le are: copiați-le din `infra/.env.example`.

## Conectarea aplicației la storage-uri

În k3s, un pod al aplicației ajunge la storage-uri doar dacă rulează în namespace-ul `filegrid` și are eticheta `filegrid.io/storage-client: "true"`. Credențialele vin din Secret-ul `filegrid-storage-credentials`, copiat și în namespace-ul `filegrid`, cu cheile `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `FTP_USER`, `FTP_PASSWORD`. Adresele vin din ConfigMap-ul `filegrid-storage-endpoints` (tot în `filegrid`), cu cheile `FILEGRID_PG_HOST`, `FILEGRID_PG_PORT`, `FILEGRID_S3_ENDPOINT`, `FILEGRID_FTP_HOST`, `FILEGRID_FTP_PORT`. Baza de date, utilizatorii și bucket-ul se numesc `filegrid`; bucket-ul e creat automat.

```yaml
# fragment de Deployment
spec:
  template:
    metadata:
      labels:
        app: filegrid-backend
        filegrid.io/storage-client: "true"
    spec:
      containers:
        - name: backend
          envFrom:
            - secretRef: {name: filegrid-storage-credentials}
            - configMapRef: {name: filegrid-storage-endpoints}
```

| Storage | k3s (din podul aplicației) | Laptop (`make infra-up`) |
|---|---|---|
| PostgreSQL | `postgres.filegrid-storage.svc.cluster.local:5432` | `127.0.0.1:5432` |
| S3 | `http://s3.filegrid-storage.svc.cluster.local:8333` | `http://127.0.0.1:9000` |
| FTP | `ftp.filegrid-storage.svc.cluster.local:21`, pasiv 21000-21019 | `127.0.0.1:21`, pasiv 21000-21019 |

Backend-ul (NestJS, TypeScript) citește aceleași variabile în ambele medii (lista completă: `backend/.env.example`): în k3s vin din Secret + ConfigMap și din `deploy/k8s/app/backend/deployment.yaml`, pe laptop din `infra/.env` (`set -a; . infra/.env; set +a` înainte de pornire), unde host-ul și portul diferă ca în tabel. Adaptoarele din `backend/src/storage/` le citesc singure:

```ts
import { StorageSettings } from './storage/config';
import { StorageRegistry } from './storage/registry';

// POSTGRES_* + FILEGRID_PG_HOST/PORT (sau FILEGRID_PG_DSN), FILEGRID_S3_ENDPOINT + S3_*, FILEGRID_FTP_HOST/PORT + FTP_*
const registry = StorageRegistry.fromSettings(StorageSettings.fromEnv(process.env));
await registry.start();                          // schema blobstore + health monitor
console.log(registry.status());                  // { s3: { up, latencyMs, circuit }, ftp: …, db: … }
```

FTP pasiv în k3s: răspunsul PASV conține IP-ul podului `ftp-0`, dar clientul backend-ului (basic-ftp, care încearcă întâi EPSV; la fel ftplib și curl, implicit) deschide conexiunea de date către adresa de control, adică ClusterIP-ul Service-ului `ftp`, pe portul pasiv primit. De aceea Service-ul expune tot intervalul 21000-21019, iar StatefulSet-ul `ftp` rămâne la o singură replică. NetworkPolicy permite porturile 21 și 21000-21019 doar clienților de mai sus. pure-ftpd acceptă cel mult 10 sesiuni simultane (jumătate din porturile pasive), din care 8 de la același pod: țineți pool-ul de conexiuni FTP al unui proces sub 8.

## Contracte pentru P2/P3

Acestea sunt contractele pe care s-a construit partea P1 (infra, storage, securitate). Dacă schimbați ceva, anunțați echipa.

**Identificatori comuni**
- Categorii: `meter_readings`, `fault_records`, `connection_documents`, `drone_videos` (aceleași în politici, metrici, dashboard-uri și UI).
- Storage-uri: `s3`, `ftp`, `db` (valorile câmpurilor primary/fallback din politici).

**Storage (`backend/src/storage/`, TypeScript, în procesul backend-ului)**

Portarea în TypeScript a adaptoarelor scrise inițial în Python (în istoricul git, înainte de eliminarea `backend/app/`): același contract, aceleași metrici `filegrid_storage_*`, aceleași variabile de mediu și aceeași schemă `blobstore`. Un singur proces Node, fără un al doilea runtime sau IPC.
```ts
import { verifyStream, StorageUnavailable, ObjectNotFound, IntegrityError } from './storage/base';
import { withCategory } from './storage/metrics';

const store = registry.get('s3');                 // ResilientStorage: circuit breaker + timeouts + metrici
await withCategory('fault_records', async () => {
  const { size, sha256 } = await store.putStream('fault_records/2026/abc.bin', chunks); // chunks: AsyncIterable<Uint8Array>
  for await (const b of verifyStream(store.getStream(key), sha256)) { /* … */ }       // IntegrityError la nepotrivire
});
```
- Un storage căzut aruncă imediat `StorageUnavailable` (circuitul e deschis); celelalte categorii nu sunt afectate. Backend-ul trece pe storage-ul fallback din politică sau răspunde 503 `STORAGE_UNAVAILABLE`.
- Upload-urile reluabile sunt stateless: părțile stau în storage-ul politicii (`staging/{uploadId}/{n}`), niciodată pe discul podului.
- Adaptorul DB folosește schema `blobstore`. Tabelele backend-ului (migrațiile Kysely din `backend/src/database/migrations/`) stau în schema `public`.
- Teste: `cd backend && npm test -- test/storage` (Postgres embedded, plus servere S3 și FTP în proces). Pe 14.11 adaptoarele au fost verificate și pe storage-urile reale din cluster (prin `kubectl port-forward`).

**Criptare pentru documentele de racordare (`backend/src/crypto/`)**
- `encryptStream(chunks, kek)` și `decryptStream(chunks, keyring)` sunt streaming AES-256-GCM (formatul FGE1, compatibil octet cu octet cu implementarea Python inițială), cu o cheie per fișier împachetată cu KEK-ul din `FILEGRID_KEK` / `FILEGRID_KEK_ID` (Secret `filegrid-app-secrets`).
- Politica are `encryptionAtRest`. În metadate se păstrează două hash-uri: al fișierului original (cel verificat la download) și al octeților stocați (cel întors de `putStream`).

**Backend (P2)**
- Imaginea `backend/Dockerfile` ascultă pe portul 8000 și rulează ca uid 10001.
- Rute: `/healthz` (procesul trăiește) și `/readyz`, care **nu** trebuie să pice când un singur storage e jos. API-ul e servit sub `/api/v1` (Ingress-ul `/api` nu taie prefixul); `/metrics` e la rădăcină.
- Env: Secret-urile `filegrid-storage-credentials` și `filegrid-app-secrets` (`JWT_SECRET`, `METER_API_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `FILEGRID_KEK*`) plus `FILEGRID_PG_HOST`, `FILEGRID_S3_ENDPOINT`, `FILEGRID_FTP_HOST` (setate în `deploy/k8s/app/`).
- Metrici așteptate de dashboard și alerte:
  - `filegrid_uploads_total{category,outcome}` și `filegrid_upload_duration_seconds{category,outcome}`; outcome `success`/`ok`/`duplicate` contează ca succes;
  - `filegrid_meter_readings_stored_total`, `filegrid_meter_readings_duplicates_total` (retry-uri deduplicate) și `filegrid_meter_readings_duplicate_stored_total` (trebuie să rămână 0).
- Loguri JSON pe stdout cu `trace_id`, `category`, `storage`, `operation`, `file_id`. `trace_id` vine din header-ul `X-Trace-Id` (îl generați dacă lipsește) și se întoarce în răspuns.
- IP-ul clientului: Traefik păstrează IP-ul sursă real (Service cu `externalTrafficPolicy: Local`) și îl pune în `X-Forwarded-For`; X-Forwarded-* venite din Internet sunt șterse (Traefik crede aceste header-e doar de la CIDR-ul podurilor, `10.42.0.0/16`). Backend-ul crede `X-Forwarded-For` doar când conexiunea vine din CIDR-urile clusterului (`TRUSTED_PROXY_CIDRS`, implicit `10.42.0.0/16,10.43.0.0/16`, setat și în `deploy/k8s/app/backend/deployment.yaml`), deci `request.ip` e IP-ul real pentru limitarea încercărilor de login și pentru audit.
- Panoul demo: ServiceAccount-ul `filegrid-backend` poate scala StatefulSet-urile `postgres`/`s3`/`ftp` (0↔1) în `filegrid-storage` (`deploy/k8s/demo-rbac.yaml`); backend-ul apelează direct API-ul Kubernetes (`backend/src/demo/kube.client.ts`, doar `s3` și `ftp`, fiindcă Postgres ține și metadatele).
- Contractul REST complet: [`docs/api.md`](docs/api.md).

**Simulator (P2)**
- Imaginea `simulator/Dockerfile` ascultă pe portul 8080 (`/metrics` și un endpoint de control pentru rata 10x) și rulează ca uid 10001.
- Env: `BACKEND_URL`, `METER_API_KEY`, `METER_RATE`.
- Metrici: `filegrid_sim_readings_sent_total` (citiri unice) și `filegrid_sim_readings_acked_total`.

**Frontend (P3)**
- Imaginea `frontend/Dockerfile` e nginx non-root (uid 101) pe portul 8080 și servește build-ul React.
- Rute pe domeniu: `/` → frontend, `/api` → backend, `/grafana` → Grafana (dashboard-ul `/grafana/d/filegrid-overview`).

**Pornire și demo (P1)**
- `sudo make up`: k3s, HTTPS, storage-urile, observabilitatea, apoi aplicația. Construiește și importă imaginile pentru fiecare folder care are un `Dockerfile`; fără imagine de frontend rămâne placeholder-ul.
- `make grafana-password`: parola de admin Grafana.
- Alertele se văd în Grafana/Alertmanager. Pentru notificări Discord/Telegram se editează Secret-ul `monitoring/alertmanager-config` (vezi comentariul din `deploy/k8s/observability/prometheus-values.yaml`).
- Chaos:
  - `make chaos-storage-stop S=s3` / `make chaos-storage-start S=s3`;
  - `sudo make chaos-netem-on NS=filegrid POD=<pod> DELAY=300ms LOSS=5%` (doar în rețeaua podului, nu pe interfețele VPS-ului) / `chaos-netem-off`;
  - `make storage-isolation-check`.

## HTTPS și Cloudflare

- cert-manager obține certificatul Let's Encrypt (HTTP-01 prin Traefik); Traefik redirecționează permanent HTTP la HTTPS.
- Traefik citește o cerere (cu tot corpul) cel mult 15 minute (`readTimeout` 900s; implicit ar fi 60s). Încărcările mari se trimit în bucăți de 1-5 MB, ca fiecare cerere să încapă în acest timp și pe o legătură lentă.
- Înregistrarea DNS rămâne **DNS-only** (nor gri) în Cloudflare: proxy-ul Cloudflare (planurile Free/Pro) limitează corpul unei cereri la 100 MB, prea puțin pentru videoclipurile de dronă. Dacă proxy-ul e totuși activat, modul SSL/TLS trebuie să fie **Full (strict)**, niciodată Flexible (buclă de redirect), iar IP-ul văzut de aplicație devine cel al Cloudflare (header-ele lui nu sunt crezute).

## Structura

- `deploy/k8s/`: manifeste k3s (cert-manager, Traefik, placeholder) și `storage/` (StatefulSet-uri, NetworkPolicy)
- `infra/`: Docker Compose pentru laptop
- `scripts/`: bootstrap-ul gazdei, Secret-ul de credențiale, job-ul de bucket, configurarea Traefik, verificarea izolării
