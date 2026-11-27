# Tesla

Ask “Hoe vol is mijn Tesla?” or glance at the screen for battery level and range. Bolle uses the last known status when the car is asleep. You can choose to wake it while parked. The app also shows charging and lock status.

You need your own Tesla developer app and authorisation from the Tesla account that holds the car. Start with the [Dutch setup guide](handleiding.md). Check pricing and billing limits in your Tesla developer account before connecting. A request limit in the app cannot guarantee a particular bill.

## For developers

This TypeScript example turns vehicle data into a screen and sends an alert when charging finishes. It avoids waking the car during routine checks. Read [app.yaml](app.yaml) for the permissions. Run `npm ci` and `npm test` in this folder to check the screen and alerts with sample data.
