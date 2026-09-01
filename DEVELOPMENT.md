# Development

## Test locally in Home Assistant

Copy the `bacnet2mqtt` directory to:

```text
/addons/bacnet2mqtt
```

Then reload the Home Assistant App Store.

## Version bump checklist

Update:

1. `bacnet2mqtt/config.yaml`
2. `bacnet2mqtt/package.json`
3. `bacnet2mqtt/src/constants.js`
4. bundled Schedule Card version when changed
5. `bacnet2mqtt/CHANGELOG.md`

## JavaScript syntax check

```bash
find bacnet2mqtt/src bacnet2mqtt/frontend bacnet2mqtt/web -name '*.js' -print0 \
  | xargs -0 -n1 node --check
```
