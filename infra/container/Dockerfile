# Hyphae merge sandbox
#
# The verified merging agent runs the project's build and tests in an isolated
# container before a merge is accepted (ADR-014). This image provides Node and
# a git client; per-repo dependencies are installed at job time.
#
# This is the optional baked image for the wired `Sandbox` Durable Object in
# workers/merge-workflow. The default wiring uses the Cloudflare-managed
# `cloudflare/debian-trixie` image so `wrangler deploy` needs no Docker. To use
# this image, add a named image pointing here in that wrangler.toml (see its
# README) and build it with Docker at deploy time.

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# The Workflow writes the candidate tree here, then runs the test command.
CMD ["sleep", "infinity"]
