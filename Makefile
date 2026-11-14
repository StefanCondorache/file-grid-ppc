# Docker Compose (infra/) = doar dezvoltare pe laptop. Pe VPS ruleaza numai k3s (make up).
COMPOSE = docker compose -f infra/docker-compose.yml --env-file infra/.env

CERT_MANAGER_VERSION = v1.21.3
CERT_MANAGER_VALUES = deploy/k8s/cert-manager-values.json

# Domeniul public (Ingress + certificat Let's Encrypt). Alt domeniu: sudo make up DOMAIN=exemplu.ro, la FIECARE
# rulare (nu e salvat: o rulare fara DOMAIN pune inapoi valoarea de aici); permanent = schimbati valoarea de aici.
export DOMAIN ?= ppc.filegrid.cc.cd

# helm si kubectl (link-ul k3s) citesc acelasi cluster: kubeconfig-ul k3s, nu un ~/.kube/config oarecare
export KUBECONFIG ?= /etc/rancher/k3s/k3s.yaml

.PHONY: up status infra-up infra-down infra-ps infra-logs k8s-tls-up tls-status tls-retry k8s-secrets k8s-storage-up storage-isolation-check

# O singura comanda pe VPS sau pe un Ubuntu curat, ca root. Idempotenta: a doua rulare nu schimba nimic.
# host-bootstrap.sh instaleaza doar ce lipseste (curl/openssl/jq, k3s, helm) si asteapta clusterul;
# urmeaza storage-urile, HTTPS (cert-manager, placeholder) si starea. Storage-urile vin inainte de HTTPS: nu depind
# de el, iar k8s-tls-up asteapta contul ACME la Let's Encrypt. Nu foloseste infra/.env.
up:
	./scripts/host-bootstrap.sh
	$(MAKE) --no-print-directory k8s-storage-up
	$(MAKE) --no-print-directory k8s-tls-up
	@if [ -f mk/observability.mk ]; then $(MAKE) --no-print-directory obs-up; else echo "mk/observability.mk absent; skipping obs-up"; fi
	$(MAKE) --no-print-directory app-up
	$(MAKE) --no-print-directory status

# Starea pe scurt: poduri, certificat, unde raspund aplicatia si storage-urile
status:
	@kubectl -n filegrid-storage get pods
	@echo
	@kubectl -n filegrid get pods,certificate
	@echo
	@kubectl -n filegrid get ingress -o jsonpath='{range .items[*]}App:      https://{.spec.rules[0].host}{"\n"}{end}'
	@host=$$(kubectl -n filegrid get ingress -o jsonpath='{.items[0].spec.rules[0].host}'); \
	if [ "$$(kubectl -n filegrid get certificate -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}')" != True ]; then \
		echo "          certificate not Ready yet (needs DNS $$host -> this machine and ports 80/443 open);"; \
		echo "          locally, with Traefik's default certificate: curl -k --resolve $$host:443:127.0.0.1 https://$$host/"; \
	fi
	@echo "Storage:  postgres.filegrid-storage.svc.cluster.local:5432, http://s3.filegrid-storage.svc.cluster.local:8333,"
	@echo "          ftp.filegrid-storage.svc.cluster.local:21 (passive 21000-21019)"
	@echo "          only from pods in namespace filegrid labelled filegrid.io/storage-client=true"
	@echo "          credentials: Secret filegrid-storage-credentials, endpoints: ConfigMap filegrid-storage-endpoints"
	@echo "          (both in namespace filegrid)"

infra-up:
	./infra/gen-env.sh
	$(COMPOSE) up -d --wait

# Opreste stack-ul compose; volumele (datele) raman (fara -v)
infra-down:
	$(COMPOSE) down

infra-ps:
	$(COMPOSE) ps -a

infra-logs:
	$(COMPOSE) logs -f --tail=100

# Domeniu public + HTTPS in k3s (cert-manager, ClusterIssuers, redirect Traefik, placeholder).
# helm ruleaza doar daca release-ul cert-manager lipseste sau difera (versiune ori valori); CRD-urile vin cu
# chart-ul, iar --wait (plus job-ul startupapicheck) asteapta webhook-ul inainte de ClusterIssuers.
# k8s-traefik-config.sh asteapta re-rularea helm-install-traefik doar daca HelmChartConfig-ul s-a schimbat.
# DOMAIN inlocuieste ppc.filegrid.cc.cd in placeholder.yaml la aplicare.
k8s-tls-up:
	@printf '%s\n' "$$DOMAIN" | grep -Eqx '[a-z0-9]([a-z0-9.-]*[a-z0-9])?' || { echo "invalid DOMAIN: $$DOMAIN" >&2; exit 1; }
	@if [ "$$(helm -n cert-manager list --deployed -f '^cert-manager$$' -o json | jq -r '.[0].chart // ""')" = "cert-manager-$(CERT_MANAGER_VERSION)" ] && \
	    [ "$$(helm -n cert-manager get values cert-manager -o json | jq -cS .)" = "$$(jq -cS . $(CERT_MANAGER_VALUES))" ]; then \
		echo "cert-manager $(CERT_MANAGER_VERSION) already deployed with $(CERT_MANAGER_VALUES); skipping helm"; \
	else \
		echo "helm upgrade --install cert-manager $(CERT_MANAGER_VERSION)"; \
		helm repo add jetstack https://charts.jetstack.io --force-update && \
		helm upgrade --install cert-manager jetstack/cert-manager --version $(CERT_MANAGER_VERSION) \
			--namespace cert-manager --create-namespace -f $(CERT_MANAGER_VALUES) --wait --timeout 5m; \
	fi
	./scripts/k8s-traefik-config.sh
	kubectl apply -f deploy/k8s/cluster-issuers.yaml
	sed "s/ppc\.filegrid\.cc\.cd/$$DOMAIN/g" deploy/k8s/placeholder.yaml | kubectl apply -f -
	kubectl wait --for=condition=Ready clusterissuer/letsencrypt-staging clusterissuer/letsencrypt-prod --timeout=120s

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
# Job-ul s3-init (creeaza bucket-ul) ruleaza doar daca nu s-a terminat deja, identic, pe volumul S3 curent;
# altfel e sters si recreat (template-ul unui Job terminat e imutabil). Vezi scripts/k8s-s3-init.sh.
k8s-storage-up: k8s-secrets
	kubectl apply -k deploy/k8s/storage
	kubectl -n filegrid-storage rollout status statefulset/postgres statefulset/s3 statefulset/ftp --timeout=300s
	./scripts/k8s-s3-init.sh

# Dovedeste NetworkPolicy-urile: podul etichetat din filegrid foloseste real storage-urile (psql SELECT 1, HEAD S3
# semnat, LIST FTP pasiv prin IP-ul podului si prin Service) inainte si dupa; podul neetichetat si cel din default
# sunt respinse pe aceleasi porturi; podul etichetat nu ajunge la porturile interne SeaweedFS, iar S3 anonim da 403.
# Test al verificarii (trebuie sa pice): ISOCHECK_FAULT=leak|nopod|notool|badtoken|s3down make storage-isolation-check
storage-isolation-check:
	./scripts/storage-isolation-check.sh

-include mk/*.mk
