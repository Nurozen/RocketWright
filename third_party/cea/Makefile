.PHONY: py-clean py-rebuild

PYTHON ?= python
PIP ?= $(PYTHON) -m pip
PY_BUILD_DIR ?= build/py-build
PIP_EDITABLE_FLAGS ?= --no-build-isolation

py-clean:
	rm -rf $(PY_BUILD_DIR)

py-rebuild: py-clean
	$(PIP) install -e . $(PIP_EDITABLE_FLAGS)
