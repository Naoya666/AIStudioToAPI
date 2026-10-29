# Cloud-built container images

Repository: https://github.com/Naoya666/AIStudioToAPI

The **Build and publish Docker image** workflow tests the source, builds native
`linux/amd64` and `linux/arm64` images, and checks each image with no external
network, production data or live credentials. Only successful images are pushed
to GitHub Container Registry (GHCR). Production hosts do not compile source.

## Everyday use

1. Push code to `main`. Open the repository's **Actions** tab and select
   **Build and publish Docker image**.
2. Wait for `test`, both `build` jobs and `publish` to pass. The run summary gives
   the exact image tag and immutable digest to deploy.
3. Deploy that digest through the host's existing backup and upgrade procedure.
   The workflow publishes images; it does not SSH into or restart production.

A `v*` Git tag also publishes an image carrying that tag. Other branches and pull
requests run the checks and build both architectures without publishing images.
You can retry from **Actions → Build and publish Docker image → Run workflow**,
selecting `main`. No personal token or repository secret is needed for CI;
publication uses the job's short-lived `GITHUB_TOKEN` with `packages: write`.

Images:

- `ghcr.io/naoya666/aistudiotoapi:sha-<full-commit-id>`: a specific source revision.
- `ghcr.io/naoya666/aistudiotoapi:main`: the latest successful main build.
- `ghcr.io/naoya666/aistudiotoapi:v...`: a published version tag.

Use the digest from the run summary for production, for example:

```yaml
services:
  aistudio:
    image: ghcr.io/naoya666/aistudiotoapi@sha256:<digest-from-run-summary>
```

Retain the host's existing service name, environment, mounts, network, ports and
other settings. The image has no bundled account sessions or runtime database.
The current source uses Playground and needs no deployment-only Build App patch.

## First-time GitHub setup

If GitHub disables workflows for the repository, open **Settings → Actions →
General**, enable Actions and allow the pinned GitHub and Docker actions used by
this workflow. Run or rerun the workflow afterward.

GHCR initially creates packages as **private**, even for public source
repositories. To allow production hosts to pull without a registry credential,
after the first successful publication sign in as the package owner and open:

https://github.com/users/Naoya666/packages/container/aistudiotoapi/settings

Under **Danger Zone → Change visibility**, choose **Public** and confirm the
package name. Do this only if publishing the image publicly is intended. This
exposes the image's application code and bundled dependencies. Runtime accounts,
`.env` files, proxy settings and databases are excluded from the build context.
If the image is to remain private, use a separate read-only `read:packages`
credential through `docker login ghcr.io` on deployment hosts instead; never put
it in Compose or source control.

Verify the selected image can be pulled on the destination host **before**
changing the running service.

## Production update and rollback

1. Inspect the active Compose file, bind mounts, volumes, databases and current
   backup. Record the running image ID and rollback reference.
2. Pull the new digest while the existing service continues to run.
3. Follow the host's maintenance procedure to take and verify a pre-change backup.
4. Change only the Build service's `image` reference and validate Compose.
5. Recreate only that service with `docker compose up -d --no-deps --no-build
--pull never <service>`.
6. Check liveness, authenticated model listing, admin/public assets, current saved
   configuration, account preservation, restart count and scheduled backups.

Keep the previous image locally for rollback. Restore its image reference and
recreate only Build if necessary. Do not restore stale databases for a code-only
rollback, run `down -v`, or prune rollback images implicitly.

## Build maintenance

Every image starts from the Node base pinned by digest in `Dockerfile`, never
from the previous application release. Layer depth stays bounded. GitHub Actions
caches dependency, browser and build layers separately per architecture, so a
source update does not require downloading every dependency again.

`package-lock.json` is committed and `npm ci` is used in CI and the Docker build.
When changing dependencies, update and commit the lockfile with `package.json`.
Update the Node base digest, browser version and pinned Actions deliberately as
part of normal maintenance. These changes may require a full cache rebuild.

The offline smoke check launches Camoufox against a synthetic page, validates
runtime assets and SQLite availability, starts the service with empty accounts,
and checks liveness and API authentication. It does not make model-generation
requests or prove that a real upstream account is healthy.
