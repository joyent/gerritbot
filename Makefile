NPM		:= npm
ESLINT		= ./node_modules/.bin/eslint
JS_FILES	:= $(wildcard *.js) $(wildcard lib/*.js)

$(ESLINT): | $(NPM_EXEC)
	$(NPM) install \
	    eslint@`json -f package.json devDependencies.eslint` \
	    eslint-plugin-joyent@`json -f package.json devDependencies.eslint-plugin-joyent`

.PHONY: check-eslint
check-eslint: $(ESLINT)
	$(ESLINT) $(JS_FILES)

.PHONY: check
check: | check-eslint
	@echo check ok
