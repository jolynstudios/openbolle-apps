# Homey

Ask Bolle to switch a light on, change the thermostat or start a favourite Homey flow. While parked, you can also use the controls on the screen. Security actions such as operating a garage door need confirmation. A Homey alarm can appear on Bolle after a delay. Keep using your normal home alarm system.

Install the app, choose **Koppelen** and scan the QR code. Sign in at Athom to grant access to your Homey Pro. Your password stays with Athom. See the [Dutch setup guide](handleiding.md).

## For developers

This example shows how to connect a service account. The manifest names the provider. The broker handles sign-in and renewal. During a call the app can request a short-lived access token and use it with the approved hosts. Test the screen and alerts locally with `python3 -m unittest discover -s test` in this folder.
