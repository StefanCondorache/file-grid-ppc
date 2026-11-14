# FileGrid app on k3s (backend, frontend, simulator). Included by the Makefile (-include mk/*.mk).
# Images are built locally and imported into k3s containerd, no registry. Components whose folder has no
# Dockerfile yet are skipped, and "/" keeps serving the placeholder until the frontend exists.
#   make app-up                     build + deploy at tag = git short sha
#   make app-up METER_RATE=100      change the simulator rate (rolls the simulator pod)
#   make app-up APP_TAG=x           deploy already imported images filegrid-*:x (skips nothing else)
.PHONY: app-secrets app-images app-up app-status app-down

# One image tag per make run: app-images and k8s-app-up.sh must agree even if HEAD moves while images build
# (a commit made during `make up` once made app-up look for images that were never built and swap the live app
# for the placeholder).
ifeq ($(origin APP_TAG),undefined)
APP_TAG := $(shell git rev-parse --short HEAD 2>/dev/null || echo local)
endif
export APP_TAG

# Secret filegrid-app-secrets (KEK, JWT secret, meter API key, admin password), generated once, never printed
app-secrets:
	./scripts/k8s-app-secrets.sh

# docker build + import into k3s for every backend/ frontend/ simulator/ that has a Dockerfile
app-images:
	./scripts/k8s-app-images.sh

# Deploy the components whose image exists (kustomize deploy/k8s/app), wait for rollouts, swap the placeholder
app-up: app-secrets app-images
	./scripts/k8s-app-up.sh

app-status:
	@kubectl -n filegrid get deploy,pods,svc,hpa,ingress -l app.kubernetes.io/part-of=filegrid-app -o wide
	@kubectl -n filegrid get ingress,certificate

# Remove the app (secrets and storage data stay); the placeholder serves "/" again
app-down:
	./scripts/k8s-app-up.sh --down
