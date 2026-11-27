# Reisgids

Ask “Wat is er hier te zien?” to hear about nearby landmarks. Swipe through the cards for names, short descriptions and the source. Ask about a place by name to hear its Wikipedia summary. You do not need a Wikipedia account.

## For developers

This Python server app uses approximate location for nearby results and reads Wikipedia through the platform’s approved network connection. See the permissions in [app.yaml](app.yaml). The tools are `in_de_buurt` for nearby places and `vertel_over` for a summary. Run `python3 -m unittest discover -s test` from this folder.
