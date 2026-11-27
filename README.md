# Build an app for Bolle

Bolle is a round dashboard screen with a Dutch voice assistant. This repo contains the app tools, starter projects and five examples you can read and run.

| What do you want to build? | Where it runs | Start here |
| --- | --- | --- |
| A voice tool, a dashboard screen or a connection to an online service | Your code runs on the server. Bolle uses the network to reach it. | [Python starter](sjabloon/mijnapp/) or [TypeScript starter](sjabloon/mijnapp-ts/) |
| A way for a phone app to send events to Bolle over Bluetooth | Bolle reads a signed file with rules for the phone app. | [Accessory starter](sjabloon/mijnaccessoire/) |

If your idea needs an online API and Bluetooth messages from a phone, make two apps. One handles each connection. Give each app its own ID and installation steps. For instructions you can give a coding assistant, read the [agent guide](AGENTS.md).

## Try a server app

Install Node.js 22 or newer. The Python example also needs Python 3. Run these commands in a terminal.

```sh
npx github:jolynstudios/openbolle-apps nieuw mijn-app
cd mijn-app
npx github:jolynstudios/openbolle-apps controleer --contract --lokaal
npx github:jolynstudios/openbolle-apps dev
```

Open the local address printed by the last command. Call the sample tool and try its screen button. The app runs on your computer with sample data. The [BolleOS simulator](https://openbolle.nl/simulator#bouwen) lets you check how the device renders a screen. For a USB preview on your own Bolle, enable debug mode and start the local server with `dev --bolle`.

## Try an accessory app

```sh
npx github:jolynstudios/openbolle-apps nieuw mijn-accessoire --soort accessoire
cd mijn-accessoire
npx github:jolynstudios/openbolle-apps sleutel
npx github:jolynstudios/openbolle-apps onderteken
npx github:jolynstudios/openbolle-apps controleer
npx github:jolynstudios/openbolle-apps winkel
```

Create the signing key once and keep it private. Sign again after each change to the profile. Use the accessory tab in the simulator to test how the rules interpret an event. Real phone pairing needs a device.

## Examples

- [Kilometers](apps/kilometers/) remembers trips for one installation.
- [Reisgids](apps/reisgids/) looks up nearby sights with approximate location.
- [Homey](apps/homey/) connects an account and controls home devices.
- [Audi](apps/audi/) reads the last vehicle status from a European myAudi account.
- [Tesla](apps/tesla/) shows battery level, range and charging status.

Use the [development guide](https://openbolle.nl/docs/ontwikkelen/) for the full workflow. The [manifest schema](schema/app.schema.json) lists the accepted fields. Keep names such as `plugin.py`, `maakPlugin` and `/plugin/v1/` as written in the starter. The runtime uses those names.

## Share your work

Follow [Contributing](CONTRIBUTING.md) to submit a server app. Publish an accessory app in a store signed with your own key. The [store guide](https://openbolle.nl/docs/ontwikkelen/) explains how people can add it. The SDK and examples use the [MIT licence](LICENSE), unless an app specifies a different licence.
