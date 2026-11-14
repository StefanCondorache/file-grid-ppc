# Test image for the storage + crypto suites (P1). Build context: backend/
#   docker build -f app/storage/tests/Dockerfile -t filegrid-storage-tests:local backend/
# run-in-cluster.sh builds it, imports it into k3s and runs it as the Job in k8s-job.yaml.
FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /src
COPY app/storage/requirements.txt app/storage/requirements-dev.txt app/storage/
RUN pip install -r app/storage/requirements-dev.txt \
    && useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin tester

COPY app/storage app/storage
COPY app/crypto app/crypto

USER 10001:10001
# -p no:cacheprovider: the root filesystem is read-only in the Job
ENTRYPOINT ["python", "-m", "pytest", "-p", "no:cacheprovider"]
CMD ["-m", "integration", "-v", "-rA", "app/storage", "app/crypto"]
