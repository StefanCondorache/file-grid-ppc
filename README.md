# FileGrid PPC

Platformă care rutează fișierele încărcate către FTP, S3 sau baza de date, în funcție de categoria datelor. Cerințele proiectului: [docs/brief/FileGrid_PPC.pdf](docs/brief/FileGrid_PPC.pdf).

> Starea curentă: există doar infrastructura de storage; aplicația nu a fost încă creată.

## Quickstart

Cerințe: Docker cu Compose, `make`, `openssl`.

```bash
make infra-up     # generează infra/.env (o singură dată) și pornește PostgreSQL, S3 (SeaweedFS), FTP
make infra-ps     # starea serviciilor
make infra-logs   # loguri
make infra-down   # oprește serviciile (datele rămân în volume)
```

Toate porturile sunt legate doar la `127.0.0.1`. Secretele se află în `infra/.env` (ignorat de git). S3 folosește SeaweedFS, deoarece MinIO nu mai este distribuit de la sfârșitul lui 2025.

## Documentație

- [docs/vps-setup.md](docs/vps-setup.md): configurarea VPS-ului și a stack-ului de storage
- [docs/github-ssh-setup.md](docs/github-ssh-setup.md): acces GitHub prin SSH
