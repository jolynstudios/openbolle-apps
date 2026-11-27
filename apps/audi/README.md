# Audi

Ask “Hey Bolle, hoe ver kom ik nog met de Audi?” to hear the range. This server app can also show fuel or battery level, charging, doors and windows. It reads the last status your car sent. It never wakes or unlocks the car. Parking coordinates are fetched only when requested.

You need a European myAudi account with Audi connect enabled. The app asks for the account email and password in its settings. This is an unofficial connection and can stop working if Audi changes its sign-in. Two-step sign-in is not supported by this version. See the [Dutch setup guide](handleiding.md).

## For developers

Run `npm ci` and `npm test` in this folder. The tests cover status translation, sign-in forms, screens and alerts. Use `node test/nep-audi.mjs 4791` to start the local test service. The app caches status to limit calls and pauses sign-in after a wrong password until settings change.

Protocol details draw on [audi_connect_ha](https://github.com/audiconnect/audi_connect_ha), MIT, © 2019 Arjen van Rhijn and contributors. Audi, myAudi and e-tron are trademarks of AUDI AG. This project is independent of Audi.
