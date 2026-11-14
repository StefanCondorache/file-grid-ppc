# FileGrid PPC

Platformă care rutează fișierele încărcate către FTP, S3 sau baza de date, în funcție de categoria datelor. Cerințele: [docs/brief/FileGrid_PPC.pdf](docs/brief/FileGrid_PPC.pdf). Împărțirea pe echipă: [TASKS.md](TASKS.md).

> Stare: rulează platforma (k3s + HTTPS) și storage-urile. Aplicația (backend FastAPI, frontend React + Vite) și observabilitatea nu există încă; pe domeniu e o pagină placeholder. Când apar, `make up` le va porni și pe ele.

## Arhitectură

```
Internet ──HTTPS──▶ Traefik (k3s; Let's Encrypt prin cert-manager; HTTP → HTTPS)
                      └─▶ aplicația FileGrid               namespace filegrid
                            └─▶ PostgreSQL · S3 · FTP      namespace filegrid-storage (ClusterIP)
```

- Pe VPS rulează o singură platformă: k3s. Storage-urile sunt StatefulSet-uri cu volume persistente (`local-path`: Postgres 5Gi, S3 20Gi, FTP 5Gi) și nu au niciun port deschis în afara clusterului.
- NetworkPolicy: în `filegrid-storage` orice trafic de intrare e refuzat, cu excepția podurilor din namespace-ul `filegrid` care au eticheta `filegrid.io/storage-client: "true"`. `make storage-isolation-check` demonstrează asta live.
- S3 = SeaweedFS (MinIO nu mai este distribuit de la sfârșitul lui 2025); FTP = pure-ftpd; PostgreSQL 17.
- Docker Compose (`infra/`) e doar pentru dezvoltare pe laptop; pe VPS nu rulează.

## Quickstart

### VPS sau Ubuntu curat (k3s)

Cerințe: Ubuntu 24.04 cu acces root (sau sudo), `git` și `make`; porturile 80 și 443 accesibile din Internet; o înregistrare DNS A `ppc.filegrid.cc.cd` → IP-ul mașinii.

```bash
sudo apt-get update && sudo apt-get install -y git make   # dacă lipsesc
git clone <url-repo> file-grid-ppc && cd file-grid-ppc
sudo make up
```

`make up` instalează doar ce lipsește: `curl`, `openssl`, `jq`, `ca-certificates` (apt), k3s (canalul stable; un k3s existent nu e reinstalat), Helm 3. Apoi pornește cert-manager, redirectul HTTP→HTTPS și placeholder-ul (`make k8s-tls-up`), storage-urile (`make k8s-storage-up`) și afișează starea (`make status`). Comanda e idempotentă: a doua rulare nu schimbă nimic. Parolele sunt generate o singură dată în Secret-ul Kubernetes `filegrid-storage-credentials` și nu ajung niciodată în git.

Comenzi utile (ca root, kubeconfig-ul k3s are mod 600):

```bash
make status                    # poduri, certificat, adrese
make storage-isolation-check   # demo: doar podul etichetat din filegrid ajunge la storage-uri
make tls-status                # certificatul Let's Encrypt
make tls-retry                 # re-declanșează emiterea după ce DNS-ul indică mașina
```

Alt domeniu: `sudo make up DOMAIN=exemplu.ro` (se substituie în Ingress la aplicare; înregistrarea DNS A trebuie să indice mașina).

### Laptop (dezvoltare, Docker Compose)

Cerințe: Docker Engine cu pluginul Compose v2, `make`, `openssl`; porturile 5432, 9000, 8888, 21 și 21000-21009 libere pe `127.0.0.1`.

```bash
make infra-up     # generează infra/.env (o singură dată) și pornește PostgreSQL, S3, FTP
make infra-ps     # starea serviciilor
make infra-logs   # loguri
make infra-down   # oprește serviciile (datele rămân în volume)
```

Pe acest stack se testează adaptorii de storage. Porturile sunt legate doar la `127.0.0.1`; secretele sunt în `infra/.env` (ignorat de git), cu aceleași chei ca Secret-ul din k3s.

## Conectarea aplicației la storage-uri

În k3s, un pod al aplicației ajunge la storage-uri doar dacă rulează în namespace-ul `filegrid` și are eticheta `filegrid.io/storage-client: "true"`. Credențialele vin din Secret-ul `filegrid-storage-credentials`, copiat și în namespace-ul `filegrid`, cu cheile `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `FTP_USER`, `FTP_PASSWORD`. Baza de date, utilizatorii și bucket-ul se numesc `filegrid`; bucket-ul e creat automat.

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
```

| Storage | k3s (din podul aplicației) | Laptop (`make infra-up`) |
|---|---|---|
| PostgreSQL | `postgres.filegrid-storage.svc.cluster.local:5432` | `127.0.0.1:5432` |
| S3 | `http://s3.filegrid-storage.svc.cluster.local:8333` | `http://127.0.0.1:9000` |
| FTP | `ftp.filegrid-storage.svc.cluster.local:21`, pasiv 21000-21009 | `127.0.0.1:21`, pasiv 21000-21009 |

Python (backend FastAPI); pe laptop se schimbă doar host-urile din tabel:

```python
import os, ftplib
import boto3
from botocore.config import Config

env = os.environ

# PostgreSQL (psycopg / asyncpg; cu SQLAlchemy async: postgresql+asyncpg://...)
dsn = (f"postgresql://{env['POSTGRES_USER']}:{env['POSTGRES_PASSWORD']}"
       f"@postgres.filegrid-storage.svc.cluster.local:5432/{env['POSTGRES_DB']}")

# S3: endpoint propriu și adresare path-style (la fel pentru aioboto3)
s3 = boto3.client(
    "s3",
    endpoint_url="http://s3.filegrid-storage.svc.cluster.local:8333",
    aws_access_key_id=env["S3_ACCESS_KEY"],
    aws_secret_access_key=env["S3_SECRET_KEY"],
    region_name="us-east-1",
    config=Config(s3={"addressing_style": "path"}),
)
s3.head_bucket(Bucket=env["S3_BUCKET"])

# FTP în mod pasiv (implicit în ftplib)
ftp = ftplib.FTP("ftp.filegrid-storage.svc.cluster.local", timeout=10)
ftp.login(env["FTP_USER"], env["FTP_PASSWORD"])
ftp.set_pasv(True)
```

FTP pasiv în k3s: răspunsul PASV conține IP-ul podului `ftp-0`, accesibil direct din cluster; NetworkPolicy permite porturile 21 și 21000-21009 doar clienților de mai sus.

## HTTPS și Cloudflare

- cert-manager obține certificatul Let's Encrypt (HTTP-01 prin Traefik); Traefik redirecționează permanent HTTP la HTTPS.
- Înregistrarea DNS rămâne **DNS-only** (nor gri) în Cloudflare: proxy-ul Cloudflare (planurile Free/Pro) limitează corpul unei cereri la 100 MB, prea puțin pentru videoclipurile de dronă. Dacă proxy-ul e totuși activat, modul SSL/TLS trebuie să fie **Full (strict)**, niciodată Flexible (buclă de redirect).

## Structura

- `deploy/k8s/`: manifeste k3s (cert-manager, Traefik, placeholder) și `storage/` (StatefulSet-uri, NetworkPolicy)
- `infra/`: Docker Compose pentru laptop
- `scripts/`: bootstrap-ul gazdei, Secret-ul de credențiale, job-ul de bucket, verificarea izolării
