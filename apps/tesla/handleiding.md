# Tesla

Met de app **Tesla** zie je op Bolle hoe vol je Tesla is, hoe ver je nog komt, of hij laadt en of hij op slot staat. Open de app op Bolle, zie de accu op je beginscherm, of vraag het: *"Hey Bolle, hoe vol is mijn Tesla?"*

## Zo werkt het

Je gebruikt je **eigen app bij Tesla**. Tesla vraagt dat van iedereen die de gegevens van een auto wil lezen. Die app maak je één keer aan, gratis. openBolle maakt het koppelen mogelijk, maar betaalt niets en ziet je wachtwoord nooit.

- **Kosten:** Tesla rekent per aanvraag, en je krijgt elke maand **$10 gratis tegoed** van Tesla. De app doet hooguit 3000 aanvragen per maand (ongeveer $6) en blijft dus binnen dat tegoed.
- **Zuinig:** Bolle kijkt hooguit eens per 20 minuten bij Tesla. Een slapende Tesla wordt **nooit vanzelf gewekt**. Bolle vraagt het eerst, want wakker maken kost een paar cent.
- **Privacy:** de app leest geen locatie. Je Client ID, je Secret en de toegang tot je auto worden versleuteld bewaard bij je Bolle. Verwijder je de app, dan wordt alles gewist.

Je hebt nodig: een Tesla-account met je auto erin, je telefoon en ongeveer een kwartier.

## Stap 1: je app bij Tesla

1. Ga naar [developer.tesla.com](https://developer.tesla.com) en log in met je Tesla-account. Kies **Fleet API-toepassing aanmaken**.
2. **Gegevens applicatie:** een naam, bijvoorbeeld *Bolle van Sam*, en bij het doel: *mijn eigen auto uitlezen op mijn Bolle*.
3. **Client-gegevens:**

   | Veld | Invullen |
   |---|---|
   | Type OAuth Grant | **Autorisatiecode en Machine-to-Machine** |
   | Toegestane oorsprongs-URL | `https://openbolle.nl` |
   | Toegestane doorlink-URI | `https://openbolle.nl/v1/oauth/tesla/terug` |
   | Toegestane retour-URL | leeg laten |

4. **API en toepassingsgebieden:** vink **Voertuiggegevens** aan. Meer is nu niet nodig.
5. **Factureringsgegevens:** dit is optioneel. Volgens Tesla werkt een app zonder betaalmethode mogelijk niet. Lukt het koppelen niet, voeg dan een betaalmethode toe en zet de limiet op **$10**. Dan betaal je niets zolang je binnen het gratis tegoed blijft.
6. Daarna zie je je **Client ID** en **Client Secret**. Houd dat scherm open.

Deel je Client Secret met niemand, ook niet in een chat of e-mail. Je vult hem alleen in op het formulier van stap 3.

## Stap 2: de app op Bolle

1. Op Bolle: **Menu → Apps → Nieuwe app → Tesla → Toestaan**.
2. Kies bij **Menu → Apps** de app Tesla en tik op **Koppelen**. Bolle toont een QR-code.
3. Scan die met je telefoon.

## Stap 3: koppelen op je telefoon

1. Je ziet het formulier van openBolle. Vul je **Client ID** en **Client Secret** in en tik op **Opslaan en inloggen bij Tesla**.
2. openBolle meldt je app aan bij Tesla. Dat is een eis van Tesla; daarvoor staat een publieke sleutel op de site van openBolle.
3. Je komt bij Tesla zelf. Log in en geef toestemming.
4. Klaar: *Tesla is gekoppeld aan je Bolle*. Binnen een paar minuten zie je je accu op Bolle.

## Wat je ziet

- **De app op Bolle:** de accu groot in het midden, bijvoorbeeld *78%*, met een rode ring langs de rand en het bereik eronder. Veeg naar het tweede scherm voor twee knoppen: **Ververs** kijkt nu bij Tesla, **Wekken** maakt een slapende auto wakker (dat kost een paar cent). De knoppen werken alleen als je stilstaat. Zet *Apps* in een vak van je beginscherm, of zeg *"Hey Bolle, open apps"*.
- **Op het beginscherm:** om de beurt met de temperatuur onder de klok, bijvoorbeeld *Tesla 78%*.
- **Meldingen:** Bolle meldt het als je Tesla **klaar is met laden**, of **niet op slot** staat terwijl er niemand in of bij de auto is. Omdat Bolle hooguit eens per 20 minuten bij Tesla kijkt, kan een melding wat later komen.
- **Vragen:** *"Hoe vol is mijn Tesla?"*, *"Laadt de auto nog?"*, *"Staat de Tesla op slot?"*
- **Slaapt je auto?** Dan zie je de laatst bekende stand, met de tijd erbij. Vraag Bolle om hem wakker te maken als je de stand van nu wilt.

Op slot doen, klimaat aanzetten en laden starten of stoppen komen later. Daarvoor moet je in je auto ook een sleutel van openBolle goedkeuren.

## Lukt het niet?

| Wat je ziet | Wat je doet |
|---|---|
| *De dienst accepteerde je app niet* | Controleer je Client ID en Secret, en of je app bij Tesla klaar en goedgekeurd is. Kijk ook naar stap 1.3 en 1.5. |
| *Tesla geeft geen toegang* | Je hebt bij het inloggen geen toestemming gegeven voor de gegevens van je auto. Koppel opnieuw. |
| *Koppeling verlopen* of *Tesla accepteert de koppeling niet meer* | Je hebt je wachtwoord veranderd, of de toegang is ingetrokken. Koppel opnieuw: **Menu → Apps → Tesla → Koppelen**. |
| *Ik vind geen Tesla bij dit account* | Je auto staat in een ander Tesla-account. Log in met het account waar de auto in staat. |
| *Deze maand zijn al 3000 aanvragen gedaan* | De app spaart je tegoed. Volgende maand werkt hij weer. |
