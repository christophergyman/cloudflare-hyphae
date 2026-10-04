# Hyphae merge sandbox
#
# The verified merging agent runs the project's build and tests in an isolated
# container before a merge is accepted (ADR-014). This image provides Node and
# a git client; per-repo dependencies are installed at job time.
#
# Build and push with the Containers flow, or use it as the base for a
# `ctx.container` image in the merge Workflow.

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# The Workflow writes the candidate tree here, then runs the test command.
CMD ["sleep", "infinity"]
