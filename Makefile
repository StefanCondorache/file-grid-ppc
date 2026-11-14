COMPOSE = docker compose -f infra/docker-compose.yml --env-file infra/.env

CERT_MANAGER_VERSION = v1.21.3

.PHONY: infra-up infra-down infra-ps infra-logs k8s-tls-up tls-status tls-retry

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
