# homebridge-teufel-raumfeld — install packet

Offline-installable tarball of the plugin. No npm-registry access needed.

- **File:** `homebridge-teufel-raumfeld-0.4.1.tgz`
- **SHA-256:** `8090d7802d14ad14021bb58f6d0f9e06672691344788a34a06e07192e918d400`
- Bundles the built `dist/`, `config.schema.json`, and the custom Config UI (`homebridge-ui/`). Runtime deps (`@homebridge/plugin-ui-utils`, `fast-xml-parser`) are pulled automatically on install.

## Install on the Homebridge host

Copy the `.tgz` to the machine that runs Homebridge (e.g. `192.168.1.10`), then:

```bash
# global install (standard Homebridge)
sudo npm install -g ./homebridge-teufel-raumfeld-0.4.1.tgz
sudo hb-service restart
```

Homebridge Config UI X plugin dir install (if you don't use `-g`):
```bash
# from the Homebridge storage dir (the folder holding your config.json)
npm install ./homebridge-teufel-raumfeld-0.4.1.tgz
```

Docker: mount the tarball in and `npm install -g /path/homebridge-teufel-raumfeld-0.4.1.tgz` inside the container, then restart.

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
    "airplay":   { "enabled": true, "password": "choose-a-password" },
    "multiroom": { "exposeGroups": true, "syncGroupVolume": true }
  }
]
```

- Homebridge and the speakers on **different subnets** → either set `host` manually with
  `autoDiscover: false`, or keep `autoDiscover: true` and add `"discoverySubnet": "192.168.20.0/24"`
  (the speakers' CIDR). SSDP multicast can't cross subnets, so the plugin unicast-scans that
  range instead.
- Same subnet → `autoDiscover: true` works with no extra config.
- Set `airplay.password`. Without it every zone is advertised as an **open** AirPlay receiver and
  any device on the network can play audio through your speakers.

Restart Homebridge. Your rooms appear as tiles in the Home app (modeled as a Fan: on/off =
play/pause, slider = volume — the Home app won't render a third-party smart-speaker), and active
Raumfeld groups appear as a single group accessory.

## Verify / rebuild the packet

```bash
sha256sum homebridge-teufel-raumfeld-0.4.1.tgz     # compare to the hash above
# rebuild from source:
cd ../scaffold && npm install && npm run build && npm pack
```
