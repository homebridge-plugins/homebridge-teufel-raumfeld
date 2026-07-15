# homebridge-teufel-raumfeld — install packet

Offline-installable tarball of the plugin. No npm-registry access needed.

- **File:** `homebridge-teufel-raumfeld-0.1.1.tgz`
- **SHA-256:** `6ca78ee47bcfee82589194d5314cbf34fa9493710d88959a568b4e85defbcd14`
- Bundles the built `dist/`, `config.schema.json`, and the custom Config UI (`homebridge-ui/`). Runtime deps (`@homebridge/plugin-ui-utils`, `fast-xml-parser`, `node-ssdp`) are pulled automatically on install.

## Install on the Homebridge host

Copy the `.tgz` to the machine that runs Homebridge (e.g. `192.168.1.10`), then:

```bash
# global install (standard Homebridge)
sudo npm install -g ./homebridge-teufel-raumfeld-0.1.1.tgz
sudo hb-service restart
```

Homebridge Config UI X plugin dir install (if you don't use `-g`):
```bash
# from the Homebridge storage dir (the folder holding your config.json)
npm install ./homebridge-teufel-raumfeld-0.1.1.tgz
```

Docker: mount the tarball in and `npm install -g /path/homebridge-teufel-raumfeld-0.1.1.tgz` inside the container, then restart.

## Configure

Open the **Raumfeld** plugin card in Config UI X (custom settings screen) and set the host,
or edit `config.json` directly:

```json
"platforms": [
  {
    "platform": "Raumfeld",
    "name": "Raumfeld",
    "autoDiscover": false,
    "host": "192.168.1.50",
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
sha256sum homebridge-teufel-raumfeld-0.1.1.tgz     # compare to the hash above
# rebuild from source:
cd ../scaffold && npm install && npm run build && npm pack
```
