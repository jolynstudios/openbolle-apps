# Your first TypeScript server app

Run the example with Node.js 22 or newer. In this folder, start `npx github:jolynstudios/openbolle-apps dev` and open the local address it prints. Call the sample tool and tap **Zeg hallo** in the preview.

Edit `src/plugin.ts` to change what Bolle says or shows. Declare each tool and permission in `app.yaml` and run `npx github:jolynstudios/openbolle-apps controleer`. Keep the tool names in the manifest and code in sync.

The helper file `src/openbolle.ts` is copied into the starter so the app can run on its own. Make shared helper changes in the SDK. Keep `NODE_USE_ENV_PROXY=1` in the Dockerfile if your app uses the approved network connection. Read the [SDK guide](https://github.com/jolynstudios/openbolle-apps/tree/main/sdk/typescript).
