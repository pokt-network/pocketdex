load('ext://dotenv', 'dotenv')
load('./tilt/Tiltfile', 'pocketdex')
load('./tilt/utils.Tiltfile', 'build_indexer_params_overwrite')
load(
  './tilt/cons.Tiltfile',
  'mainnet',
  'testnet_beta',
  'testnet_alpha',
  'localnet',
  'genesisPath',
  'defaultEmail',
  'defaultPassword',
  'pgadminEnabled',
  'onlyDb'
)

dotenv(fn=".env", verbose=True, showValues=False)

watch_file('.env')
secret_settings(disable_scrub = True)

# Default to mainnet since it is running longer than maybe alpha
# and requires less setup than localnet.
network = os.getenv('NETWORK', mainnet)
# Default to genesis.json at tilt folder
genesis_path = os.getenv('GENESIS_PATH', genesisPath)

only_db = os.getenv('ONLY_DB', onlyDb)
# default=<> only applies if the ENV variable is unset
pgadmin_enabled = os.getenv('PGADMIN_ENABLED', default=pgadminEnabled)
pgadmin_email = os.getenv('PGADMIN_EMAIL', defaultEmail)
pgadmin_password = os.getenv('PGADMIN_PASSWORD', defaultPassword)

indexer_params_overwrite = build_indexer_params_overwrite()

pocketdex(
  network=network,
  genesis_file_path=genesis_path,
  indexer_params_overwrite=indexer_params_overwrite,
  pgadmin_enabled=pgadmin_enabled == 'yes',
  pgadmin_email=pgadmin_email,
  pgadmin_password=pgadmin_password,
  apps_labels=['pocketdex'],
  tools_labels=['pocketdex-tools'],
  helm_repo_labels=['pocketdex-helm-repo'],
  only_db=only_db == 'yes'
)
