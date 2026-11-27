# TypeScript helpers for server apps

Start with the [TypeScript starter](../../sjabloon/mijnapp-ts/). It includes a copy of `src/openbolle.ts`, so you can build an app without installing a separate SDK package.

Use `maakPlugin` to register tools, screen blocks and tap handlers. A tool answers a question. A block describes a screen. Bolle draws the screen and sends permitted taps to the action handler. The file provides helpers for values, cards, questions, lists, buttons, alarms and messages. The [starter source](../../sjabloon/mijnapp-ts/src/plugin.ts) shows a working example.

| Request sent to the app | Purpose |
| --- | --- |
| `GET /gezond` | Check that the app is running |
| `POST /mcp` | List tools or call a tool |
| `POST /blok/<id>` | Ask for one screen block |
| `POST /actie` | Deliver a tap, switch change or answer |

Use `broker(ctx)` inside a call for permitted platform data, installation storage or an OAuth access token. Declare the rights in the manifest. Keep tokens out of logs. For supported fields and types, see [openbolle.ts](src/openbolle.ts).

After changing the helper, run `npm ci` and `npm run controleer` here. Copy the updated source into the starter. CI checks that the copies match.
