# Kilometers

Keep a mileage log by voice. Say “Noteer een zakelijke rit naar Utrecht, kilometerstand 45230”. At the end, say “De rit is klaar, eindstand 45318”. You can also enter the distance for a whole trip in one go. Ask for business and private totals for this month, last month or this year.

The screen shows this month’s business kilometres. The app asks for confirmation before deleting the latest trip. Trips count towards the month they started, using Dutch time.

## For developers

This Python server app uses the broker’s small storage area for each installation. Bolle needs a connection to the platform. The app itself calls no outside service. See the requested rights in [app.yaml](app.yaml). Run `python3 -m unittest discover -s test` from this folder.
