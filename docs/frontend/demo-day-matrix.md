# Demo-day matrix: real backend vs mocks

*Living document (Task 5.14). Decide every row by **H+14**; after that the demo build is frozen. Backend status comes
from [backend-sync](../api/backend-sync-2026-11-14.md); the backend team has not chosen its approach yet.*

## Groups

| Group | Real backend ready? | Mock | Decide by | If mocked, the jury sees |
|---|---|---|---|---|
| auth | no (skeleton: bearer JWT, 2 roles) | yes | H+14 | role-dropdown login with 5 demo accounts |
| policies | no | yes | H+14 | live policy edit, next upload follows it |
| uploads | no | yes | H+14 | resumable upload; **memory-flat proof needs real** |
| files | no | yes | H+14 | list, detail, hashes, corrupt detection |
| audit | no | yes | H+14 | reveal and role-switch events |
| meters | no (simulator owner open: OQ-3) | yes | H+14 | ticking counters, lost = 0 |
| monitoring | no (no spans/metrics/thresholds in schema) | yes | H+14 | guarantees, health strip, matrix, bulkhead |
| statistics | no (no periods/origin tags) | yes | H+14 | S1/S2/S3 with interpretations |
| demo | partly (backend SA can scale storages) | yes | H+14 | storm, corrupt, simulator, stop S3 |
| stream | no | yes | H+14 | SSE; if the real backend is bearer-only, the UI polls every 3 s |

Rules: a **hybrid** build (`NEXT_PUBLIC_API_MOCK_GROUPS=…`) never mocks `uploads` or `files` (they use XHR and plain
links, which in-page mocks cannot intercept), so real uploads are never copied through a service worker. Auth is
bearer-only in the skeleton: until the backend also sets the `__Host-` cookie, SSE and plain download links fail
against the real API, so `stream` stays mocked or the bridge runs in polling mode.

## Two images, one swap

```bash
# real backend (default), built off-VPS
npm run image:real        # docker build -t filegrid-frontend:real .
# full-mock fallback (every group mocked, service worker), explicitly allowed
npm run image:fullmock    # docker build --build-arg NEXT_PUBLIC_API_MOCKS=1 --build-arg FILEGRID_ALLOW_MOCKS=1 -t filegrid-frontend:fullmock .

# import into k3s on the VPS (after copying the tarball)
docker save filegrid-frontend:fullmock -o fg-fullmock.tar
sudo k3s ctr images import fg-fullmock.tar

# swap during the demo (and back)
kubectl -n filegrid set image deploy/frontend frontend=filegrid-frontend:fullmock
kubectl -n filegrid set image deploy/frontend frontend=filegrid-frontend:real
```

## What a full-mock fallback cannot show

- The health strip and guarantees do **not** react to a teammate's real `kubectl scale` of S3: in full-mock mode,
  beat 5 uses the control room's mocked "Oprește S3" instead.
- Server memory staying flat during a 1 GB upload (N3): only provable against the real backend.
- After switching back to the real image, unregister the service worker left by the mock build (DevTools →
  Application → Service workers → Unregister), or the old worker keeps answering.

## Deploy procedure (Task 5.15)

Filled in when the first deploy runs: image build, import, rollout, checks (`/healthz`, CSP console clean,
`kubectl top pods -n filegrid`).
