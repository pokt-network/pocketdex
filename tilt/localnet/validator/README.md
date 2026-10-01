# Localnet validator files — TEST KEYS, local kind only

Everything here runs the single Pocket Shannon validator that `NETWORK=localnet` brings up in the local cluster
(`tilt/localnet/Tiltfile`). `priv_validator_key.json` and `node_key.json` are **test keys**: never use them, or
this genesis, on any shared or public network.

Copied as-is from pocket-relay-miner `tilt/config/` at commit `a630b31` (genesis.json last changed there in `f5db2fd`):
`genesis.json` (chain id `pocket`), `config.toml` (static; relay-miner renders its block time, here it stays
`timeout_commit = "10s"`), `app.toml`, `client.toml`, `priv_validator_key.json`, `node_key.json`. The image is
`ghcr.io/pokt-network/pocketd:0.1.35` (tilt/localnet/Tiltfile).

## Refreshing for a new poktroll version

1. Update pocket-relay-miner's localnet to that version (or take its current `tilt/config/`).
2. Copy the six files above over these, and bump the `tag` default in `tilt/localnet/Tiltfile` to the same pocketd
   version the genesis was produced for.
3. Run `NETWORK=localnet tilt up` and check the validator produces blocks and the indexer indexes from genesis.
