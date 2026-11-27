# Submit a server app

1. Put one server app in `apps/<id>/` per pull request. Keep its ID when you update it. Set `auteur.github` to your GitHub name or check that you are listed as an owner for the app.
2. Describe the tools, example questions and on-device text in Dutch. Say when each tool helps. Write the README in English. Link a Dutch user guide from `presentatie.documentatie` if you have one.
3. Request only the access the app needs. Explain each outside host and any need for precise location. Use `bevestigen: true` for actions with real-world consequences. Write down which data the app uses. Keep personal data out of logs and credentials out of source control.
4. Add two 466 × 466 PNG screenshots and a caption for each to `presentatie.afbeeldingen`. You can take them in the [simulator](https://openbolle.nl/simulator#bouwen).
5. Run the checks below from the app folder. Try the app with `dev`. Check that a person can understand a failed connection as well as a successful one.
6. From the repo root, update the store index with `python3 tools/maak_winkel.py` using the workflow's Python dependencies. Include the updated index when it changes. Open the pull request and await review. New permissions or hosts need fresh approval from existing users.

```sh
npx github:jolynstudios/openbolle-apps controleer
npx github:jolynstudios/openbolle-apps controleer --contract
```

The contract check compares the running app with its manifest. The [CI workflow](.github/workflows/controleer.yml) shows the full set of checks used for this repo.

## Share an accessory app

An accessory app belongs in your own signed store. Keep the signing key private and publish the signed profile, signature and store index. Follow the [store guide](https://openbolle.nl/docs/ontwikkelen/). To request a listing, open a pull request proposing your public store repository for the site's known-store list (`site/winkels.json`, `github.bekend`). If you cannot access the site source, open an issue here with your repository and store index URLs so a maintainer can propose the entry. Alternatively, give your repository the GitHub topic `openbolle-plugin`. Maintainers can run `node site/tools/haal_winkels.mjs --registraties` in the site repository to find registered stores. Registration helps maintainers find your repository. Share your store link directly with users. The website catalogue features built-in apps and the openBolle store. Each independent maker maintains their own store. Each person decides whether to trust the maker’s signing key.
