# Create your own compatible Build App

Use Google AI Studio Build to port the existing browser client into your own App. AIStudioToAPI remains the backend; the App receives requests, performs browser-side fetch calls and returns results.

## Create the App

1. Take [build.js](../../scripts/client/build.js) and [index.html](../../scripts/client/index.html) from the **same version as your deployed service**. Keep the authors, comments and license.
2. Open Google AI Studio Build, create a Web App, attach both files, and paste the [complete Build prompt](../zh/build-app-prompt.md) (Chinese). The prompt retains the supplied upstream links; matching deployment-version attachments take precedence.
3. Have Build create the actual project files and run compilation. The supplied HTML loads `/index.ts`: either put the client there with necessary compilation adaptations, or save it as `build.js` and change the module script path to `/build.js`.
4. Check the generated diff preserves identity negotiation, WebSocket messages, request/attempt ownership, concurrency, cancellation, errors and DOM logs.
5. Save the App and copy its **AI Studio App page URL**, not a temporary preview iframe URL. The Google accounts running the service must be able to access it.

The editor preview has neither the service-injected identity nor the local WebSocket service. Identity waiting or connection errors can occur even when compilation succeeds. Keep those errors visible and validate integration with the service.

## Point the service at your App

Edit `this.targetUrl` in the constructor of [src/core/BrowserManager.js](../../src/core/BrowserManager.js) to your actual App page URL:

```javascript
this.targetUrl = "https://ai.studio/apps/YOUR_APP_ID";
```

The automatic login queue and target-session validator use BrowserManager's target. If you also use [scripts/auth/testAccountLogin.js](../../scripts/auth/testAccountLogin.js), update its diagnostic `targetUrl` to the same address.

Rebuild and restart a Docker Compose deployment:

```bash
docker compose up -d --build
docker compose logs -f app
```

For a source deployment, stop the previous service and run `npm start`. Restarting an old Docker image does not apply the source edit.

Keep `ws://127.0.0.1:9998`: this is loopback on the machine/container running the automated browser, regardless of the hostname used to access management remotely. Keep the MakerSuite bridge in the backend. Never attach credentials or add them to the frontend.

## Verify integration

Check compilation, receipt of a valid parent-supplied identity, a real WebSocket connection with the original `Connection successful` log, and actual API request processing separately. Select an accessible model from `/v1/models` and make a manual request using the [API examples](api-examples.md); verify real content and completion, then streaming and cancellation.

A model listing, successful compilation or an open WebSocket alone does not prove generation works. Do not hard-code identity, move the WebSocket to a public endpoint, fake readiness or return mock model output to hide preview failures.
