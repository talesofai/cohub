# Worker deployment

The user worker owns `cohub-workspace-sync`. It requires the shared Space PVC plus private object storage used by API snapshot presigns and Agent native payload reads.

Required workspace replication values:

- `WORKSPACE_SYNC_WORKER_CONCURRENCY`
- `WORKER_LOCK_DB_POOL_MAX` (at least `WORKSPACE_SYNC_WORKER_CONCURRENCY + 2`)
- `WORKSPACE_OBJECT_ENDPOINT`
- `WORKSPACE_OBJECT_REGION`
- `WORKSPACE_OBJECT_BUCKET`
- `WORKSPACE_OBJECT_ACCESS_KEY_ID`
- `WORKSPACE_OBJECT_SECRET_ACCESS_KEY`

The deployment reuses the API Secret. The endpoint, bucket, and credentials must identify the same private object authority configured on API and Agent. Do not point worker at a separate bucket: API-committed snapshot keys are consumed verbatim.

```bash
cd deploy/worker/dev
cp values.example.yaml values.yaml
# Configure values.yaml and the shared API Secret first.
./deploy.sh
```

`WORKSPACE_SYNC_WORKER_CONCURRENCY` is per worker pod. Keep initial concurrency conservative because each active cycle scans a PVC tree, verifies content-addressed objects, and holds a dedicated PostgreSQL workspace advisory lock.
