FROM node:26-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates ripgrep jq less \
  && rm -rf /var/lib/apt/lists/*

RUN npm i -g @anthropic-ai/claude-code

ENV npm_config_cache=/cache/npm
WORKDIR /work
CMD ["bash"]
