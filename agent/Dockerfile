# Cactus Needle inference sidecar — CPU only, checkpoint supplied by a volume.
#
# ## Why this is a separate image from the app
#
# The app is a Node/Next.js image. Needle is Python + JAX. Merging them means every
# `next build` also carries a JAX toolchain, and every model change rebuilds the web
# app. They have different lifecycles, so they are different services.
#
# ## Why the checkpoint is a VOLUME and not baked in
#
# The checkpoint is the thing that changes most often — every finetune produces a
# new `needle_finetuned_*_best.pkl`. Baking it in would mean an image rebuild per
# training run. Mounted, you drop in a new file and restart the service.
# It is also 52 MB of the user's model weights, which has no business in a layer
# that might get pushed to a registry.
#
# ## Why CPU only
#
# Inference runs on CPU deliberately (see NEEDLE_PLATFORM in needle_sidecar.py):
# GPU inference on the dev machine intermittently fails with an XLA autotuning
# error, and a chat message needs ~4-6 s on CPU, which is fine.
#
# Skipping CUDA is also what keeps this image sane. Measured on the dev venv:
#   full venv with CUDA .... 6.0 GB
#   └ nvidia-* wheels ...... 4.4 GB   <- not installed here
# Training-only dependencies are omitted too (wandb, transformers, scipy,
# optax, gcsfs, google-genai): the inference path imports only jax, jaxlib, flax,
# sentencepiece, numpy — plus `datasets`, and only because `get_tokenizer` happens
# to live in needle/dataset/dataset.py, which imports it at module scope.
#
# Build from the repo root:
#   docker build -f agent/Dockerfile -t budget-needle .

FROM python:3.12-slim AS base

# Pinned so the image is reproducible; bump deliberately.
ARG NEEDLE_REPO=https://github.com/cactus-compute/needle.git
ARG NEEDLE_COMMIT=6fdddb874dd6f46dabeea88d0bf239fc4a2474c4

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    JAX_PLATFORMS=cpu \
    HF_HUB_DISABLE_XET=1 \
    JAX_COMPILATION_CACHE_DIR=/tmp/jax-cache

RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

RUN git clone --filter=blob:none "$NEEDLE_REPO" needle-src \
 && cd needle-src \
 && git checkout --quiet "$NEEDLE_COMMIT" \
 && rm -rf .git

# Inference-only dependency set, installed WITHOUT needle's own pyproject, whose
# `dependencies` list is sized for training (wandb, datasets, transformers,
# gcsfs, google-genai, optax, scipy) and would roughly triple this image.
RUN pip install --no-cache-dir \
      "jax[cpu]" \
      flax \
      sentencepiece \
      numpy \
      datasets \
      huggingface_hub

# The package itself, no dependency resolution (they are installed above).
RUN pip install --no-cache-dir --no-deps -e /opt/needle-src

# The sidecar is the only application code in this image.
COPY agent/needle_sidecar.py /opt/agent/needle_sidecar.py

# Needle resolves `checkpoints/` relative to NEEDLE_HOME.
ENV NEEDLE_HOME=/opt/needle-src \
    NEEDLE_HOST=0.0.0.0 \
    NEEDLE_PORT=8765 \
    NEEDLE_PLATFORM=cpu
# Binding 0.0.0.0 is only acceptable because compose does NOT publish this port;
# the sidecar refuses a non-loopback bind unless this is explicitly set.
ENV NEEDLE_ALLOW_NON_LOOPBACK=1

# Checkpoints arrive on a volume at /opt/needle-src/checkpoints. Create the
# directory so a missing mount fails with the sidecar's own clear error rather
# than a confusing path error.
RUN mkdir -p /opt/needle-src/checkpoints

# Run unprivileged: this process evaluates untrusted text from a chat channel.
RUN useradd --system --uid 1001 needle \
 && chown -R needle:needle /opt/needle-src /opt/agent /tmp/jax-cache 2>/dev/null || true
USER needle

EXPOSE 8765

# /health answers only after the checkpoint is loaded, so this is real readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=4).status==200 else 1)"

CMD ["python", "/opt/agent/needle_sidecar.py"]
