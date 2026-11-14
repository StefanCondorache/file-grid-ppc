COMPOSE = docker compose -f infra/docker-compose.yml --env-file infra/.env

CERT_MANAGER_VERSION = v1.21.3

.PHONY: infra-up infra-down infra-ps infra-logs k8s-tls-up tls-status tls-retry k8s-secrets k8s-storage-up storage-isolation-check

infra-up:
	./infra/gen-env.sh
	$(COMPOSE) up -d --wait

infra-down:
	$(COMPOSE) down

infra-ps:
	$(COMPOSE) ps -a

infra-logs:
	$(COMPOSE) logs -f --tail=100

# Domeniu public + HTTPS in k3s (cert-manager, ClusterIssuers, redirect Traefik, placeholder)
k8s-tls-up:
	helm repo add jetstack https://charts.jetstack.io --force-update
	helm upgrade --install cert-manager jetstack/cert-manager --version $(CERT_MANAGER_VERSION) \
		--namespace cert-manager --create-namespace --set crds.enabled=true \
		--set resources.requests.cpu=10m --set resources.requests.memory=32Mi \
		--set webhook.resources.requests.cpu=10m --set webhook.resources.requests.memory=32Mi \
		--set cainjector.resources.requests.cpu=10m --set cainjector.resources.requests.memory=64Mi \
		--wait --timeout 5m
	kubectl apply -f deploy/k8s/traefik-config.yaml
	kubectl apply -f deploy/k8s/cluster-issuers.yaml
	kubectl apply -f deploy/k8s/placeholder.yaml
	kubectl wait --for=condition=Ready clusterissuer/letsencrypt-staging clusterissuer/letsencrypt-prod --timeout=120s
	kubectl -n kube-system rollout status deploy/traefik --timeout=180s

tls-status:
	kubectl -n filegrid get certificate,certificaterequest,order,challenge

# Dupa ce DNS-ul pointeaza aici: sterge CertificateRequest-urile care NU sunt Ready (esuate/in asteptare);
# cert-manager le recreeaza imediat si porneste o comanda ACME noua, fara asteptarea backoff-ului.
# Un certificat deja emis nu e atins (nu se consuma limitele Let's Encrypt).
tls-retry:
	kubectl -n filegrid get certificaterequest -o json | \
		jq -r '.items[] | select([.status.conditions[]? | select(.type=="Ready" and .status=="True")] | length == 0) | .metadata.name' | \
		xargs -r kubectl -n filegrid delete certificaterequest
	@sleep 5
	$(MAKE) tls-status

# Secret filegrid-storage-credentials (generat o singura data) in filegrid-storage si copiat in filegrid
k8s-secrets:
	./scripts/k8s-secrets.sh

# Postgres + SeaweedFS (S3) + FTP in namespace filegrid-storage.
# Job-ul s3-init e sters si recreat la fiecare rulare (template-ul unui Job terminat e imutabil); e idempotent.
k8s-storage-up: k8s-secrets
	kubectl apply -k deploy/k8s/storage
	kubectl -n filegrid-storage rollout status statefulset/postgres statefulset/s3 statefulset/ftp --timeout=300s
	kubectl -n filegrid-storage delete job s3-init --ignore-not-found --wait=true
	kubectl apply -f deploy/k8s/storage/s3-init-job.yaml
	kubectl -n filegrid-storage wait --for=condition=complete job/s3-init --timeout=180s

# Dovedeste NetworkPolicy-urile: podul etichetat din filegrid foloseste real storage-urile (psql SELECT 1, HEAD S3
# semnat, LIST FTP pasiv) inainte si dupa; podul neetichetat si cel din default sunt respinse pe aceleasi porturi.
# Test al verificarii (trebuie sa pice): ISOCHECK_FAULT=leak|nopod|notool|badtoken|s3down make storage-isolation-check
storage-isolation-check:
	./scripts/storage-isolation-check.sh
