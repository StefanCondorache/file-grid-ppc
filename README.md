# FileGrid PPC

Platformă care rutează fișierele încărcate către FTP, S3 sau baza de date, în funcție de categoria datelor. Cerințele: [docs/brief/FileGrid_PPC.pdf](docs/brief/FileGrid_PPC.pdf). Împărțirea pe echipă: [TASKS.md](TASKS.md).

> Stare: rulează platforma (k3s + HTTPS) și storage-urile. Aplicația (backend FastAPI, frontend React + Vite) și observabilitatea nu există încă; pe domeniu e o pagină placeholder. Manifestele lor și livrarea imaginilor în k3s (k3s nu vede imaginile construite cu Docker și nu e configurat niciun registry) se adaugă odată cu codul; până atunci `make up` nu le pornește.

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

Python (backend FastAPI). Același cod merge în ambele medii: în k3s variabilele vin din Secret + ConfigMap, pe laptop din `infra/.env` (`set -a; . infra/.env; set +a` înainte de pornire), unde host-ul și portul diferă ca în tabel:

```python
import os, ftplib
import boto3
from botocore.config import Config

env = os.environ

# PostgreSQL (psycopg / asyncpg; cu SQLAlchemy async: postgresql+asyncpg://...)
dsn = (f"postgresql://{env['POSTGRES_USER']}:{env['POSTGRES_PASSWORD']}"
       f"@{env['FILEGRID_PG_HOST']}:{env['FILEGRID_PG_PORT']}/{env['POSTGRES_DB']}")

# S3: endpoint propriu și adresare path-style (la fel pentru aioboto3)
s3 = boto3.client(
    "s3",
    endpoint_url=env["FILEGRID_S3_ENDPOINT"],
    aws_access_key_id=env["S3_ACCESS_KEY"],
    aws_secret_access_key=env["S3_SECRET_KEY"],
    region_name="us-east-1",
    config=Config(s3={"addressing_style": "path"}),
)
s3.head_bucket(Bucket=env["S3_BUCKET"])

# FTP în mod pasiv (implicit în ftplib)
ftp = ftplib.FTP(timeout=10)
ftp.connect(env["FILEGRID_FTP_HOST"], int(env["FILEGRID_FTP_PORT"]))
ftp.login(env["FTP_USER"], env["FTP_PASSWORD"])
ftp.set_pasv(True)
```

FTP pasiv în k3s: răspunsul PASV conține IP-ul podului `ftp-0`, dar ftplib (și curl, implicit) îl ignoră și deschide conexiunea de date către adresa de control, adică ClusterIP-ul Service-ului `ftp`, pe portul pasiv primit. De aceea Service-ul expune tot intervalul 21000-21019, iar StatefulSet-ul `ftp` rămâne la o singură replică. NetworkPolicy permite porturile 21 și 21000-21019 doar clienților de mai sus. pure-ftpd acceptă cel mult 10 sesiuni simultane (jumătate din porturile pasive), din care 8 de la același pod: țineți pool-ul de conexiuni FTP al unui proces sub 8.

## HTTPS și Cloudflare

- cert-manager obține certificatul Let's Encrypt (HTTP-01 prin Traefik); Traefik redirecționează permanent HTTP la HTTPS.
- Traefik citește o cerere (cu tot corpul) cel mult 15 minute (`readTimeout` 900s; implicit ar fi 60s). Încărcările mari se trimit în bucăți de 1-5 MB, ca fiecare cerere să încapă în acest timp și pe o legătură lentă.
- Înregistrarea DNS rămâne **DNS-only** (nor gri) în Cloudflare: proxy-ul Cloudflare (planurile Free/Pro) limitează corpul unei cereri la 100 MB, prea puțin pentru videoclipurile de dronă. Dacă proxy-ul e totuși activat, modul SSL/TLS trebuie să fie **Full (strict)**, niciodată Flexible (buclă de redirect).

## Structura

- `deploy/k8s/`: manifeste k3s (cert-manager, Traefik, placeholder) și `storage/` (StatefulSet-uri, NetworkPolicy)
- `infra/`: Docker Compose pentru laptop
- `scripts/`: bootstrap-ul gazdei, Secret-ul de credențiale, job-ul de bucket, configurarea Traefik, verificarea izolării
