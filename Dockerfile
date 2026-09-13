FROM node:26-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates ripgrep jq less gh openssh-server \
      python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm i -g @anthropic-ai/claude-code

RUN mkdir -p /var/run/sshd /home/node/.ssh \
  && chown -R node:node /home/node/.ssh \
  && chmod 700 /home/node/.ssh \
  && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
  && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
  && mkdir -p /work /cache/npm \
  && chown -R node:node /work /cache

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV npm_config_cache=/cache/npm
WORKDIR /work
# docker run -d -p 2222:22 … で SSH 接続(ユーザー: node / 鍵認証のみ)
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]