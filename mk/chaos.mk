# Chaos pentru demo (P1 #8). Storage: S=postgres|s3|ftp. Rezultatele se vad in Grafana (filegrid_storage_up,
# circuit state, p95/p99 pe categorie). Backend-ul face acelasi stop/start din panoul demo (deploy/k8s/demo-rbac.yaml).
#   make chaos-storage-stop S=s3          scale la 0, asteapta disparitia podului
#   make chaos-storage-start S=s3         scale la 1, asteapta Ready
#   make chaos-storage-status
#   DRY_RUN=1 make chaos-storage-stop S=s3   doar --dry-run=server, nu schimba nimic
# Retea degradata cu tc netem DOAR in network namespace-ul podului (niciodata eth0/wg0 ale VPS-ului); ca root:
#   make chaos-netem-on NS=filegrid-storage POD=s3-0 [DELAY=300ms JITTER=50ms LOSS=5%]
#   make chaos-netem-off NS=filegrid-storage POD=s3-0
#   make chaos-netem-status [NS=filegrid-storage]   (fara POD: toate podurile storage)
.PHONY: chaos-rbac chaos-storage-stop chaos-storage-start chaos-storage-status chaos-netem-on chaos-netem-off chaos-netem-status

DELAY ?= 300ms
JITTER ?= 50ms
LOSS ?= 5%

chaos-rbac:
	kubectl apply -f deploy/k8s/demo-rbac.yaml

chaos-storage-stop:
	@test -n "$(S)" || { echo "S=postgres|s3|ftp"; exit 2; }
	./scripts/chaos/storage.sh stop $(S)

chaos-storage-start:
	@test -n "$(S)" || { echo "S=postgres|s3|ftp"; exit 2; }
	./scripts/chaos/storage.sh start $(S)

chaos-storage-status:
	./scripts/chaos/storage.sh status $(S)

chaos-netem-on:
	@test -n "$(NS)" -a -n "$(POD)" || { echo "NS=<namespace> POD=<pod>"; exit 2; }
	./scripts/chaos/netem.sh on $(NS) $(POD) $(DELAY) $(JITTER) $(LOSS)

chaos-netem-off:
	@test -n "$(NS)" -a -n "$(POD)" || { echo "NS=<namespace> POD=<pod>"; exit 2; }
	./scripts/chaos/netem.sh off $(NS) $(POD)

chaos-netem-status:
	@if [ -n "$(POD)" ]; then ./scripts/chaos/netem.sh status $(or $(NS),filegrid-storage) $(POD); \
	else for p in postgres-0 s3-0 ftp-0; do \
	  ./scripts/chaos/netem.sh status $(or $(NS),filegrid-storage) $$p || true; done; fi
