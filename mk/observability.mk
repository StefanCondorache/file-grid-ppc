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
OBS_HELM = helm upgrade --install --wait --timeout 4m

.PHONY: obs-up obs-status obs-rules-check obs-rules-test grafana-password

# Idempotent: secretele se creeaza doar daca lipsesc; helm upgrade fara schimbari nu reporneste nimic.
obs-up:
	@printf '%s\n' "$$DOMAIN" | grep -Eqx '[a-z0-9]([a-z0-9.-]*[a-z0-9])?' || { echo "invalid DOMAIN: $$DOMAIN" >&2; exit 1; }
	helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update >/dev/null
	helm repo add grafana https://grafana.github.io/helm-charts --force-update >/dev/null
	helm repo update prometheus-community grafana >/dev/null
	./scripts/obs-secrets.sh
	$(OBS_HELM) prometheus prometheus-community/prometheus --version $(OBS_PROMETHEUS_VERSION) \
		-n monitoring -f $(OBS_DIR)/prometheus-values.yaml
	$(OBS_HELM) blackbox prometheus-community/prometheus-blackbox-exporter --version $(OBS_BLACKBOX_VERSION) \
		-n filegrid --create-namespace -f $(OBS_DIR)/blackbox-values.yaml
	$(OBS_HELM) loki grafana/loki --version $(OBS_LOKI_VERSION) -n monitoring -f $(OBS_DIR)/loki-values.yaml
	$(OBS_HELM) alloy grafana/alloy --version $(OBS_ALLOY_VERSION) -n monitoring -f $(OBS_DIR)/alloy-values.yaml
	kubectl -n monitoring create configmap grafana-dashboard-filegrid \
		--from-file=filegrid-overview.json=$(OBS_DIR)/dashboard-filegrid-overview.json --dry-run=client -o yaml | \
		kubectl label --local -f - grafana_dashboard=1 -o yaml | kubectl apply -f -
	$(OBS_HELM) grafana grafana/grafana --version $(OBS_GRAFANA_VERSION) -n monitoring -f $(OBS_DIR)/grafana-values.yaml \
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
