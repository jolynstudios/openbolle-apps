# Your first accessory app

This starter describes how Bolle should react to a phone event. Edit the rules in `profiel.json`. Open the accessory tab in the [simulator](https://openbolle.nl/simulator#bouwen) and try an event you expect to match, then one you expect Bolle to ignore.

In this folder, create your signing key once with `npx github:jolynstudios/openbolle-apps sleutel`. Keep the private key safe. After each profile change, run:

```sh
npx github:jolynstudios/openbolle-apps onderteken
npx github:jolynstudios/openbolle-apps controleer
npx github:jolynstudios/openbolle-apps winkel
```

For a release, raise `versie` in both `app.yaml` and `profiel.json` before signing. Compare the store code on Bolle with the code from your key. Use `installeer` with a trusted store and a USB data cable to test on your own device. Test actual pairing with the phone app. See the [accessory guide](https://openbolle.nl/docs/ontwikkelen/).
