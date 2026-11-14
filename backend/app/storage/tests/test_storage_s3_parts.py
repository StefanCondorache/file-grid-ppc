"""Unit test: S3 multipart parts are retried on transient errors only (botocore retries are off)."""

from __future__ import annotations

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from app.storage.config import S3Settings
from app.storage.s3 import PART_ATTEMPTS, S3Storage


class FlakyClient:
    def __init__(self, failures: list[Exception]) -> None:
        self.failures = failures
        self.calls = 0

    async def upload_part(self, **kwargs) -> dict:  # noqa: ANN003
        self.calls += 1
        if self.failures:
            raise self.failures.pop(0)
        return {"ETag": f'"etag-{kwargs["PartNumber"]}"'}


def adapter() -> S3Storage:
    return S3Storage(S3Settings(endpoint="http://s3.invalid", access_key="a", secret_key="b"))


@pytest.mark.asyncio
async def test_transient_part_failure_is_retried() -> None:
    client = FlakyClient([EndpointConnectionError(endpoint_url="http://s3.invalid")])
    etag = await adapter()._upload_part(client, "k", "upload-1", 7, b"part")
    assert etag == '"etag-7"' and client.calls == 2


@pytest.mark.asyncio
async def test_part_gives_up_after_bounded_attempts() -> None:
    client = FlakyClient([EndpointConnectionError(endpoint_url="http://s3.invalid") for _ in range(PART_ATTEMPTS)])
    with pytest.raises(EndpointConnectionError):
        await adapter()._upload_part(client, "k", "upload-1", 1, b"part")
    assert client.calls == PART_ATTEMPTS


@pytest.mark.asyncio
async def test_permanent_part_failure_is_not_retried() -> None:
    denied = ClientError({"Error": {"Code": "AccessDenied"}, "ResponseMetadata": {"HTTPStatusCode": 403}}, "UploadPart")
    client = FlakyClient([denied])
    with pytest.raises(ClientError):
        await adapter()._upload_part(client, "k", "upload-1", 1, b"part")
    assert client.calls == 1
