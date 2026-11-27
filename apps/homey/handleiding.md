# Homey

Bedien je **Homey Pro** met je stem vanuit de auto: lampen, stekkers, thermostaat, flows en sferen. Een slot, het
alarm of de garagedeur alleen na bevestiging, en nooit tijdens het rijden.

Vraag bijvoorbeeld: *"Doe de lampen in de woonkamer aan"*, *"Zet de verwarming op 20 graden"*,
*"Start de flow Bijna thuis"*, *"Is de voordeur op slot?"*

## Wat je ziet

- **De app op Bolle:** veeg door hooguit vier schermen. Staat de garagedeur open, dan vraagt Bolle eerst of hij dicht
  moet. Dan je favoriete apparaten uit de Homey-app (zonder favorieten: je lampen en stekkers), met een schakelaar om
  ze aan of uit te zetten. Dan je favoriete flows als knoppen (of je sferen). En de temperatuur in huis groot in het
  midden (zonder thermostaat: hoeveel lampen er aan zijn). Schakelen en knoppen werken alleen als je stilstaat.
- **Op het beginscherm:** om de beurt met de temperatuur onder de klok, bijvoorbeeld *Homey 20,5°*.
- **Alarm thuis:** gaat er een rookmelder, brandmelder, koolmonoxidemelder, hittemelder of watermelder af, dan meldt
  Bolle dat uit zichzelf. Dat kan een paar minuten duren; het is geen vervanging van een echt alarmsysteem.

## Koppelen

1. Installeer Homey op Bolle (Menu → Apps → Nieuwe app).
2. Kies Homey bij **Menu → Apps** en tik op **Koppelen**. Bolle toont een QR-code.
3. Scan die met je telefoon, log in met je Homey-account en geef toestemming.

Je wachtwoord gaat alleen naar Athom. openBolle bewaart alleen het token, versleuteld, en wist het als je de
app verwijdert. Intrekken kan ook in je Homey-account.

## Voor bouwers

Dit is de referentie-app voor OAuth: het manifest beschrijft de aanbieder (`oauth`), de broker doet het inloggen en
verversen, en de app haalt per aanroep een kortlevend token op (`GET /plugin/v1/oauth/token`). Internet alleen naar
`api.athom.com` en je eigen Homey (`*.homeypro.net`), via de uitgang van het platform.
