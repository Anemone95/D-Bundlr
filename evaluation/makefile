.PHONY: docker dependencies

IS_DOCKER_BUILD := $(DOCKER_BUILD)

dependencies:
ifeq ($(IS_DOCKER_BUILD), true)
	pip install --break-system-packages -r requirements.txt
else
	python3 -m venv venv
	. venv/bin/activate && pip install -r requirements.txt
endif