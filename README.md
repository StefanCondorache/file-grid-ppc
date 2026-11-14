# FileGrid PPC

Platformă care rutează fișierele încărcate către FTP, S3 sau baza de date, în funcție de categoria datelor. Cerințele proiectului: [docs/brief/FileGrid_PPC.pdf](docs/brief/FileGrid_PPC.pdf).

> Starea curentă: există doar infrastructura de storage; aplicația nu a fost încă creată.

## Quickstart

Cerințe (storage): Docker Engine cu pluginul Compose v2 (testat cu compose v5.7.1; comportamentul `--wait` cu servicii one-shot variază pe versiunile v2 mai vechi), `make`, `openssl`; porturile 5432, 9000, 8888, 21 și 21000-21009 libere pe `127.0.0.1`.

```bash
make infra-up     # generează infra/.env (o singură dată) și pornește PostgreSQL, S3 (SeaweedFS), FTP
make infra-ps     # starea serviciilor
make infra-logs   # loguri
make infra-down   # oprește serviciile (datele rămân în volume)
```

Toate porturile sunt legate doar la `127.0.0.1`. Secretele se află în `infra/.env` (ignorat de git). S3 folosește SeaweedFS, deoarece MinIO nu mai este distribuit de la sfârșitul lui 2025.

Pe VPS-ul cu k3s (cert-manager, Helm):

```bash
make k8s-tls-up   # k3s: cert-manager, redirect HTTP->HTTPS, placeholder pe https://ppc.filegrid.cc.cd (DNS A ppc -> IP-ul VPS)
make tls-status   # starea certificatului Let's Encrypt
make tls-retry    # re-declanșează emiterea după ce DNS-ul pointează la VPS
```

Cloudflare: dacă înregistrarea DNS e proxied (nor portocaliu), modul SSL/TLS trebuie să fie **Full (strict)**, niciodată Flexible (buclă de redirect).
