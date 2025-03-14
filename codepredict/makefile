.PHONY: docker dependencies

IS_DOCKER_BUILD := $(DOCKER_BUILD)

dependencies:
ifeq ($(IS_DOCKER_BUILD), true)
	npm install -g yarn pnpm typescript
else
	sudo npm install -g yarn pnpm typescript
endif
	npm install .
	cd ./misc/bundle-project && npm install . && npm run build && cd ../..
ifeq ($(IS_DOCKER_BUILD), true)
	pip install --break-system-packages -r requirements.txt
else
	python3 -m venv venv
	. venv/bin/activate
	pip install -r requirements.txt
endif

docker:
	DOCKER_BUILDKIT=1 docker build --build-arg NOTIFY_MAIL="$$NOTIFY_MAIL" --build-arg JELLY_MAIL_PASSWORD="$$JELLY_MAIL_PASSWORD" --no-cache -t codepredict --ssh default=$$SSH_AUTH_SOCK .