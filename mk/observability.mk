# Stream B (P1 #5 observabilitate + #6 alerte): Prometheus + Alertmanager + kube-state-metrics, blackbox-exporter,
# Loki (SingleBinary), Alloy (DaemonSet loguri), Grafana la https://$(DOMAIN)/grafana. Totul in namespace monitoring,
# cu exceptia blackbox-exporter (namespace filegrid, ca NetworkPolicy-urile storage sa-l lase sa probeze porturile).
# Versiunile chart-urilor sunt fixate (chart-ul fixeaza la randul lui tag-urile imaginilor).
OBS_DIR = deploy/k8s/observability
OBS_PROMETHEUS_VERSION = 29.47.2
OBS_BLACKBOX_VERSION = 11.21.3
OBS_LOKI_VERSION = 7.6.0
OBS_ALLOY_VERSION = 1.16.0
OBS_GRAFANA_VERSION = 10.5.15
# helm upgrade --install doar daca s-a schimbat ceva (versiunea chart-ului, fisierul de valori sau argumentele, ca
# DOMAIN): checksum-ul e salvat in ConfigMap-ul monitoring/obs-helm-checksums dupa fiecare upgrade reusit, iar o
# rulare identica nu mai creeaza o revizie helm noua. Fortat: OBS_HELM_FORCE=1 make obs-up. Vezi scripts/obs-helm.sh.
OBS_HELM = ./scripts/obs-helm.sh

.PHONY: obs-up obs-status obs-rules-check obs-rules-test grafana-password

# Idempotent: secretele se creeaza doar daca lipsesc; helm ruleaza doar pentru release-urile schimbate.
obs-up:
	@printf '%s\n' "$$DOMAIN" | grep -Eqx '[a-z0-9]([a-z0-9.-]*[a-z0-9])?' || { echo "invalid DOMAIN: $$DOMAIN" >&2; exit 1; }
	helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update >/dev/null
	helm repo add grafana https://grafana.github.io/helm-charts --force-update >/dev/null
	helm repo update prometheus-community grafana >/dev/null
	./scripts/obs-secrets.sh
	$(OBS_HELM) prometheus monitoring prometheus-community/prometheus $(OBS_PROMETHEUS_VERSION) \
		$(OBS_DIR)/prometheus-values.yaml
	$(OBS_HELM) blackbox filegrid prometheus-community/prometheus-blackbox-exporter $(OBS_BLACKBOX_VERSION) \
		$(OBS_DIR)/blackbox-values.yaml --create-namespace
	$(OBS_HELM) loki monitoring grafana/loki $(OBS_LOKI_VERSION) $(OBS_DIR)/loki-values.yaml
	$(OBS_HELM) alloy monitoring grafana/alloy $(OBS_ALLOY_VERSION) $(OBS_DIR)/alloy-values.yaml
	kubectl -n monitoring create configmap grafana-dashboard-filegrid \
		--from-file=filegrid-overview.json=$(OBS_DIR)/dashboard-filegrid-overview.json --dry-run=client -o yaml | \
		kubectl label --local -f - grafana_dashboard=1 -o yaml | kubectl apply -f -
	$(OBS_HELM) grafana monitoring grafana/grafana $(OBS_GRAFANA_VERSION) $(OBS_DIR)/grafana-values.yaml \
		--set-string "grafana\.ini.server.domain=$$DOMAIN" --set-string "grafana\.ini.server.root_url=https://$$DOMAIN/grafana/"
	sed "s/ppc\.filegrid\.cc\.cd/$$DOMAIN/g" $(OBS_DIR)/grafana-ingress.yaml | kubectl apply -f -
	kubectl apply -f $(OBS_DIR)/networkpolicies.yaml
	$(MAKE) --no-print-directory obs-rules-check

# Valideaza regulile de alertare cu promtool din podul Prometheus
obs-rules-check:
	kubectl -n monitoring exec deploy/prometheus-server -c prometheus-server -- promtool check rules /etc/config/alerting_rules.yml

# Inainte de deploy, fara cluster: promtool check rules + testele unitare din $(OBS_DIR)/alerting-rules.test.yml
# (promtool din PATH, $$PROMTOOL sau imaginea Prometheus prin docker)
obs-rules-test:
	./scripts/obs-rules-test.sh

obs-status:
	@kubectl -n monitoring get pods,pvc,ingress
	@kubectl -n filegrid get pods -l app.kubernetes.io/name=prometheus-blackbox-exporter
	@kubectl top pods -n monitoring 2>/dev/null || true
	@echo "Grafana:  https://$$DOMAIN/grafana  (user admin, parola: make grafana-password)"

# Afiseaza parola admin Grafana; doar la invocare explicita
grafana-password:
	@kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d; echo
