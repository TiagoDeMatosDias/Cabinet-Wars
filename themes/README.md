# Themes

Interface themes shared by the server. Each theme is a folder containing a `theme.json` (plus any
fonts or images it references); a map uses it with `"theme": "<folder name>"` in its `config.json`.

The default themes live here too: `imperial-china` (the canonical theme every other theme builds on)
and `prussian-baroque`. The game always loads themes from this folder; the client only keeps a copy
of `imperial-china` as a fallback for when the server can't be reached. Set `KRIEG_THEMES` to serve
themes from another folder. See [docs/design-system.md](../docs/design-system.md) for the format.
