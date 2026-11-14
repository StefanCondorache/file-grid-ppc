COMPOSE = docker compose -f infra/docker-compose.yml --env-file infra/.env

.PHONY: infra-up infra-down infra-ps infra-logs

infra-up:
	./infra/gen-env.sh
	$(COMPOSE) up -d --wait

infra-down:
	$(COMPOSE) down

infra-ps:
	$(COMPOSE) ps -a

infra-logs:
	$(COMPOSE) logs -f --tail=100
