FROM docker/sandbox-templates:codex

USER root
COPY shared/install-cloudcli.sh /tmp/install-cloudcli.sh
RUN chmod +x /tmp/install-cloudcli.sh && /tmp/install-cloudcli.sh

USER agent
RUN --mount=type=cache,target=/tmp/npm-cache,sharing=locked,mode=0777 \
    npm install -g @tunghuynh/remotecli \
      --cache=/tmp/npm-cache \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000 \
      --no-audit \
      --no-fund && \
    remotecli --version

COPY --chown=agent:agent shared/start-cloudcli.sh /home/agent/.remotecli-start.sh
RUN echo '. ~/.remotecli-start.sh' >> /home/agent/.bashrc
