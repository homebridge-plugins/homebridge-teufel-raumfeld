# homebridge-raumfeld — install packet

Offline-installable tarball of the plugin. No npm-registry access needed.

- **File:** `homebridge-raumfeld-0.1.0.tgz`
- **SHA-256:** `27612fa210707afd3c6ff46cb4079c6ab66ba87f2a6e98d41fa38fba186e5c4c`
- Bundles the built `dist/`, `config.schema.json`, and the custom Config UI (`homebridge-ui/`). Runtime deps (`@homebridge/plugin-ui-utils`, `fast-xml-parser`, `node-ssdp`) are pulled automatically on install.

## Install on the Homebridge host

Copy the `.tgz` to the machine that runs Homebridge (e.g. `10.168.10.66`), then:

```bash
# global install (standard Homebridge)
sudo npm install -g ./homebridge-raumfeld-0.1.0.tgz
sudo hb-service restart
```

Homebridge Config UI X plugin dir install (if you don't use `-g`):
```bash
# from the Homebridge storage dir (the folder holding your config.json)
npm install ./homebridge-raumfeld-0.1.0.tgz
```

Docker: mount the tarball in and `npm install -g /path/homebridge-raumfeld-0.1.0.tgz` inside the container, then restart.

## Configure

Open the **Raumfeld** plugin card in Config UI X (custom settings screen) and set the host,
or edit `config.json` directly:

```json
"platforms": [
  {
    "platform": "Raumfeld",
    "name": "Raumfeld",
    "autoDiscover": false,
    "host": "10.168.11.40",
    "pollInterval": 5,
    "airplay":   { "enabled": true, "bufferMs": 220 },
    "multiroom": { "exposeGroups": true, "syncGroupVolume": true }
  }
]
```

- Homebridge and the speakers on **different subnets** → set `host` manually and leave
  `autoDiscover: false` (SSDP multicast can't cross subnets; the plugin resolves speakers via
  the host's `/listDevices` over HTTP, which does).
- Same subnet → `autoDiscover: true` also works.

Restart Homebridge. Your rooms appear as speaker tiles and active Raumfeld groups appear as a
single group accessory.

## Verify / rebuild the packet

```bash
sha256sum homebridge-raumfeld-0.1.0.tgz     # compare to the hash above
# rebuild from source:
cd ../scaffold && npm install && npm run build && npm pack
```
